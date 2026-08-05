/**
 * Shared setup for route tests.
 *
 * These are integration tests against the real dev database, not mocks. That
 * is a deliberate trade: money math, transactions, unique constraints and
 * document numbering are exactly the things a mocked Prisma client would let
 * through. The cost is that `pnpm db:up && pnpm db:seed:demo` must have run.
 *
 * THE DEMO SEED, not `pnpm db:seed`. The plain seed makes an empty shop — no
 * menu, no tables, one owner with a PIN nobody here knows — because that is
 * what a real shop wants on setup day. These tests need the noodle shop.
 *
 * Anything a test creates, the test deletes again (see `cleanupOrders`).
 */

import type { FastifyInstance } from 'fastify';
import { OrderStatus, type Role } from '@pos/shared';
import { buildApp } from './app.js';
import { prisma } from './db.js';
import { loadEnv } from './env.js';

export const TEST_AGENT_TOKEN = 'test-print-agent-token-value';

/** The PINs created by prisma/seed-demo.ts. Dev data only. */
export const SEED_PINS: Readonly<Record<Role, string>> = {
  OWNER: '1111',
  MANAGER: '2222',
  STAFF: '3333',
};

export async function buildTestApp(): Promise<FastifyInstance> {
  const env = loadEnv({
    DATABASE_URL:
      process.env['DATABASE_URL'] ?? 'postgresql://pos:pos_dev_password@localhost:5432/pos_dev',
    JWT_SECRET: 'test-jwt-secret-value-long-enough',
    PRINT_AGENT_TOKEN: TEST_AGENT_TOKEN,
    NODE_ENV: 'test',
  });
  const app = await buildApp(env);
  await app.ready();
  return app;
}

export interface TestSession {
  staffId: string;
  /** Ready to pass as `headers: { cookie }` on the next inject. */
  cookie: string;
}

/**
 * Logs in as the seeded staff member with the given role and returns the
 * session cookie.
 *
 * Clears any lockout left behind by a previous test first — otherwise one test
 * that deliberately types a bad PIN five times would fail every test after it.
 */
export async function loginAs(app: FastifyInstance, role: Role): Promise<TestSession> {
  // Oldest first, so this always finds the SEEDED account whose PIN is known —
  // never a throwaway row another test file created with a different PIN.
  const staff = await prisma.staff.findFirst({
    where: { role },
    orderBy: { createdAt: 'asc' },
  });
  // A database seeded with `pnpm db:seed` has one OWNER and no manager or
  // cashier, so the failure lands on whichever test file runs first with a
  // Prisma "no record found" and no hint about which command to run.
  if (!staff) {
    throw new Error(
      `no ${role} in the database — these tests need the demo shop: pnpm db:seed:demo`,
    );
  }
  await prisma.staff.update({
    where: { id: staff.id },
    data: { failedPinAttempts: 0, pinLockedUntil: null },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { staffId: staff.id, pin: SEED_PINS[role] },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login as ${role} failed: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('login did not set a session cookie');

  return { staffId: staff.id, cookie: raw.split(';')[0] as string };
}

/** Removes bills a test created, children first. */
export async function cleanupOrders(orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const ids = [...orderIds];
  const where = { orderId: { in: ids } };

  // Audit rows are keyed by the entity they describe, which for a voided or
  // edited line is the LINE id, not the bill id. Collected before anything is
  // deleted, or there is nothing left to look them up from.
  const lineIds = (await prisma.orderLine.findMany({ where, select: { id: true } })).map(
    (line) => line.id,
  );

  await prisma.creditNote.deleteMany({ where });
  await prisma.payment.deleteMany({ where });
  // Kitchen rows before bill lines: a ticket line REFERENCES a bill line and
  // Postgres refuses to delete the line while it does. That refusal is the
  // right behaviour in production — evidence should not vanish sideways — so
  // the test cleanup unwinds it explicitly instead of the schema cascading it.
  await prisma.ticketLine.deleteMany({ where: { ticket: where } });
  await prisma.kitchenTicket.deleteMany({ where });
  await prisma.voidLog.deleteMany({ where });
  await prisma.orderLineModifier.deleteMany({ where: { orderLine: where } });
  await prisma.orderLine.deleteMany({ where });
  await prisma.printJob.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...lineIds] } } });
  await prisma.order.deleteMany({ where: { id: { in: ids } } });

  // A bill opens a table SITTING, and deleting the bill leaves the sitting
  // behind. Nothing breaks, but the dev database slowly fills with tables that
  // are notionally occupied by nobody, and the next person to look at it has to
  // work out whether that means something. It does not, so tidy it away.
  await prisma.tableSession.updateMany({
    where: { closedAt: null, orders: { none: { status: OrderStatus.OPEN } } },
    data: { closedAt: new Date() },
  });
}
