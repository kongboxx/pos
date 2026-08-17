/**
 * The parts of a seed that EVERY shop needs, however it opens.
 *
 * A shop cannot trade without three things: a branch to trade as, at least one
 * person who can log in, and the document counters for the year. Everything
 * else — menu, tables, ingredients, expenses — is that shop's own business.
 *
 * Both seeds are built on this file:
 *   prisma/seed.ts       ร้านเปล่า, what a real shop runs (pnpm db:seed)
 *   prisma/seed-demo.ts  the noodle shop, for trying things out and for tests
 *
 * NOTHING in here overwrites a setting an owner has already changed. A seed is
 * run again to fix something unrelated — a missing counter, a new column — and
 * it must never be the reason a shop's VAT rate, opening hour or PIN goes back
 * to what it was on day one.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { hashPassword } from '../src/modules/auth/office-auth.service.js';

/**
 * Cheap on purpose. Seeded PINs are dev PINs or a first-login PIN that gets
 * changed; the API hashes real PINs with a higher cost factor.
 */
export const PIN_SALT_ROUNDS = 10;

export interface BranchSeed {
  name: string;
  branchCode: string;
  address?: string | null;
  phone?: string | null;
  /** 4 = a bill rung up at 00:20 still belongs to the previous day (rule #4). */
  dayCutoffHour?: number;
  rentPerMonthSatang?: number;
  /** NULL leaves the PromptPay button switched off until a real id is typed in. */
  promptPayId?: string | null;
}

export async function upsertBranch(prisma: PrismaClient, input: BranchSeed) {
  return prisma.branch.upsert({
    where: { branchCode: input.branchCode },
    // `update: {}` is the whole safety story of re-running a seed: the branch
    // row holds the VAT switch, the cutoff hour and the PromptPay id, and all
    // three are things an owner sets once and would never think to check again.
    update: {},
    create: {
      name: input.name,
      branchCode: input.branchCode,
      businessType: 'RESTAURANT',
      address: input.address ?? null,
      phone: input.phone ?? null,
      timezone: 'Asia/Bangkok',
      dayCutoffHour: input.dayCutoffHour ?? 4,
      // Not VAT-registered. The columns exist from day one; the switch is off
      // until registration actually lands (rule #3).
      vatEnabled: false,
      vatRateBp: 0,
      priceIncludesVat: true,
      rentPerMonthSatang: input.rentPerMonthSatang ?? 0,
      promptPayId: input.promptPayId ?? null,
    },
  });
}

export interface StaffSeed {
  fullName: string;
  nickname: string;
  position: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  pin: string;
  /** Back office login. Both optional: a cashier has neither. */
  email?: string;
  password?: string;
  wageType: 'MONTHLY' | 'DAILY';
  wageRateSatang: number;
  nationality: 'TH' | 'FOREIGN';
  startDate?: Date;
  passportNo?: string;
  passportExpiry?: Date;
  workPermitNo?: string;
  workPermitExpiry?: Date;
}

/**
 * Writes one person.
 *
 * `overwrite` is the difference between the two seeds and it is about PINs.
 * The demo seed sets it, because the whole point of the dev database is that
 * 1111/2222/3333 always work. The real seed does not, because re-running it
 * after six months of trading must not quietly put the owner's PIN back to
 * whatever was printed on the screen the day the shop was set up.
 */
export async function upsertStaff(
  prisma: PrismaClient,
  branchId: string,
  person: StaffSeed,
  { overwrite }: { overwrite: boolean },
): Promise<'created' | 'updated' | 'kept'> {
  const existing = await prisma.staff.findFirst({
    where: { branchId, fullName: person.fullName },
    select: { id: true },
  });
  if (existing && !overwrite) return 'kept';

  const data: Prisma.StaffUncheckedCreateInput = {
    branchId,
    fullName: person.fullName,
    nickname: person.nickname,
    position: person.position,
    role: person.role,
    pinHash: await bcrypt.hash(person.pin, PIN_SALT_ROUNDS),
    email: person.email ?? null,
    passwordHash: person.password ? await hashPassword(person.password) : null,
    startDate: person.startDate ?? new Date(),
    status: 'ACTIVE',
    nationality: person.nationality,
    passportNo: person.passportNo ?? null,
    passportExpiry: person.passportExpiry ?? null,
    workPermitNo: person.workPermitNo ?? null,
    workPermitExpiry: person.workPermitExpiry ?? null,
    wageType: person.wageType,
    wageRateSatang: person.wageRateSatang,
  };

  if (existing) {
    await prisma.staff.update({ where: { id: existing.id }, data });
    return 'updated';
  }
  await prisma.staff.create({ data });
  return 'created';
}

/**
 * The document counters for this calendar year (rule #9).
 *
 * doc-sequence.service.ts creates a missing row on demand, so this is not what
 * stands between the shop and its first receipt — it is so the settings screen
 * can show "ปีนี้ออกไปแล้ว 0 ใบ" instead of an empty table on day one.
 */
export async function seedDocSequences(prisma: PrismaClient, branchId: string): Promise<void> {
  const year = new Date().getFullYear();
  for (const docType of ['RECEIPT', 'TAX_INVOICE', 'CREDIT_NOTE'] as const) {
    await prisma.docSequence.upsert({
      where: { branchId_docType_year: { branchId, docType, year } },
      update: {},
      create: { branchId, docType, year, lastNumber: 0 },
    });
  }
  console.log(`  doc sequences: 3 (ปี ${year})`);
}
