/**
 * The live socket's behaviour when the network misbehaves.
 *
 * A kitchen screen is left running for a whole service on shop wifi, so the
 * interesting cases are not "does it connect" but "what happens after it
 * stops" — and, just as importantly, that a screen which has been closed stops
 * dialling instead of reconnecting forever in the background.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onLiveEvent, RECONNECT_DELAY_MS, useLive } from './live-store.js';

/** The bits of WebSocket the store touches, plus a handle for the test. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Pretends the server sent a frame. */
  deliver(payload: string): void {
    this.onmessage?.({ data: payload });
  }
}

const latest = (): FakeSocket => FakeSocket.instances.at(-1) as FakeSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  useLive.setState({ connected: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connecting', () => {
  it('is not "connected" until the server says hello', () => {
    // An open TCP socket proves nothing: a proxy can hold one open and never
    // deliver a byte. The ready frame is the only proof the pipe works.
    const stop = useLive.getState().start();
    expect(useLive.getState().connected).toBe(false);

    latest().deliver('{"type":"ready"}');
    expect(useLive.getState().connected).toBe(true);

    stop();
  });

  it('hands events to whoever is listening', () => {
    const seen: string[] = [];
    const unsubscribe = onLiveEvent((event) => void seen.push(event.type));
    const stop = useLive.getState().start();

    latest().deliver('{"type":"ready"}');
    latest().deliver('{"type":"kitchen"}');

    // "ready" is connection state, not news — it must not reach the screens.
    expect(seen).toEqual(['kitchen']);

    unsubscribe();
    stop();
  });

  it('ignores a frame it cannot understand', () => {
    // This is an open pipe on shop wifi. A malformed frame must not be able to
    // disturb service.
    const seen: string[] = [];
    const unsubscribe = onLiveEvent((event) => void seen.push(event.type));
    const stop = useLive.getState().start();

    latest().deliver('not json at all');
    latest().deliver('{"type":"something-else"}');

    expect(seen).toEqual([]);
    unsubscribe();
    stop();
  });
});

describe('losing the connection', () => {
  it('reports the drop and dials again', () => {
    const stop = useLive.getState().start();
    latest().deliver('{"type":"ready"}');

    latest().close();
    expect(useLive.getState().connected).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(2);

    // And the new socket works like the first.
    latest().deliver('{"type":"ready"}');
    expect(useLive.getState().connected).toBe(true);

    stop();
  });

  it('keeps trying for as long as the screen is open', () => {
    const stop = useLive.getState().start();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      latest().close();
      vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    }

    expect(FakeSocket.instances).toHaveLength(4);
    stop();
  });

  it('stops dialling once the screen is gone', () => {
    // Otherwise every navigation away from the kitchen page would leave a
    // socket reconnecting behind it for the rest of the day.
    const stop = useLive.getState().start();
    latest().deliver('{"type":"ready"}');

    stop();

    expect(useLive.getState().connected).toBe(false);
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 5);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('does not schedule a reconnect for a socket it closed on purpose', () => {
    const stop = useLive.getState().start();
    stop();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 3);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
