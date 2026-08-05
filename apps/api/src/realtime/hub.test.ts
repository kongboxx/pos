/**
 * Who gets told what.
 *
 * The hub is small, and the things that would hurt if it were wrong are all
 * about isolation and resilience: one branch must never hear another's traffic,
 * and one dead screen must never silence the rest.
 */

import { describe, expect, it, vi } from 'vitest';
import { LiveHub, type LiveSocket } from './hub.js';

const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

function fakeSocket(): LiveSocket & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (data: string) => void sent.push(data) };
}

describe('broadcasting', () => {
  it('reaches every socket in the branch', () => {
    const hub = new LiveHub();
    const till = fakeSocket();
    const kitchen = fakeSocket();
    hub.join(BRANCH_A, till);
    hub.join(BRANCH_A, kitchen);

    expect(hub.broadcast(BRANCH_A, { type: 'kitchen' })).toBe(2);
    expect(till.sent).toEqual(['{"type":"kitchen"}']);
    expect(kitchen.sent).toEqual(['{"type":"kitchen"}']);
  });

  it('never crosses branches', () => {
    // Step 10 puts several shops on this code. A kitchen screen in one shop
    // hearing another shop's orders is not a glitch, it is a data leak.
    const hub = new LiveHub();
    const here = fakeSocket();
    const elsewhere = fakeSocket();
    hub.join(BRANCH_A, here);
    hub.join(BRANCH_B, elsewhere);

    hub.broadcast(BRANCH_A, { type: 'kitchen' });

    expect(here.sent).toHaveLength(1);
    expect(elsewhere.sent).toHaveLength(0);
  });

  it('says nothing to a branch with nobody listening', () => {
    expect(new LiveHub().broadcast(BRANCH_A, { type: 'kitchen' })).toBe(0);
  });

  it('keeps going when one socket throws', () => {
    // A tablet whose wifi died half a second ago is a broken pipe. It must not
    // be able to stop the counter from being told the board changed.
    const hub = new LiveHub();
    const broken: LiveSocket = {
      send: () => {
        throw new Error('EPIPE');
      },
    };
    const working = fakeSocket();
    hub.join(BRANCH_A, broken);
    hub.join(BRANCH_A, working);

    expect(hub.broadcast(BRANCH_A, { type: 'kitchen' })).toBe(1);
    expect(working.sent).toHaveLength(1);
  });

  it('skips a socket that is not open', () => {
    const hub = new LiveHub();
    const closing: LiveSocket & { sent: string[] } = { ...fakeSocket(), readyState: 2 };
    const send = vi.fn();
    hub.join(BRANCH_A, { send, readyState: 2 });
    hub.join(BRANCH_A, closing);

    expect(hub.broadcast(BRANCH_A, { type: 'kitchen' })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('leaving', () => {
  it('stops delivering once a socket has left', () => {
    const hub = new LiveHub();
    const socket = fakeSocket();
    const leave = hub.join(BRANCH_A, socket);

    leave();

    expect(hub.countFor(BRANCH_A)).toBe(0);
    expect(hub.broadcast(BRANCH_A, { type: 'kitchen' })).toBe(0);
  });

  it('is safe to call twice', () => {
    // close and error can both fire for the same socket.
    const hub = new LiveHub();
    const leave = hub.join(BRANCH_A, fakeSocket());
    leave();
    expect(() => leave()).not.toThrow();
  });

  it('does not disturb the others when one leaves', () => {
    const hub = new LiveHub();
    const staying = fakeSocket();
    hub.join(BRANCH_A, staying);
    const leave = hub.join(BRANCH_A, fakeSocket());

    leave();

    expect(hub.countFor(BRANCH_A)).toBe(1);
    expect(hub.broadcast(BRANCH_A, { type: 'order', orderId: 'x' })).toBe(1);
  });
});
