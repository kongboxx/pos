/**
 * The live feed the kitchen screen listens on.
 *
 * WHAT THIS IS NOT: a replacement for fetching. Events are signals — "the board
 * changed" — and whoever cares refetches. That is why losing the socket is a
 * degradation and not a failure: every screen that uses this also polls, so the
 * worst case of a dead socket is a few seconds of lag rather than a kitchen
 * standing in front of a frozen board wondering why no orders are coming.
 *
 * The socket is therefore allowed to be flaky, and it will be: shop wifi, a
 * router reboot, a tablet that slept. Reconnection is automatic and quiet, and
 * the only thing the UI shows is whether it is currently live.
 */

import { create } from 'zustand';
import { parseLiveEvent, type LiveEvent } from '@pos/shared';
import { liveSocketUrl } from './api-client.js';

/**
 * How long to wait before dialling again.
 *
 * Flat, not exponential, and short: the server is on the same LAN and the cost
 * of a failed connection is a TCP SYN. Backoff would mean a kitchen screen
 * staying dark for a minute after the router finished rebooting, which reads to
 * everyone in the room as "the system is broken".
 */
export const RECONNECT_DELAY_MS = 3000;

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();

/** Subscribes to live events. Returns the unsubscribe. */
export function onLiveEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(event: LiveEvent): void {
  for (const listener of listeners) listener(event);
}

interface LiveState {
  /** True only after the server's "ready" frame — see live.routes.ts. */
  connected: boolean;
  /** Opens the socket and keeps it open. Returns the teardown. */
  start: () => () => void;
}

export const useLive = create<LiveState>((set) => ({
  connected: false,

  start: () => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Set by the teardown so a reconnect scheduled a moment ago does not open a
    // socket after the component that wanted it is gone.
    let stopped = false;

    const open = (): void => {
      if (stopped) return;
      try {
        socket = new WebSocket(liveSocketUrl());
      } catch {
        // Bad URL or a browser that refuses the scheme. Try again later rather
        // than throwing during a render.
        schedule();
        return;
      }

      socket.onmessage = (message: MessageEvent<string>) => {
        const event = parseLiveEvent(String(message.data));
        // Junk is ignored, not logged loudly: this is an open pipe on shop wifi
        // and a malformed frame must not be able to disturb service.
        if (!event) return;
        if (event.type === 'ready') {
          set({ connected: true });
          return;
        }
        emit(event);
      };

      const drop = (): void => {
        set({ connected: false });
        socket = null;
        schedule();
      };
      socket.onclose = drop;
      socket.onerror = () => socket?.close();
    };

    const schedule = (): void => {
      if (stopped || retry !== null) return;
      retry = setTimeout(() => {
        retry = null;
        open();
      }, RECONNECT_DELAY_MS);
    };

    open();

    return () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      // Clear the handler first: closing on purpose must not schedule a
      // reconnect for a screen that has already gone away.
      if (socket) socket.onclose = null;
      socket?.close();
      socket = null;
      set({ connected: false });
    };
  },
}));
