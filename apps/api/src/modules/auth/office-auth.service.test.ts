/**
 * The back office door.
 *
 * Its own throwaway staff row, like the PIN lockout test and for the same
 * reason: this file deliberately fails logins ten times in a row, and doing
 * that to a seeded account would lock out whatever another test file is doing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { MAX_PASSWORD_ATTEMPTS, Role, StaffStatus } from '@pos/shared';
import { prisma } from '../../db.js';
import { hashPassword, OfficeAuthService } from './office-auth.service.js';

const EMAIL = 'office-login-test@test.local';
const PASSWORD = 'a-password-long-enough';

let service: OfficeAuthService;
let staffId: string;
let branchId: string;

beforeAll(async () => {
  service = new OfficeAuthService(prisma);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;

  const staff = await prisma.staff.create({
    data: {
      branchId,
      fullName: 'ทดสอบ หลังร้าน',
      nickname: 'ทดสอบ',
      role: Role.OWNER,
      pinHash: await bcrypt.hash('5150', 10),
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
    data: { failedLoginAttempts: 0, loginLockedUntil: null, status: StaffStatus.ACTIVE },
  });
});

afterAll(async () => {
  await prisma.staff.delete({ where: { id: staffId } });
  await prisma.$disconnect();
});

describe('a correct password', () => {
  it('returns the session user, with the branch taken from the row', async () => {
    const result = await service.login(EMAIL, PASSWORD);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.staffId).toBe(staffId);
    // The office login screen has no branch picker. This is where the branch
    // comes from, and it is why the email has to be unique table-wide.
    expect(result.user.branchId).toBe(branchId);
    expect(result.user.role).toBe(Role.OWNER);
  });

  it('clears the failure counter and stamps the login time', async () => {
    await prisma.staff.update({ where: { id: staffId }, data: { failedLoginAttempts: 4 } });

    await service.login(EMAIL, PASSWORD);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(after.failedLoginAttempts).toBe(0);
    expect(after.lastLoginAt).not.toBeNull();
  });

  it('does not touch the PIN lockout', async () => {
    // The two counters are separate on purpose: a bot guessing at the office
    // password must not be able to take a cashier off the till.
    const until = new Date(Date.now() + 60_000);
    await prisma.staff.update({
      where: { id: staffId },
      data: { failedPinAttempts: 3, pinLockedUntil: until },
    });

    await service.login(EMAIL, PASSWORD);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(after.failedPinAttempts).toBe(3);
    expect(after.pinLockedUntil?.getTime()).toBe(until.getTime());

    await prisma.staff.update({
      where: { id: staffId },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
  });
});

describe('a wrong password', () => {
  it('is refused', async () => {
    const result = await service.login(EMAIL, 'not-the-right-password');
    expect(result).toEqual({ ok: false, reason: 'BAD_CREDENTIALS' });
  });

  it('counts up', async () => {
    await service.login(EMAIL, 'not-the-right-password');
    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(after.failedLoginAttempts).toBe(1);
  });

  // Its own timeout, because this test is bcrypt cost 12 eleven times over —
  // roughly ten seconds of deliberate work, against vitest's 5s default. The
  // slowness is the feature being tested; shortening it would mean testing a
  // cheaper hash than the one that ships.
  it('freezes the account after enough of them, then refuses the right one too', async () => {
    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt += 1) {
      await service.login(EMAIL, 'not-the-right-password');
    }

    const result = await service.login(EMAIL, PASSWORD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('LOCKED');
  }, 60_000);
});

describe('an email that cannot log in', () => {
  it('answers the same for an unknown address as for a wrong password', async () => {
    // Anything else turns this endpoint into a way to find out which addresses
    // belong to the shop, which is the first half of the attack.
    const unknown = await service.login('nobody@test.local', PASSWORD);
    const wrong = await service.login(EMAIL, 'not-the-right-password');
    expect(unknown).toEqual(wrong);
  });

  it('answers the same for someone with no password set at all', async () => {
    // Every cashier is in this state. Knowing the shop's email pattern must
    // not reveal which addresses have office access and which do not.
    const cashier = await prisma.staff.create({
      data: {
        branchId,
        fullName: 'ทดสอบ ไม่มีรหัส',
        role: Role.STAFF,
        pinHash: await bcrypt.hash('5151', 10),
        startDate: new Date('2026-01-01T00:00:00Z'),
        email: 'no-password@test.local',
      },
    });

    const result = await service.login('no-password@test.local', PASSWORD);
    expect(result).toEqual({ ok: false, reason: 'BAD_CREDENTIALS' });

    await prisma.staff.delete({ where: { id: cashier.id } });
  });

  it('refuses someone who has left, whatever they remember', async () => {
    await prisma.staff.update({ where: { id: staffId }, data: { status: StaffStatus.LEFT } });
    const result = await service.login(EMAIL, PASSWORD);
    expect(result).toEqual({ ok: false, reason: 'BAD_CREDENTIALS' });
  });

  it('spends real time on an unknown address, so timing does not answer either', async () => {
    // Returning early on "no such email" makes the miss measurably faster than
    // the hit, and that difference is itself the enumeration oracle this is
    // meant to close.
    const started = Date.now();
    await service.login('definitely-nobody@test.local', PASSWORD);
    expect(Date.now() - started).toBeGreaterThan(50);
  });
});
