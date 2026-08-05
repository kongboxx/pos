/**
 * Auth endpoints.
 *
 * The token goes into an httpOnly cookie and is never returned in the body.
 * That is the whole point: JavaScript on the page cannot read it, so an XSS on
 * the QR customer page (Step 7, same origin) cannot walk off with a cashier's
 * session.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginRequestSchema,
  ROLE_PERMISSIONS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  parsePromptPayId,
  uuidSchema,
  type MeResponse,
} from '@pos/shared';
import {
  listLoginBranches,
  resolveLoginBranch,
  resolveLoginBranchForStaff,
  requireSessionBranch,
} from '../../branch.js';
import { prisma } from '../../db.js';
import type { Env } from '../../env.js';
import { formatDateColumn } from '../orders/order.mapper.js';
import { requireAuth } from './guards.js';
import { AuthService } from './auth.service.js';

const staffListQuerySchema = z.object({ branchId: uuidSchema.optional() });

export function registerAuthRoutes(app: FastifyInstance, options: { env: Env }): void {
  const service = new AuthService(prisma);
  const isProduction = options.env.NODE_ENV === 'production';

  /**
   * The shops on the login screen (Step 10).
   *
   * Open, like the staff list below it, and for the same reason: it is a list
   * of shop names on a device that is already inside the shop's wifi. It is
   * also the only pre-session endpoint that knows about more than one branch —
   * everything after login is scoped by the token.
   */
  app.get('/auth/branches', async (_request, reply) => {
    const branches = await listLoginBranches(prisma);
    return reply.send({ branches });
  });

  /** Names for the login screen. Deliberately open — it holds no secret. */
  app.get('/auth/staff', async (request, reply) => {
    const query = staffListQuerySchema.parse(request.query ?? {});
    const branch = await resolveLoginBranch(prisma, query.branchId);
    const staff = await service.listStaff(branch.id);
    return reply.send({
      branch: { id: branch.id, name: branch.name, branchCode: branch.branchCode },
      staff,
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginRequestSchema.parse(request.body ?? {});
    const branch = body.branchId
      ? await resolveLoginBranch(prisma, body.branchId)
      : await resolveLoginBranchForStaff(prisma, body.staffId);

    const result = await service.login(branch.id, body.staffId, body.pin);

    if (!result.ok) {
      if (result.reason === 'LOCKED') {
        const seconds = Math.max(1, Math.ceil((result.lockedUntil.getTime() - Date.now()) / 1000));
        return reply.status(429).send({
          error: 'PIN_LOCKED',
          message: `ใส่ PIN ผิดหลายครั้ง บัญชีถูกล็อก กรุณารออีก ${Math.ceil(seconds / 60)} นาที`,
          lockedUntil: result.lockedUntil.toISOString(),
        });
      }
      // A wrong PIN and an unknown staff id give the same 401 shape so the
      // endpoint cannot be used to enumerate accounts.
      return reply.status(401).send({
        error: 'BAD_CREDENTIALS',
        message: 'PIN ไม่ถูกต้อง',
        attemptsLeft: result.reason === 'BAD_PIN' ? result.attemptsLeft : undefined,
      });
    }

    const token = app.jwt.sign(result.user, { expiresIn: SESSION_TTL_SECONDS });

    return reply
      .setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        // The tablet talks to the API over plain http on the shop LAN, so a
        // Secure cookie would simply never be sent. It goes on in production.
        secure: isProduction,
        // Lax, not None: the PWA and the API are same-site in production. None
        // would require Secure and would open the cookie up to cross-site POSTs.
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_SECONDS,
      })
      .send({ user: result.user, permissions: ROLE_PERMISSIONS[result.user.role] });
  });

  app.post('/auth/logout', async (_request, reply) => {
    return reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' }).send({ ok: true });
  });

  /**
   * Who am I. The PWA calls this on every boot instead of remembering the
   * session itself — storing it would mean writing identity to disk, and the
   * only copy of a session belongs in the httpOnly cookie.
   */
  app.get('/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const body: MeResponse = {
      user: request.user,
      permissions: [...ROLE_PERMISSIONS[request.user.role]],
      branch: {
        id: branch.id,
        name: branch.name,
        branchCode: branch.branchCode,
        businessType: branch.businessType,
        vatEnabled: branch.vatEnabled,
        vatRateBp: branch.vatRateBp,
        priceIncludesVat: branch.priceIncludesVat,
        vatEffectiveDate: branch.vatEffectiveDate
          ? formatDateColumn(branch.vatEffectiveDate)
          : null,
        timezone: branch.timezone,
        dayCutoffHour: branch.dayCutoffHour,
        // Only whether it is usable — the id itself is not needed by the till
        // and there is no reason to hand it to every screen.
        promptPayConfigured: branch.promptPayId
          ? parsePromptPayId(branch.promptPayId) !== null
          : false,
      },
    };
    return reply.send(body);
  });
}
