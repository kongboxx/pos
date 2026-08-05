/**
 * Route guards.
 *
 * The permission matrix lives in @pos/shared and is used by BOTH sides: the
 * PWA hides the button, the API refuses the request. That is not duplication —
 * the UI check is a courtesy so a cashier is not shown a button that will fail,
 * and this one is the actual security boundary. Never rely on the first.
 *
 * The session comes from the JWT in an httpOnly cookie, so branchId and role
 * are read from a signed token rather than from anything the tablet can edit.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Permission, type SessionUser } from '@pos/shared';

// Tells @fastify/jwt (and therefore `request.user`) what our token carries.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser;
  }
}

/** 401s unless a valid session cookie is present. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    // Never echo the jwt library's reason — "jwt expired" vs "invalid
    // signature" tells an attacker which half of the problem to work on.
    await reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
    });
  }
}

/** 401 without a session, 403 with a session that lacks the permission. */
export function requirePermission(
  permission: Permission,
  what: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
      });
      return;
    }

    if (!can(request.user.role, permission)) {
      await reply.status(403).send({
        error: 'FORBIDDEN',
        message: `บัญชีนี้ไม่มีสิทธิ์${what}`,
      });
    }
  };
}
