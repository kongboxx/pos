/**
 * The lifecycle of one login.
 *
 * `now` is a parameter on every method rather than a mock of the clock: these
 * run against the real database, and freezing Date globally in a file that
 * other files run beside is how a suite starts failing in ways nobody can
 * reproduce.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { Role } from '@pos/shared';
import { prisma } from '../../db.js';
import { SessionService } from './session.service.js';

const SECRET = 'test-jwt-secret-value-long-enough';

let service: SessionService;
let branchId: string;
let staffId: string;

beforeAll(async () => {
  service = new SessionService(prisma, SECRET);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;

  const staff = await prisma.staff.create({
    data: {
      branchId,
      fullName: 'ทดสอบ เซสชัน',
      role: Role.STAFF,
      pinHash: await bcrypt.hash('4242', 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  staffId = staff.id;
});

afterEach(async () => {
  await prisma.session.deleteMany({ where: { staffId } });
});

afterAll(async () => {
  await prisma.staff.delete({ where: { id: staffId } });
  await prisma.$disconnect();
});

const base = { branchId: '', staffId: '', surface: 'POS' as const, ttlSeconds: 3600 };
const input = (): typeof base => ({ ...base, branchId, staffId });

describe('issuing', () => {
  it('returns an id and an expiry the caller can put in a cookie', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    const issued = await service.issue(input(), now);

    expect(issued.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.expiresAt.toISOString()).toBe('2026-08-17T11:00:00.000Z');
  });

  it('never stores the raw IP', async () => {
    const issued = await service.issue({ ...input(), ip: '203.0.113.9' });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.id } });

    expect(row.ipHash).not.toBeNull();
    expect(row.ipHash).not.toContain('203.0.113.9');
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same IP to the same value, so two logins can be compared', async () => {
    const a = await service.issue({ ...input(), ip: '203.0.113.9' });
    const b = await service.issue({ ...input(), ip: '203.0.113.9' });
    const c = await service.issue({ ...input(), ip: '198.51.100.4' });

    const rows = await prisma.session.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    const byId = new Map(rows.map((row) => [row.id, row.ipHash]));

    expect(byId.get(a.id)).toBe(byId.get(b.id));
    expect(byId.get(a.id)).not.toBe(byId.get(c.id));
  });

  it('keys the hash with the secret, so the digest is not a lookup away from the IP', async () => {
    const other = new SessionService(prisma, 'a-completely-different-secret');
    const mine = await service.issue({ ...input(), ip: '203.0.113.9' });
    const theirs = await other.issue({ ...input(), ip: '203.0.113.9' });

    const rows = await prisma.session.findMany({ where: { id: { in: [mine.id, theirs.id] } } });
    expect(rows[0]?.ipHash).not.toBe(rows[1]?.ipHash);
  });

  it('leaves ipHash null when there is no IP to hash', async () => {
    const issued = await service.issue(input());
    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.ipHash).toBeNull();
  });
});

describe('checking', () => {
  it('says a fresh session is live', async () => {
    const issued = await service.issue(input());
    expect(await service.isLive(issued.id)).toBe(true);
  });

  it('says an expired session is not, without anyone having to delete it', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    const issued = await service.issue({ ...input(), ttlSeconds: 60 }, now);

    expect(await service.isLive(issued.id, new Date('2026-08-17T10:00:30Z'))).toBe(true);
    expect(await service.isLive(issued.id, new Date('2026-08-17T10:01:01Z'))).toBe(false);
  });

  it('says a revoked session is not, even though it has not expired', async () => {
    const issued = await service.issue(input());
    await service.revoke(issued.id);
    expect(await service.isLive(issued.id)).toBe(false);
  });

  it('says an id that was never issued is not live', async () => {
    // A forged jti must read the same as a dead one.
    expect(await service.isLive('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('says a malformed id is not live instead of throwing', async () => {
    // Prisma rejects a non-uuid on a uuid column. This reaches the guard on
    // every request, so it has to answer false rather than 500 the API.
    expect(await service.isLive('not-a-uuid')).toBe(false);
  });
});

describe('revoking', () => {
  it('is quiet about an id that does not exist', async () => {
    await expect(service.revoke('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });

  it('keeps the first revocation time when revoked twice', async () => {
    const issued = await service.issue(input());
    await service.revoke(issued.id, new Date('2026-08-17T10:00:00Z'));
    await service.revoke(issued.id, new Date('2026-08-17T12:00:00Z'));

    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.revokedAt?.toISOString()).toBe('2026-08-17T10:00:00.000Z');
  });

  it('kills every live session a person has, and counts them', async () => {
    await service.issue(input());
    await service.issue({ ...input(), surface: 'OFFICE' });
    const already = await service.issue(input());
    await service.revoke(already.id);

    // Two live, not three: the already-revoked one must not be counted again
    // or "logged out of 3 devices" would be a lie the first time and right the
    // second.
    expect(await service.revokeAllFor(staffId)).toBe(2);
    expect(await prisma.session.count({ where: { staffId, revokedAt: null } })).toBe(0);
  });
});

describe('purging', () => {
  it('keeps an expired session inside the retention window', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    await service.issue({ ...input(), ttlSeconds: 60 }, now);

    // Expired for a day. Still the answer to "who was logged in yesterday".
    expect(await service.purgeExpired(new Date('2026-08-18T10:00:00Z'))).toBe(0);
  });

  it('deletes one that expired longer ago than the retention window', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    await service.issue({ ...input(), ttlSeconds: 60 }, now);

    // Not `toBe(1)`: purging is global by design, and every other test file in
    // this suite logs in against the same database and leaves its own rows
    // behind. The count would be whatever ran before this file today, which is
    // a number no assertion should depend on. What this test is actually about
    // is the row it created, so that is what it checks.
    expect(await service.purgeExpired(new Date('2026-11-20T10:00:00Z'))).toBeGreaterThanOrEqual(1);
    expect(await prisma.session.count({ where: { staffId } })).toBe(0);
  });

  it('never touches a session that is still live', async () => {
    const issued = await service.issue({ ...input(), ttlSeconds: 3600 });
    expect(await service.purgeExpired()).toBe(0);
    expect(await service.isLive(issued.id)).toBe(true);
  });
});
