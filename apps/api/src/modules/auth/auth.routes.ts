/**
 * Auth endpoints.
 *
 * The token goes into an httpOnly cookie and is never returned in the body.
 * That is the whole point: JavaScript on the page cannot read it, so an XSS on
 * the QR customer page (Step 7, same origin) cannot walk off with a cashier's
 * session.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  loginRequestSchema,
  officeLoginRequestSchema,
  OFFICE_SESSION_COOKIE_NAME,
  OFFICE_SESSION_TTL_SECONDS,
  ROLE_PERMISSIONS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  parsePromptPayId,
  uuidSchema,
  type MeResponse,
  type SessionUser,
} from '@pos/shared';
import type { SessionSurface } from '@prisma/client';
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
import { OfficeAuthService } from './office-auth.service.js';

const staffListQuerySchema = z.object({ branchId: uuidSchema.optional() });

/**
 * Signs a token for a fresh session row and puts it in the right cookie.
 *
 * Shared by both doors so the cookie flags cannot drift apart between them —
 * a `secure` that is set on one login and forgotten on the other is the kind
 * of difference nobody notices until a session is riding over plain http.
 */
async function issueSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  input: {
    user: SessionUser;
    surface: SessionSurface;
    ttlSeconds: number;
    isProduction: boolean;
    userAgent?: string | undefined;
    ip?: string | undefined;
  },
): Promise<void> {
  const session = await app.sessions.issue({
    branchId: input.user.branchId,
    staffId: input.user.staffId,
    surface: input.surface,
    ttlSeconds: input.ttlSeconds,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  // `jti`, not jsonwebtoken's `jwtid`: @fastify/jwt v9 signs with fast-jwt,
  // which takes the claim under its own name and silently ignores anything it
  // does not recognise. The wrong name costs nothing at sign time and 401s
  // every request afterwards.
  //
  // `expiresIn` is repeated here rather than inherited: passing any options to
  // `sign` REPLACES the plugin-level ones (jwt.js `mergeOptionsWithKey`), so a
  // token signed without it would never expire on its own. Seconds, because
  // @fastify/jwt converts a bare number to ms for fast-jwt on the way through.
  const token = app.jwt.sign(input.user, {
    expiresIn: input.ttlSeconds,
    jti: session.id,
  });

  const name = input.surface === 'OFFICE' ? OFFICE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;

  reply.setCookie(name, token, {
    httpOnly: true,
    // The tablet talks to the API over plain http on the shop LAN, so a Secure
    // cookie would simply never be sent. It goes on in production.
    secure: input.isProduction,
    // Lax, not None: each site and the API are same-site in production. None
    // would require Secure and would open the cookie up to cross-site POSTs.
    sameSite: 'lax',
    path: '/',
    maxAge: input.ttlSeconds,
  });
}

export function registerAuthRoutes(app: FastifyInstance, options: { env: Env }): void {
  const service = new AuthService(prisma);
  const officeService = new OfficeAuthService(prisma);
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

    await issueSessionCookie(app, reply, {
      user: result.user,
      surface: 'POS',
      ttlSeconds: SESSION_TTL_SECONDS,
      isProduction,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    return reply.send({ user: result.user, permissions: ROLE_PERMISSIONS[result.user.role] });
  });

  /**
   * The back office door.
   *
   * A separate endpoint from the till's, not one endpoint that works out which
   * kind of credential it was handed. Two reasons, and both matter: `surface`
   * comes from the path that was called rather than from a header the caller
   * chose, and the two doors can be rate-limited on different terms without
   * one policy having to serve a tablet in a shop and a laptop on the internet.
   */
  app.post('/auth/office/login', async (request, reply) => {
    const body = officeLoginRequestSchema.parse(request.body ?? {});
    const result = await officeService.login(body.email, body.password);

    if (!result.ok) {
      if (result.reason === 'LOCKED') {
        const seconds = Math.max(1, Math.ceil((result.lockedUntil.getTime() - Date.now()) / 1000));
        await writeLoginAudit(
          result.branchId,
          result.staffId,
          'OFFICE_LOGIN_FAILED',
          'บัญชีถูกล็อก',
        );
        return reply.status(429).send({
          error: 'LOGIN_LOCKED',
          message: `ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกล็อก กรุณารออีก ${Math.ceil(seconds / 60)} นาที`,
          lockedUntil: result.lockedUntil.toISOString(),
        });
      }

      /**
       * A failure against an address we DO know gets an audit row; one against
       * an address we do not cannot have one, because AuditLog is keyed by
       * branch and there is no branch to key it to. That asymmetry is a fact
       * about the schema, not an oversight — the unknown-address case goes to
       * the request log instead, where it is still visible without inventing a
       * branch to file it under.
       */
      const known = await prisma.staff.findUnique({
        where: { email: body.email },
        select: { id: true, branchId: true },
      });
      if (known) {
        await writeLoginAudit(
          known.branchId,
          known.id,
          'OFFICE_LOGIN_FAILED',
          'รหัสผ่านไม่ถูกต้อง',
        );
      } else {
        request.log.info({ email: body.email }, 'office login for an unknown address');
      }

      return reply.status(401).send({
        error: 'BAD_CREDENTIALS',
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
      });
    }

    await issueSessionCookie(app, reply, {
      user: result.user,
      surface: 'OFFICE',
      ttlSeconds: OFFICE_SESSION_TTL_SECONDS,
      isProduction,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    await writeLoginAudit(result.user.branchId, result.user.staffId, 'OFFICE_LOGIN', null);

    return reply.send({ user: result.user, permissions: ROLE_PERMISSIONS[result.user.role] });
  });

  /**
   * Ends the session, on the server and in the browser.
   *
   * `requireAuth` rather than open: logging out has to know WHICH session to
   * kill, and the only trustworthy answer is the one in the token. An open
   * endpoint could clear a cookie but never revoke a row.
   *
   * Both cookies are cleared regardless of which one arrived. They are on
   * different hosts in production so only one can be present, and clearing a
   * cookie that was not there costs nothing — while leaving one behind after a
   * dev session that hopped between :5173 and :5174 costs an hour of confusion.
   */
  app.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    await app.sessions.revoke(request.user.jti);

    return reply
      .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
      .clearCookie(OFFICE_SESSION_COOKIE_NAME, { path: '/' })
      .send({ ok: true });
  });

  /**
   * Sign out of every device.
   *
   * The button for "I left my phone in a taxi", and the only honest answer to
   * it. Includes the session making the request — a version that spared the
   * caller would leave exactly one device signed in, which is the one case
   * where the person cannot check.
   *
   * No permission gate: this only ever ends the caller's own sessions, and
   * needing a permission to lock your own account is a rule that fires on the
   * day it is least welcome.
   */
  app.post('/auth/sessions/revoke-all', { preHandler: requireAuth }, async (request, reply) => {
    const revoked = await app.sessions.revokeAllFor(request.user.staffId);

    return reply
      .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
      .clearCookie(OFFICE_SESSION_COOKIE_NAME, { path: '/' })
      .send({ ok: true, revoked });
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

/**
 * One audit row per office login attempt, successful or not.
 *
 * `entityId` is the staff id rather than a session id: the question this gets
 * asked for is "who has been trying to get into my reports", and that has to
 * be answerable for the attempts that never produced a session.
 *
 * Never carries the password, and never carries the token.
 */
async function writeLoginAudit(
  branchId: string,
  staffId: string,
  action: 'OFFICE_LOGIN' | 'OFFICE_LOGIN_FAILED',
  reason: string | null,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      branchId,
      staffId,
      action,
      entityType: 'SESSION',
      entityId: staffId,
      reason,
    },
  });
}
