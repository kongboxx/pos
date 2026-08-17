/**
 * Fastify application wiring.
 *
 * A single modular monolith, not microservices: one process, one deployment,
 * modules separated by folder under `src/modules/`. Step 0 registers only the
 * health module — auth, orders, KDS and the rest arrive in their own Steps.
 *
 * Kept separate from server.ts so tests can build an app without binding a port.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@pos/shared';
import { ZodError } from 'zod';
import { prisma } from './db.js';
import type { Env } from './env.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { SessionService } from './modules/auth/session.service.js';
import { registerBranchRoutes } from './modules/branch/branch.routes.js';
import { registerTaxDocRoutes } from './modules/docs/tax-doc.routes.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerKitchenRoutes } from './modules/kitchen/kitchen.routes.js';
import { registerMenuAdminRoutes } from './modules/menu/menu-admin.routes.js';
import { registerMenuRoutes } from './modules/menu/menu.routes.js';
import { registerOrderRoutes } from './modules/orders/order.routes.js';
import { registerPrintRoutes } from './modules/print/print.routes.js';
import { registerQrRoutes } from './modules/qr/qr.routes.js';
import { registerExpenseRoutes } from './modules/reports/expense.routes.js';
import { registerReportRoutes } from './modules/reports/report.routes.js';
import { registerShiftRoutes } from './modules/shifts/shift.routes.js';
import { registerPayrollRoutes } from './modules/staff/payroll.routes.js';
import { registerStaffRoutes } from './modules/staff/staff.routes.js';
import { registerTableAdminRoutes } from './modules/tables/table-admin.routes.js';
import { registerLiveRoutes } from './realtime/live.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared by the guards and both login routes. See session.service.ts. */
    sessions: SessionService;
  }
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : env.NODE_ENV === 'development'
          ? {
              level: 'info',
              transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
            }
          : { level: 'info' },
    // Tablets on shop wifi reconnect constantly; a generous body limit and
    // request id make the sync logs in Step 4 readable.
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    /**
     * ONE hop, or none. See TRUST_PROXY in env.ts for why `true` would be
     * worse than nothing: it makes request.ip the caller's own first
     * X-Forwarded-For entry, and a limiter keyed on a value the attacker
     * writes is not a limiter.
     */
    trustProxy: env.TRUST_PROXY ? 1 : false,
  });

  // Two PWAs on two different origins in dev, both holding their session in an
  // httpOnly cookie, so credentials must be allowed explicitly. `env.WEB_ORIGIN`
  // is a list — see env.ts for why one value was not enough.
  await app.register(cors, {
    origin: [...env.WEB_ORIGIN],
    credentials: true,
  });

  await app.register(cookie, {
    secret: env.JWT_SECRET,
    hook: 'onRequest',
  });

  // The session token is read from the httpOnly cookie, never from an
  // Authorization header. JS on the page cannot read the cookie, so an XSS on
  // the customer-facing QR page (Step 7, same origin) cannot lift a cashier's
  // session — which is the entire reason for putting it there.
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: { cookieName: SESSION_COOKIE_NAME, signed: false },
    sign: { expiresIn: SESSION_TTL_SECONDS },
  });

  // The kitchen screen's live feed (Step 5). Registered before the routes so
  // `{ websocket: true }` is a known option by the time /api/live is declared.
  //
  // The handshake carries the same session cookie as every other request, so
  // the socket is authenticated by the preHandler exactly like a GET — no
  // second token scheme, and no credential in a query string.
  await app.register(websocket);

  // One instance for the whole app: the guards read it on every request and
  // both login routes write through it. Keyed with the JWT secret because the
  // only thing it needs a secret for is the IP hash, and one secret to rotate
  // beats two.
  app.decorate('sessions', new SessionService(prisma, env.JWT_SECRET));

  // MUST be set before the route plugins are registered.
  //
  // `await app.register(...)` triggers Fastify's boot, and a handler attached
  // after boot never runs for the already-registered contexts — the symptom is
  // every validation error coming back as a 500 with a raw stack-ish body.
  // There is a route test covering exactly this.
  //
  // Fastify 5 hands the handler an `unknown`, so narrow it before use.
  app.setErrorHandler((error: unknown, request, reply) => {
    const { statusCode, code, message } = describeError(error);
    // Client mistakes are noise at error level; server faults are not.
    if (statusCode >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.info({ err: error }, 'request rejected');

    // 5xx details stay in the log — the tablet on the counter shows a generic
    // Thai message rather than a stack trace in front of a customer.
    void reply.status(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_ERROR' : code,
      message: statusCode >= 500 ? 'เกิดข้อผิดพลาดในระบบ' : message,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: 'NOT_FOUND',
      message: `ไม่พบเส้นทาง ${request.method} ${request.url}`,
    });
  });

  await app.register(registerHealthRoutes, { prefix: '/api' });
  await app.register(registerAuthRoutes, { prefix: '/api', env });
  await app.register(registerMenuRoutes, { prefix: '/api' });
  await app.register(registerMenuAdminRoutes, { prefix: '/api' });
  await app.register(registerOrderRoutes, { prefix: '/api' });
  await app.register(registerKitchenRoutes, { prefix: '/api' });
  await app.register(registerTableAdminRoutes, { prefix: '/api' });
  await app.register(registerExpenseRoutes, { prefix: '/api' });
  await app.register(registerReportRoutes, { prefix: '/api' });
  await app.register(registerShiftRoutes, { prefix: '/api' });
  await app.register(registerStaffRoutes, { prefix: '/api' });
  await app.register(registerPayrollRoutes, { prefix: '/api' });
  await app.register(registerBranchRoutes, { prefix: '/api' });
  await app.register(registerTaxDocRoutes, { prefix: '/api' });
  // The customer's phone (Step 7). The ONLY plugin here with no session behind
  // it — see qr.routes.ts for what stands in place of one.
  await app.register(registerQrRoutes, { prefix: '/api' });
  await app.register(registerPrintRoutes, { prefix: '/api', env });
  await app.register(registerLiveRoutes, { prefix: '/api' });

  return app;
}

interface ErrorDescription {
  statusCode: number;
  code: string;
  message: string;
}

/** Narrows an unknown thrown value into something safe to put in a response. */
function describeError(error: unknown): ErrorDescription {
  // A failed zod parse is the caller's fault, not the server's. Without this
  // every malformed request would be logged and reported as a 500.
  if (error instanceof ZodError) {
    const detail = error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join(', ');
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: detail };
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
    return {
      statusCode,
      code: typeof candidate.code === 'string' ? candidate.code : 'REQUEST_ERROR',
      message: typeof candidate.message === 'string' ? candidate.message : 'request failed',
    };
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'request failed' };
}
