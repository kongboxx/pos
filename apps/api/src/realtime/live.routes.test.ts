/**
 * The live socket, end to end through Fastify.
 *
 * Two questions only, and both are about the handshake rather than the stream:
 * does the session cookie actually authenticate an upgrade, and does a socket
 * that got through receive what the hub broadcasts to its branch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Role } from '@pos/shared';
import { prisma } from '../db.js';
import { buildTestApp, loginAs } from '../test-helpers.js';
import { liveHub } from './hub.js';

let app: FastifyInstance;
let cookie: string;
let branchId: string;

/**
 * The socket `injectWS` hands back.
 *
 * Taken from Fastify's own signature rather than by importing `ws` directly:
 * the API depends on the websocket plugin, not on ws, and adding a dependency
 * so that one test file can name a type would be the tail wagging the dog.
 */
type TestSocket = Awaited<ReturnType<FastifyInstance['injectWS']>>;

/**
 * Opens a socket and captures frames from the very first one.
 *
 * The listener is attached in `onInit`, before the handshake completes, because
 * the server greets a new socket the instant the handler runs — a listener
 * added after `await` races that frame and loses about half the time.
 */
async function openSocket(
  headers?: Record<string, string>,
): Promise<{ socket: TestSocket; messages: string[] }> {
  const messages: string[] = [];
  const socket = await app.injectWS('/api/live', headers ? { headers } : {}, {
    onInit: (ws) => ws.on('message', (data: Buffer) => void messages.push(data.toString())),
  });
  return { socket, messages };
}

/** Waits until `check` passes, or gives up. Frames arrive on the event loop. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

beforeAll(async () => {
  app = await buildTestApp();
  cookie = (await loginAs(app, Role.STAFF)).cookie;
  // Oldest active branch — the one the session resolves to. Unordered, this
  // could pick up a throwaway branch created by a test file running in
  // parallel, and the socket would then be listening to the wrong shop.
  branchId = (
    await prisma.branch.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    })
  ).id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /api/live', () => {
  it('greets an authenticated socket and then relays its branch traffic', async () => {
    const { socket, messages } = await openSocket({ cookie });

    // "ready" is what lets the client stop polling: without it a browser cannot
    // tell a working socket from one held open by a proxy that never delivers.
    expect(await until(() => messages.length >= 1)).toBe(true);
    expect(messages[0]).toBe('{"type":"ready"}');

    expect(liveHub.broadcast(branchId, { type: 'kitchen' })).toBeGreaterThan(0);
    expect(await until(() => messages.length >= 2)).toBe(true);
    expect(messages[1]).toBe('{"type":"kitchen"}');

    socket.terminate();
  });

  it('refuses to upgrade without a session', async () => {
    // The socket carries kitchen traffic for a whole branch. Anyone on the shop
    // wifi can reach the port; the cookie is the only thing that says who they
    // are, and it is checked BEFORE the upgrade rather than after.
    const before = liveHub.countFor(branchId);
    let greeted = false;

    try {
      const { socket, messages } = await openSocket();
      await until(() => messages.length > 0, 300);
      greeted = messages.length > 0;
      socket.terminate();
    } catch {
      // Rejecting the upgrade outright is the other acceptable outcome.
    }

    expect(greeted).toBe(false);
    // Not equality: the socket from the previous test is still unwinding its
    // close, so the count may legitimately have gone DOWN. What must never
    // happen is a new listener appearing.
    expect(liveHub.countFor(branchId)).toBeLessThanOrEqual(before);
  });
});
