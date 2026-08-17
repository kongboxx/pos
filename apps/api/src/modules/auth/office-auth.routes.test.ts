/**
 * The office endpoint, end to end.
 *
 * The service tests cover who may log in; these cover what the HTTP surface
 * gives away — the cookie, the shape of a refusal, and the audit trail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import {
  OFFICE_SESSION_COOKIE_NAME,
  OFFICE_SESSION_TTL_SECONDS,
  Role,
  SESSION_COOKIE_NAME,
  StaffStatus,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp } from '../../test-helpers.js';
import { hashPassword } from './office-auth.service.js';

const EMAIL = 'office-route-test@test.local';
const PASSWORD = 'a-password-long-enough';

let app: FastifyInstance;
let staffId: string;

beforeAll(async () => {
  app = await buildTestApp();
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  const staff = await prisma.staff.create({
    data: {
      branchId: branch.id,
      fullName: 'ทดสอบ เส้นทางหลังร้าน',
      role: Role.OWNER,
      pinHash: await bcrypt.hash('5152', 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: StaffStatus.ACTIVE,
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  staffId = staff.id;
});

beforeEach(async () => {
  await prisma.staff.update({
    where: { id: staffId },
    data: { failedLoginAttempts: 0, loginLockedUntil: null },
  });
  await prisma.auditLog.deleteMany({ where: { entityType: 'SESSION', entityId: staffId } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: 'SESSION', entityId: staffId } });
  await prisma.session.deleteMany({ where: { staffId } });
  await prisma.staff.delete({ where: { id: staffId } });
  await app.close();
  await prisma.$disconnect();
});

// `Record<string, unknown>` rather than `unknown`: fastify's `inject` is
// overloaded, and an `unknown` payload makes TypeScript pick the chainable
// form, whose return value has no `statusCode` and no `json()`. The tests run
// either way — this only shows up in typecheck.
function login(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/auth/office/login', payload });
}

describe('signing in to the back office', () => {
  it('sets the OFFICE cookie, not the till cookie', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD });
    expect(response.statusCode).toBe(200);

    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw.join(';') : (raw ?? '');
    expect(cookies).toContain(`${OFFICE_SESSION_COOKIE_NAME}=`);
    expect(cookies).toContain('HttpOnly');
    // Sharing a name with the till would mean logging into one signs you out
    // of the other in dev, where both are localhost and cookies ignore ports.
    expect(cookies).not.toContain(`${SESSION_COOKIE_NAME}=`);
    expect(response.body).not.toContain('eyJ');
  });

  it('creates an OFFICE session that lasts eight hours, not twelve', async () => {
    await login({ email: EMAIL, password: PASSWORD });

    const row = await prisma.session.findFirstOrThrow({
      where: { staffId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.surface).toBe('OFFICE');
    const life = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(Math.round(life / 1000)).toBe(OFFICE_SESSION_TTL_SECONDS);
  });

  it('answers with the permissions the role carries', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD });
    const body = response.json();
    expect(body.user.staffId).toBe(staffId);
    expect(body.permissions).toContain('VIEW_PAYROLL');
  });

  it('writes an audit row on the way in', async () => {
    await login({ email: EMAIL, password: PASSWORD });
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'SESSION', entityId: staffId, action: 'OFFICE_LOGIN' },
    });
    expect(rows.length).toBe(1);
    // The audit trail must never carry the credential itself.
    expect(JSON.stringify(rows[0])).not.toContain(PASSWORD);
  });

  it('writes an audit row on a failure too', async () => {
    await login({ email: EMAIL, password: 'not-the-right-password' });
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'SESSION', entityId: staffId, action: 'OFFICE_LOGIN_FAILED' },
    });
    expect(rows.length).toBe(1);
  });
});

describe('being refused', () => {
  it('401s with the same body for a wrong password and an unknown address', async () => {
    const wrong = await login({ email: EMAIL, password: 'not-the-right-password' });
    const unknown = await login({ email: 'nobody@test.local', password: PASSWORD });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    // Not "no such account", not "wrong password" — one message for both.
    expect(wrong.json().error).toBe('BAD_CREDENTIALS');
  });

  it('never says how many tries are left', async () => {
    // The PIN login tells a cashier who mistyped. Telling a bot is different.
    const response = await login({ email: EMAIL, password: 'not-the-right-password' });
    expect(response.json().attemptsLeft).toBeUndefined();
  });

  it('400s on a password too short to be one, before touching the database', async () => {
    const response = await login({ email: EMAIL, password: 'short' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('429s once the account is frozen, and says how long', async () => {
    await prisma.staff.update({
      where: { id: staffId },
      data: { loginLockedUntil: new Date(Date.now() + 10 * 60 * 1000) },
    });

    const response = await login({ email: EMAIL, password: PASSWORD });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('LOGIN_LOCKED');
    expect(response.json().lockedUntil).toBeTruthy();
  });

  it('sets no cookie when it refuses', async () => {
    const response = await login({ email: EMAIL, password: 'not-the-right-password' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
