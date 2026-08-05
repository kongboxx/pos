/**
 * `GET /api/live` — the WebSocket the kitchen screen and the tills listen on.
 *
 * AUTHENTICATION IS THE SAME SESSION COOKIE as every other route, verified in
 * the preHandler BEFORE the connection is upgraded. A browser attaches cookies
 * to a WebSocket handshake, so nothing extra has to be invented — and nothing
 * extra should be, because the alternative (a token in the query string) writes
 * a credential into every access log and proxy on the way.
 *
 * The socket is READ-ONLY by design. Nothing a client sends is acted on: every
 * change still goes through the normal HTTP routes, where the permission guards
 * live. A socket that accepted commands would be a second, unguarded API.
 */

import type { FastifyInstance } from 'fastify';
import type { LiveEvent } from '@pos/shared';
import { requireAuth } from '../modules/auth/guards.js';
import { liveHub } from './hub.js';

/**
 * How often the server pokes each socket.
 *
 * A tablet that loses wifi does not close its connection — the TCP session just
 * stops answering, and without this the server would hold a dead socket open
 * for hours and count it as a live kitchen screen. The ping is what turns
 * "gone" into a close event.
 */
export const PING_INTERVAL_MS = 30_000;

export function registerLiveRoutes(app: FastifyInstance): void {
  app.get('/live', { websocket: true, preHandler: requireAuth }, (socket, request) => {
    // The room comes from the SIGNED token, never from a query parameter.
    const branchId = request.user.branchId;
    const leave = liveHub.join(branchId, socket);

    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        // Missed a whole round trip: stop pretending this screen is watching.
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, PING_INTERVAL_MS);

    const close = (): void => {
      clearInterval(heartbeat);
      leave();
    };
    socket.on('close', close);
    socket.on('error', close);

    // Tells the client the pipe really works, so it can stop polling. Without
    // it a browser cannot tell "connected" from "connected to a proxy that will
    // never deliver anything".
    const ready: LiveEvent = { type: 'ready' };
    socket.send(JSON.stringify(ready));
  });
}
