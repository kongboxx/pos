/**
 * Staff records and deductions.
 *
 * What is worth testing here is not the CRUD, it is the four refusals: a shared
 * PIN, the last owner being removed, a person with history being deleted, and a
 * deduction that has already come off a payslip being edited. Each of those is
 * a mistake that cannot be undone from inside the app once it has happened.
 *
 * Everything this file creates is named with the prefix below and has a 2026
 * start date, so the payroll test file — which runs in parallel, in 2019 —
 * cannot sweep these people onto its run and cannot be affected when they are
 * deleted again.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Role, type StaffListResponse, type DeductionListResponse } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, loginAs } from '../../test-helpers.js';

/** Every row this file writes. The cleanup below deletes nothing else. */
const PREFIX = 'ทดสอบพนักงาน';
/** PINs nobody else in the suite uses — assertPinUnused compares across files. */
const PIN = { fresh: '5011', second: '5022', reset: '5033' };
const MONTH = '2019-11';
const DAY = '2019-11-08';

let app: FastifyInstance;
let owner: { staffId: string; cookie: string };
let manager: { staffId: string; cookie: string };
let branchId: string;
let startedAt: Date;

const person = (over: Record<string, unknown> = {}) => ({
  fullName: `${PREFIX} คนที่หนึ่ง`,
  nickname: 'ทดสอบ',
  position: 'ผู้ช่วยครัว',
  role: Role.STAFF,
  phone: null,
  startDate: '2026-07-01',
  endDate: null,
  status: 'ACTIVE',
  nationality: 'TH',
  passportNo: null,
  passportExpiry: null,
  workPermitNo: null,
  workPermitExpiry: null,
  wageType: 'DAILY',
  wageRateSatang: 45_000,
  note: null,
  pin: PIN.fresh,
  ...over,
});

async function create(payload: Record<string, unknown>, cookie = owner.cookie) {
  const options = { method: 'POST' as const, url: '/api/staff', headers: { cookie }, payload };
  return app.inject(options);
}

/** The id of the row this file just created, found by its prefix. */
async function createdIds(): Promise<string[]> {
  const rows = await prisma.staff.findMany({
    where: { branchId, fullName: { startsWith: PREFIX } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  app = await buildTestApp();
  owner = await loginAs(app, Role.OWNER);
  manager = await loginAs(app, Role.MANAGER);
  branchId = (
    await prisma.branch.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    })
  ).id;
  startedAt = new Date();
});

afterEach(async () => {
  const ids = await createdIds();
  await prisma.staffDeduction.deleteMany({ where: { staffId: { in: ids } } });
  await prisma.staff.deleteMany({ where: { id: { in: ids } } });
  // Deductions recorded against a SEEDED person by the tests below, kept inside
  // this file's month so a parallel file's rows are never touched.
  await prisma.staffDeduction.deleteMany({
    where: { branchId, date: { gte: new Date('2019-11-01'), lt: new Date('2019-12-01') } },
  });
  await prisma.auditLog.deleteMany({
    where: { entityType: { in: ['Staff', 'StaffDeduction'] }, createdAt: { gte: startedAt } },
  });
});

afterAll(async () => {
  await app.close();
});

describe('who may open the staff screen', () => {
  it('refuses a manager, not just a cashier', async () => {
    // A wage rate is the most sensitive number in a small shop — one cook
    // learning another's rate is a resignation — so unlike the reports there is
    // no "manager may look but not touch" middle ground.
    const read = await app.inject({
      method: 'GET',
      url: '/api/staff',
      headers: { cookie: manager.cookie },
    });
    expect(read.statusCode).toBe(403);

    const write = await create(person(), manager.cookie);
    expect(write.statusCode).toBe(403);
  });
});

describe('adding someone', () => {
  it('stores them and never sends the PIN hash back', async () => {
    const response = await create(person());
    expect(response.statusCode).toBe(201);

    const body: StaffListResponse = response.json();
    const created = body.staff.find((row) => row.fullName.startsWith(PREFIX));
    expect(created?.wageRateSatang).toBe(45_000);
    // The one field in this table worth stealing. A response that never carries
    // it cannot lose it to a screenshot, a proxy log or a service worker cache.
    expect(JSON.stringify(body)).not.toContain('$2b$');
    expect(JSON.stringify(body)).not.toContain('pinHash');
  });

  it('refuses a PIN somebody else is already using', async () => {
    // bcrypt salts every hash, so the unique index on the column cannot see
    // this. Only comparing the candidate against each stored hash can — and
    // without it, "who approved this void" stops having an answer.
    const first = await create(person());
    expect(first.statusCode).toBe(201);

    const second = await create(person({ fullName: `${PREFIX} คนที่สอง`, pin: PIN.fresh }));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('PIN_TAKEN');
  });

  it('refuses a PIN that a SEEDED employee is using', async () => {
    const response = await create(person({ pin: '3333' }));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PIN_TAKEN');
  });

  it('still works when some other row holds a hash bcrypt cannot read', async () => {
    // bcryptjs THROWS on a malformed hash rather than returning false, and the
    // PIN-uniqueness check compares the candidate against every stored hash. So
    // one corrupt row — a half-finished import, a hand-edited record, a restore
    // from a partial dump — would turn every "add an employee" into a 500 with
    // nothing on screen connecting it to the row that caused it.
    const corrupt = await prisma.staff.create({
      data: {
        branchId,
        fullName: `${PREFIX} แฮชพัง`,
        role: Role.STAFF,
        pinHash: 'not-a-bcrypt-hash',
        startDate: new Date('2026-07-01T00:00:00Z'),
      },
    });

    const response = await create(person({ pin: '5044' }));
    expect(response.statusCode).toBe(201);

    await prisma.staff.delete({ where: { id: corrupt.id } });
  });

  it('refuses someone who left before they started', async () => {
    const response = await create(person({ startDate: '2026-07-01', endDate: '2026-06-01' }));
    expect(response.statusCode).toBe(400);
  });

  it('refuses a wage rate that is not whole satang (rule #2)', async () => {
    expect((await create(person({ wageRateSatang: 450.5 }))).statusCode).toBe(400);
  });

  it('leaves an audit trail carrying the wage and never the PIN', async () => {
    const created: StaffListResponse = (await create(person())).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id;

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Staff', entityId: id },
    });
    expect(log.action).toBe('CREATE_STAFF');
    expect(log.after).toMatchObject({ wageRateSatang: 45_000, role: Role.STAFF });
    expect(JSON.stringify(log.after)).not.toContain('$2b$');
  });
});

describe('locking the shop out', () => {
  it('refuses to demote the last owner', async () => {
    // Only an owner can open these screens. Demoting the last one takes the
    // staff, payroll and branch screens away from everybody, and there is no
    // way back that does not involve editing the database by hand.
    const response = await app.inject({
      method: 'PUT',
      url: `/api/staff/${owner.staffId}`,
      headers: { cookie: owner.cookie },
      payload: person({ fullName: 'สมชาย เจ้าของร้าน', role: Role.MANAGER, pin: undefined }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('LAST_OWNER');
  });

  it('refuses to mark the last owner as having left', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/staff/${owner.staffId}`,
      headers: { cookie: owner.cookie },
      payload: person({
        fullName: 'สมชาย เจ้าของร้าน',
        role: Role.OWNER,
        status: 'LEFT',
        endDate: '2026-12-31',
        pin: undefined,
      }),
    });
    expect(response.statusCode).toBe(409);
  });

  it('allows an owner to be demoted while another one remains', async () => {
    // Demotes a THROWAWAY owner rather than the seeded one. Demoting the seeded
    // owner — even for a millisecond, even undone straight afterwards — is a
    // window in which another test file's `loginAs(OWNER)` finds the wrong
    // person and fails for no reason it could report.
    const created: StaffListResponse = (
      await create(person({ role: Role.OWNER, pin: PIN.second }))
    ).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/staff/${id}`,
      headers: { cookie: owner.cookie },
      payload: person({ role: Role.MANAGER, pin: undefined }),
    });
    expect(response.statusCode).toBe(200);
    expect((await prisma.staff.findUniqueOrThrow({ where: { id } })).role).toBe(Role.MANAGER);
  });
});

describe('editing', () => {
  it('does not touch the PIN when the edit form posts one', async () => {
    // The edit form is built for phone numbers and wage rates. A PIN riding
    // along in that payload would be a password change nobody asked for.
    const created: StaffListResponse = (await create(person())).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;
    const before = await prisma.staff.findUniqueOrThrow({ where: { id } });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/staff/${id}`,
      headers: { cookie: owner.cookie },
      payload: person({ pin: '5099', wageRateSatang: 50_000 }),
    });
    expect(response.statusCode).toBe(200);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id } });
    expect(after.wageRateSatang).toBe(50_000);
    expect(after.pinHash).toBe(before.pinHash);
  });

  it('resets a PIN and clears the lockout in the same move', async () => {
    // Being handed a fresh PIN and still not being able to use it for five
    // minutes is exactly the moment a rush is happening.
    const created: StaffListResponse = (await create(person())).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;
    await prisma.staff.update({
      where: { id },
      data: { failedPinAttempts: 4, pinLockedUntil: new Date(Date.now() + 300_000) },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${id}/pin`,
      headers: { cookie: owner.cookie },
      payload: { pin: PIN.reset },
    });
    expect(response.statusCode).toBe(200);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id } });
    expect(after.pinLockedUntil).toBeNull();
    expect(after.failedPinAttempts).toBe(0);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Staff', entityId: id, action: 'RESET_STAFF_PIN' },
    });
    // That it happened, to whom and by whom. The content of the change is a
    // secret and has no business in a log anybody can read.
    expect(log.after).toBeNull();
    expect(log.staffId).toBe(owner.staffId);
  });

  it('refuses a reset to a PIN somebody else already uses', async () => {
    const created: StaffListResponse = (await create(person())).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;

    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${id}/pin`,
      headers: { cookie: owner.cookie },
      payload: { pin: '2222' },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('deleting', () => {
  it('deletes a row that has touched nothing', async () => {
    const created: StaffListResponse = (await create(person())).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;
    expect(created.staff.find((row) => row.id === id)?.hasHistory).toBe(false);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/staff/${id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.staff.findUnique({ where: { id } })).toBeNull();
  });

  it('refuses once anything points at them', async () => {
    // Deleting them would blank their name out of the audit log — the relation
    // is optional, so Postgres sets it to NULL rather than refusing — and
    // cascade away every deduction ever recorded against them.
    const created: StaffListResponse = (await create(person())).json();
    const id = created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;

    await prisma.staffDeduction.create({
      data: {
        branchId,
        staffId: id,
        date: new Date(`${DAY}T00:00:00Z`),
        type: 'LATE',
        amountSatang: 5_000,
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/staff/${id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('STAFF_HAS_HISTORY');
  });

  it('refuses to delete the account you are signed in as', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/staff/${owner.staffId}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('deductions', () => {
  const deduction = (over: Record<string, unknown> = {}) => ({
    staffId: '',
    date: DAY,
    type: 'LATE',
    amountSatang: 10_000,
    note: 'สาย 20 นาที',
    ...over,
  });

  async function subject(): Promise<string> {
    const created: StaffListResponse = (await create(person())).json();
    return created.staff.find((row) => row.fullName.startsWith(PREFIX))?.id as string;
  }

  it('records one and answers with the whole month', async () => {
    const staffId = await subject();
    const response = await app.inject({
      method: 'POST',
      url: '/api/staff/deductions',
      headers: { cookie: owner.cookie },
      payload: deduction({ staffId }),
    });
    expect(response.statusCode).toBe(201);

    const body: DeductionListResponse = response.json();
    expect(body.yearMonth).toBe(MONTH);
    expect(body.totalSatang).toBe(10_000);
    // Nothing has been paid, so the whole lot is still waiting for a payslip.
    expect(body.unsettledSatang).toBe(10_000);
    expect(body.deductions[0]?.isSettled).toBe(false);
  });

  it('refuses a free-text reason and a zero amount', async () => {
    const staffId = await subject();
    for (const payload of [
      deduction({ staffId, type: 'มาสาย' }),
      deduction({ staffId, amountSatang: 0 }),
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/staff/deductions',
        headers: { cookie: owner.cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('refuses to delete one that a paid payslip already took', async () => {
    // Removing it now would not give the money back. It would only make the
    // slip in somebody's hand and the database disagree.
    const staffId = await subject();
    const created: DeductionListResponse = (
      await app.inject({
        method: 'POST',
        url: '/api/staff/deductions',
        headers: { cookie: owner.cookie },
        payload: deduction({ staffId }),
      })
    ).json();
    const id = created.deductions[0]?.id as string;

    await prisma.staffDeduction.update({
      where: { id },
      data: { payrollLineId: crypto.randomUUID() },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/staff/deductions/${id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('DEDUCTION_SETTLED');
  });
});
