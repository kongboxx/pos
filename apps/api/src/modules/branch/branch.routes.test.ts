/**
 * Branch settings, a second shop, and the VAT switch.
 *
 * EVERY WRITE IN THIS FILE TARGETS A BRANCH THIS FILE CREATED. The seeded
 * branch is shared with every other test file in the suite and they all pay
 * bills through it, so turning VAT on there — even for one test — would make a
 * parallel file's cash bill total 7% more than it asserted, and putting the
 * settings back afterwards would wipe a column another file had just set. Both
 * of those happened; running against an owned branch is what fixed them.
 *
 * The owned branch comes with its own owner (that is what POST /branches does),
 * so the VAT tests can log into it and read /auth/me and /api/bills as that
 * shop without touching the seeded one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Branch } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Role, type BranchDto, type BranchListResponse } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, loginAs } from '../../test-helpers.js';

const CODE = 'TSTBR';
const SPARE_CODE = 'TSTBR2';
const NAME = 'ทดสอบสาขา สาขาสอง';
const OWNER_PIN = '7788';
/** Valid check digit — see isValidThaiTaxId in @pos/shared. */
const SHOP_TAX_ID = '0105558123451';

let app: FastifyInstance;
let owner: { staffId: string; cookie: string };
let manager: { staffId: string; cookie: string };
/** The branch this file owns, plus a session belonging to it. */
let mine: BranchDto;
let myCookie: string;
let seeded: Branch;
let startedAt: Date;

/** The settings form, prefilled from the branch as it is right now. */
function settingsOf(branch: BranchDto, overrides: Record<string, unknown> = {}) {
  return {
    name: branch.name,
    businessType: branch.businessType,
    address: branch.address,
    phone: branch.phone,
    taxId: branch.taxId,
    timezone: branch.timezone,
    dayCutoffHour: branch.dayCutoffHour,
    vatEnabled: branch.vatEnabled,
    vatRateBp: branch.vatRateBp,
    priceIncludesVat: branch.priceIncludesVat,
    vatEffectiveDate: branch.vatEffectiveDate,
    rentPerMonthSatang: branch.rentPerMonthSatang,
    promptPayId: branch.promptPayId,
    qrOrderingEnabled: branch.qrOrderingEnabled,
    isActive: branch.isActive,
    ...overrides,
  };
}

async function list(cookie = owner.cookie): Promise<BranchListResponse> {
  const response = await app.inject({ method: 'GET', url: '/api/branches', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/** The owned branch as the settings screen currently sees it. */
async function current(): Promise<BranchDto> {
  const body = await list();
  return body.branches.find((row) => row.id === mine.id) as BranchDto;
}

function save(payload: Record<string, unknown>, cookie = owner.cookie, id = mine.id) {
  return app.inject({ method: 'PUT', url: `/api/branches/${id}`, headers: { cookie }, payload });
}

async function createBranch(code: string, name = NAME) {
  return app.inject({
    method: 'POST',
    url: '/api/branches',
    headers: { cookie: owner.cookie },
    payload: {
      name,
      branchCode: code,
      businessType: 'RESTAURANT',
      ownerFullName: 'ทดสอบสาขา ผู้จัดการสาขาสอง',
      ownerNickname: 'สอง',
      ownerPin: OWNER_PIN,
    },
  });
}

async function dropBranch(code: string): Promise<void> {
  const branch = await prisma.branch.findUnique({ where: { branchCode: code } });
  if (!branch) return;
  await prisma.order.deleteMany({ where: { branchId: branch.id } });
  await prisma.auditLog.deleteMany({ where: { branchId: branch.id } });
  await prisma.staff.deleteMany({ where: { branchId: branch.id } });
  await prisma.branch.delete({ where: { id: branch.id } });
}

beforeAll(async () => {
  app = await buildTestApp();
  owner = await loginAs(app, Role.OWNER);
  manager = await loginAs(app, Role.MANAGER);
  seeded = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  startedAt = new Date();

  await dropBranch(CODE);
  const created = await createBranch(CODE);
  expect(created.statusCode).toBe(201);
  mine = created.json();

  const staff = await app.inject({ method: 'GET', url: `/api/auth/staff?branchId=${mine.id}` });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { branchId: mine.id, staffId: staff.json().staff[0].id, pin: OWNER_PIN },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'];
  const raw = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string;
  myCookie = raw.split(';')[0] as string;
});

afterEach(async () => {
  // Only the branch this file owns is reset. Nothing here ever wrote to the
  // seeded one, so there is nothing to put back and nothing to trample.
  await prisma.branch.update({
    where: { id: mine.id },
    data: {
      name: NAME,
      address: null,
      phone: null,
      taxId: null,
      vatEnabled: false,
      vatRateBp: 0,
      priceIncludesVat: true,
      vatEffectiveDate: null,
      rentPerMonthSatang: 0,
      qrOrderingEnabled: true,
      isActive: true,
    },
  });
  await prisma.order.deleteMany({ where: { branchId: mine.id } });
  await dropBranch(SPARE_CODE);
  await prisma.auditLog.deleteMany({
    where: { entityType: 'Branch', createdAt: { gte: startedAt } },
  });
});

afterAll(async () => {
  await dropBranch(CODE);
  await app.close();
});

describe('who may open the branch screen', () => {
  it('refuses a manager reading and writing', async () => {
    const read = await app.inject({
      method: 'GET',
      url: '/api/branches',
      headers: { cookie: manager.cookie },
    });
    expect(read.statusCode).toBe(403);
    expect((await save(settingsOf(await current()), manager.cookie)).statusCode).toBe(403);
  });
});

describe('the settings form', () => {
  it('lists every shop and marks the one the session belongs to', async () => {
    const body = await list();
    const codes = body.branches.map((row) => row.branchCode);

    expect(codes).toContain(seeded.branchCode);
    expect(codes).toContain(CODE);
    expect(body.currentBranchId).toBe(seeded.id);
  });

  it('freezes the branch code only once a document carries it', async () => {
    // A brand new branch has issued nothing, so its code is still movable —
    // and the seeded one has issued receipts, so its code never moves again.
    const body = await list();
    expect(body.branches.find((row) => row.branchCode === CODE)?.hasDocuments).toBe(false);
    expect(body.branches.find((row) => row.id === seeded.id)?.hasDocuments).toBe(true);
  });

  it('renames the shop and writes the change to the audit log', async () => {
    const before = await current();
    const response = await save(settingsOf(before, { name: 'ทดสอบสาขา ชื่อใหม่' }));
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('ทดสอบสาขา ชื่อใหม่');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'UPDATE_BRANCH', entityId: before.id },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit.before as { name: string }).name).toBe(before.name);
    expect((audit.after as { name: string }).name).toBe('ทดสอบสาขา ชื่อใหม่');
    // Filed against the branch the OWNER was working from, which is where
    // "who changed branch 2's settings" gets asked.
    expect(audit.branchId).toBe(seeded.id);
  });

  it('never lets the branch code be edited at all', async () => {
    const before = await current();
    // Not "refuses": the field is not in the schema, so a code posted in the
    // body is dropped rather than obeyed. That is the strongest version of the
    // rule — there is no request shape that can change it.
    const response = await save(settingsOf(before, { branchCode: 'HACKED' }));
    expect(response.statusCode).toBe(200);
    expect(response.json().branchCode).toBe(CODE);
  });

  it('refuses closing a branch that still has an open bill', async () => {
    await prisma.order.create({
      data: {
        id: crypto.randomUUID(),
        branchId: mine.id,
        businessDate: new Date('2019-05-05T00:00:00Z'),
        status: 'OPEN',
      },
    });

    const response = await save(settingsOf(await current(), { isActive: false }));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('BRANCH_HAS_OPEN_BILLS');
  });
});

describe('the VAT switch', () => {
  it('refuses turning VAT on without a rate', async () => {
    const response = await save(
      settingsOf(await current(), { vatEnabled: true, vatRateBp: 0, taxId: SHOP_TAX_ID }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses turning VAT on without the shop tax id', async () => {
    const response = await save(
      settingsOf(await current(), { vatEnabled: true, vatRateBp: 700, taxId: null }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses a start date that lands on top of bills already closed without VAT', async () => {
    // The failure this prevents: bills settled at 0% and a report that now
    // re-reads the effective date and calls the same day 7%. The two disagree
    // in the direction of "collected VAT we never remitted".
    await prisma.order.create({
      data: {
        id: crypto.randomUUID(),
        branchId: mine.id,
        businessDate: new Date('2019-05-05T00:00:00Z'),
        status: 'PAID',
        paidAt: new Date('2019-05-05T10:00:00Z'),
        receiptNo: 'RC-TSTBR-2019-000001',
        totalSatang: 12000,
        subtotalExVatSatang: 12000,
        vatRateBpSnapshot: 0,
      },
    });

    const response = await save(
      settingsOf(await current(), {
        vatEnabled: true,
        vatRateBp: 700,
        taxId: SHOP_TAX_ID,
        vatEffectiveDate: '2019-05-01',
      }),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('VAT_DATE_BACKDATED');
    expect(response.json().message).toContain('2019-05-05');
  });

  it('accepts a future start date and leaves today at 0%', async () => {
    const response = await save(
      settingsOf(await current(), {
        vatEnabled: true,
        vatRateBp: 700,
        taxId: SHOP_TAX_ID,
        vatEffectiveDate: '2099-01-01',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().vatEffectiveDate).toBe('2099-01-01');

    // Read as that branch's own session: the switch is ON and a bill trading
    // today still carries no VAT. That gap is the whole point of the date.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: myCookie },
    });
    expect(me.json().branch.vatEnabled).toBe(true);
    expect(me.json().branch.vatEffectiveDate).toBe('2099-01-01');

    const bills = await app.inject({
      method: 'GET',
      url: '/api/bills',
      headers: { cookie: myCookie },
    });
    expect(bills.json().vatActive).toBe(false);
  });

  it('zeroes the stored rate when VAT is switched back off', async () => {
    await save(
      settingsOf(await current(), {
        vatEnabled: true,
        vatRateBp: 700,
        taxId: SHOP_TAX_ID,
        vatEffectiveDate: '2099-01-01',
      }),
    );
    const off = await save(settingsOf(await current(), { vatEnabled: false }));

    expect(off.statusCode).toBe(200);
    // Left at 700 the branch would look registered to anything that reads the
    // rate without also reading the switch.
    expect(off.json().vatRateBp).toBe(0);
  });
});

describe('a second shop', () => {
  it('opens with an owner who can log into it, and nobody else', async () => {
    const created = await createBranch(SPARE_CODE, 'ทดสอบสาขา สาขาสาม');
    expect(created.statusCode).toBe(201);
    const branch: BranchDto = created.json();
    expect(branch.activeStaffCount).toBe(1);
    expect(branch.hasDocuments).toBe(false);

    // The login screen can now offer it, which is the only reason the owner
    // was created in the same transaction.
    const choices = await app.inject({ method: 'GET', url: '/api/auth/branches' });
    expect(choices.json().branches.map((row: { branchCode: string }) => row.branchCode)).toContain(
      SPARE_CODE,
    );

    const staff = await app.inject({ method: 'GET', url: `/api/auth/staff?branchId=${branch.id}` });
    expect(staff.json().staff).toHaveLength(1);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { branchId: branch.id, staffId: staff.json().staff[0].id, pin: OWNER_PIN },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.branchId).toBe(branch.id);
  });

  it('refuses a duplicate branch code and names who has it', async () => {
    const response = await createBranch(CODE, 'ทดสอบสาขา ซ้ำ');
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain(NAME);
  });

  it('shows every shop on the owner-only cross-branch summary', async () => {
    const summary = await app.inject({
      method: 'GET',
      url: '/api/reports/branches?date=2019-05-05',
      headers: { cookie: owner.cookie },
    });
    expect(summary.statusCode).toBe(200);

    const rows = summary.json().rows as { branchCode: string; isCurrent: boolean }[];
    expect(rows.map((row) => row.branchCode)).toContain(CODE);
    expect(rows.find((row) => row.branchCode === seeded.branchCode)?.isCurrent).toBe(true);
    expect(rows.find((row) => row.branchCode === CODE)?.isCurrent).toBe(false);

    // A manager runs one shop and is measured on it. Reading every other
    // branch's takings is not part of that job.
    const asManager = await app.inject({
      method: 'GET',
      url: '/api/reports/branches?date=2019-05-05',
      headers: { cookie: manager.cookie },
    });
    expect(asManager.statusCode).toBe(403);
  });
});
