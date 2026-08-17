/**
 * The two database guarantees the office login rests on.
 *
 * Both are the kind of rule that is easy to write in schema.prisma and easy to
 * lose in a hand-edited migration, and both fail silently if lost: duplicate
 * emails make "which row does this email mean" ambiguous, and a session that
 * survives its staff row is a session pointing at nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { Role } from '@pos/shared';
import { prisma } from '../../db.js';

let branchId: string;
const created: string[] = [];

beforeAll(async () => {
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;
});

afterAll(async () => {
  await prisma.staff.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

async function makeStaff(email: string | null): Promise<string> {
  const staff = await prisma.staff.create({
    data: {
      branchId,
      fullName: `ทดสอบ อีเมล ${created.length}`,
      role: Role.STAFF,
      pinHash: await bcrypt.hash(String(1000 + created.length), 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
      email,
    },
  });
  created.push(staff.id);
  return staff.id;
}

describe('the email column', () => {
  it('refuses a second row with the same email', async () => {
    await makeStaff('duplicate@test.local');
    await expect(makeStaff('duplicate@test.local')).rejects.toThrow();
  });

  it('allows many rows with no email at all', async () => {
    // Every cashier is one of these. A unique constraint that treated NULLs as
    // equal would mean the shop could only ever have one person without an
    // office account.
    await makeStaff(null);
    await expect(makeStaff(null)).resolves.toBeTruthy();
  });
});

describe('the sessions table', () => {
  it('deletes a session when its staff row goes', async () => {
    const staffId = await makeStaff('cascade@test.local');
    await prisma.session.create({
      data: {
        branchId,
        staffId,
        surface: 'OFFICE',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.staff.delete({ where: { id: staffId } });
    created.splice(created.indexOf(staffId), 1);

    expect(await prisma.session.count({ where: { staffId } })).toBe(0);
  });
});
