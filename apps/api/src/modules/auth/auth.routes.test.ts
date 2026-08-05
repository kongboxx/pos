/**
 * Login, sessions and the permission gate.
 *
 * The lockout test uses its OWN throwaway staff row rather than a seeded one.
 * Vitest runs test files in parallel, and deliberately failing five logins
 * against a shared account would lock out whatever another file is doing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { MAX_PIN_ATTEMPTS, Permission, Role, SESSION_COOKIE_NAME } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, loginAs, SEED_PINS } from '../../test-helpers.js';

let app: FastifyInstance;
let lockoutStaffId: string;

const LOCKOUT_PIN = '9876';

beforeAll(async () => {
  app = await buildTestApp();

  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  const staff = await prisma.staff.create({
    data: {
      branchId: branch.id,
      fullName: 'ทดสอบ ล็อกเอาต์',
      nickname: 'ทดสอบ',
      role: Role.STAFF,
      pinHash: await bcrypt.hash(LOCKOUT_PIN, 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  lockoutStaffId = staff.id;
});

afterAll(async () => {
  await prisma.staff.delete({ where: { id: lockoutStaffId } });
  await app.close();
  await prisma.$disconnect();
});

describe('the login screen', () => {
  it('lists staff without a session and without leaking anything secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/staff' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.staff.length).toBeGreaterThan(0);
    for (const person of body.staff) {
      expect(Object.keys(person).sort()).toEqual(['fullName', 'id', 'nickname', 'role']);
    }
    // The whole response, stringified, must not contain a bcrypt hash.
    expect(response.body).not.toMatch(/\$2[aby]\$/);
  });
});

describe('logging in', () => {
  it('sets an httpOnly session cookie and never returns the token in the body', async () => {
    const staff = await prisma.staff.findFirstOrThrow({ where: { role: Role.OWNER } });
    await prisma.staff.update({
      where: { id: staff.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { staffId: staff.id, pin: SEED_PINS.OWNER },
    });

    expect(response.statusCode).toBe(200);

    const raw = response.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw[0] : raw;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    // A token in the body would be readable by JS and defeat the httpOnly cookie.
    expect(response.body).not.toContain('eyJ');
  });

  it('rejects a wrong PIN and says how many tries are left', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { staffId: lockoutStaffId, pin: '0000' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('BAD_CREDENTIALS');
    expect(response.json().attemptsLeft).toBe(MAX_PIN_ATTEMPTS - 1);
  });

  it('rejects a PIN that is not four digits before it reaches the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { staffId: lockoutStaffId, pin: '12' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('locks the account after repeated wrong PINs, then refuses even the right one', async () => {
    await prisma.staff.update({
      where: { id: lockoutStaffId },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });

    let last = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS; attempt += 1) {
      last = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { staffId: lockoutStaffId, pin: '0000' },
      });
    }

    expect(last.statusCode).toBe(429);
    expect(last.json().error).toBe('PIN_LOCKED');

    // The lock is what makes a 4-digit secret defensible: knowing the PIN is
    // not enough while the account is frozen.
    const withCorrectPin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { staffId: lockoutStaffId, pin: LOCKOUT_PIN },
    });
    expect(withCorrectPin.statusCode).toBe(429);

    await prisma.staff.update({
      where: { id: lockoutStaffId },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
  });

  it('clears the failure counter on a successful login', async () => {
    await prisma.staff.update({
      where: { id: lockoutStaffId },
      data: { failedPinAttempts: 3, pinLockedUntil: null },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { staffId: lockoutStaffId, pin: LOCKOUT_PIN },
    });
    expect(response.statusCode).toBe(200);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id: lockoutStaffId } });
    expect(after.failedPinAttempts).toBe(0);
    expect(after.lastLoginAt).not.toBeNull();
  });
});

describe('/auth/me', () => {
  it('401s without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the branch and the role`s permission set', async () => {
    const { cookie } = await loginAs(app, Role.STAFF);
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.role).toBe(Role.STAFF);
    expect(body.permissions).toContain(Permission.TAKE_ORDER);
    // The rule the whole cost-stripping design rests on.
    expect(body.permissions).not.toContain(Permission.VIEW_COST);
    expect(body.branch.promptPayConfigured).toBe(true);
  });

  /**
   * Logging out clears the cookie, which is how the browser stops sending it.
   *
   * Known limitation, stated plainly: the JWT itself stays valid until it
   * expires, so a token captured BEFORE logout would still be accepted. On a
   * shop LAN over plain http that is a real (if small) gap, and the fix is
   * https plus server-side revocation — deployment work, not Step 2 work.
   */
  it('clears the session cookie on logout', async () => {
    const { cookie } = await loginAs(app, Role.MANAGER);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    const cleared = Array.isArray(raw) ? raw.join(';') : (raw ?? '');
    expect(cleared).toContain(SESSION_COOKIE_NAME);
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});
