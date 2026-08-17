/**
 * Route guards.
 *
 * The permission matrix lives in @pos/shared and is used by BOTH sides: the
 * PWA hides the button, the API refuses the request. That is not duplication —
 * the UI check is a courtesy so a cashier is not shown a button that will fail,
 * and this one is the actual security boundary. Never rely on the first.
 *
 * Two things a request has to survive here, not one:
 *
 *   1. the JWT verifies — it is signed by us and has not expired;
 *   2. the session row named by its `jti` is still alive.
 *
 * The second is what makes logout real. Without it a token copied off a device
 * keeps working until it lapses on its own, whatever the owner does — which is
 * survivable on a shop LAN and not survivable on the open internet.
 *
 * The token is read from a cookie by hand rather than through
 * `request.jwtVerify()`, because @fastify/jwt can be told about exactly one
 * cookie name and the two sites deliberately use two (see @pos/shared).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  can,
  OFFICE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type Permission,
  type SessionUser,
} from '@pos/shared';

/**
 * What our token carries.
 *
 * `jti` is not optional in practice — a token without one is refused below —
 * but it is optional in the type because that is what an unverified payload
 * can actually look like, and pretending otherwise would move the check from
 * the code into a cast.
 */
export type SessionPayload = SessionUser & { jti?: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser & { jti: string };
  }
}

const COOKIE_NAMES = [SESSION_COOKIE_NAME, OFFICE_SESSION_COOKIE_NAME] as const;

function readToken(request: FastifyRequest): string | null {
  for (const name of COOKIE_NAMES) {
    const value = request.cookies[name];
    if (value) return value;
  }
  return null;
}

async function refuse(reply: FastifyReply): Promise<void> {
  // Never echo the jwt library's reason — "jwt expired" vs "invalid signature"
  // tells an attacker which half of the problem to work on. A revoked session
  // answers identically for the same reason.
  await reply.status(401).send({
    error: 'UNAUTHORIZED',
    message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  });
}

/**
 * Verifies the cookie and the session row behind it, and populates
 * `request.user`. Returns false when it has already answered the request.
 */
async function resolveSession(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const token = readToken(request);
  if (!token) {
    await refuse(reply);
    return false;
  }

  let payload: SessionPayload;
  try {
    payload = request.server.jwt.verify<SessionPayload>(token);
  } catch {
    await refuse(reply);
    return false;
  }

  // A token with no jti predates plan 2. There is no session row to check, so
  // there is no way to end it — refuse rather than honour it.
  if (!payload.jti || !(await request.server.sessions.isLive(payload.jti))) {
    await refuse(reply);
    return false;
  }

  request.user = { ...payload, jti: payload.jti };
  return true;
}

/** 401s unless a valid, unrevoked session is present. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await resolveSession(request, reply);
}

/** 401 without a session, 403 with a session that lacks the permission. */
export function requirePermission(
  permission: Permission,
  what: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (!(await resolveSession(request, reply))) return;

    if (!can(request.user.role, permission)) {
      await reply.status(403).send({
        error: 'FORBIDDEN',
        message: `บัญชีนี้ไม่มีสิทธิ์${what}`,
      });
    }
  };
}
