/**
 * `/api/staff` — the people, their PINs and what gets taken off their pay.
 *
 * Owner-only in both directions: MANAGE_STAFF to write, VIEW_PAYROLL to read.
 * A wage rate is the single most sensitive number in a small shop — one cook
 * seeing another's rate is a resignation — so unlike the reports there is no
 * "manager may look but not touch" middle ground here.
 *
 * Every write is audited (rule #8) for the same reason expenses are: a wage
 * rate that goes up on the 28th and back down on the 2nd leaves no other trace.
 * The audit rows deliberately carry the wage terms and never the PIN.
 */

import type { FastifyInstance } from 'fastify';
import {
  deductionListQuerySchema,
  deductionRequestSchema,
  monthRange,
  Permission,
  staffCreateRequestSchema,
  staffPasswordRequestSchema,
  staffPinRequestSchema,
  staffRequestSchema,
  yearMonthOf,
  type DeductionDto,
  type DeductionListResponse,
  type StaffListResponse,
  type StaffRequest,
} from '@pos/shared';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { conflict, notFound } from '../../http-error.js';
import { requirePermission } from '../auth/guards.js';
import { hashPassword } from '../auth/office-auth.service.js';
import { branchBusinessDate, formatDateColumn, toDateColumn } from '../orders/order.mapper.js';
import {
  assertOwnerRemains,
  assertPinChangeAllowed,
  assertPinUnused,
  countHistory,
  hashPin,
  requireStaff,
  staffAuditShape,
  staffIdsWithHistory,
  toStaffDto,
} from './staff.service.js';

const idParams = z.object({ id: z.string().uuid() });

export function registerStaffRoutes(app: FastifyInstance): void {
  const readStaff = requirePermission(Permission.VIEW_PAYROLL, 'ดูข้อมูลพนักงาน');
  const writeStaff = requirePermission(Permission.MANAGE_STAFF, 'จัดการพนักงาน');

  /**
   * The whole roster, every time.
   *
   * Same reasoning as the expense screen: adding, editing or removing one
   * person changes who is on the next payroll run and who is left holding the
   * OWNER role, so answering with a single row would leave the rest of the
   * screen showing the state from before the change.
   */
  const roster = async (branchId: string, today: string): Promise<StaffListResponse> => {
    const [rows, withHistory] = await Promise.all([
      prisma.staff.findMany({
        where: { branchId },
        // People who left sink to the bottom rather than disappearing: they
        // still turn up on old payslips and in the audit log, and a screen that
        // hides them makes those names unexplainable.
        orderBy: [{ status: 'asc' }, { role: 'asc' }, { fullName: 'asc' }],
      }),
      staffIdsWithHistory(prisma, branchId),
    ]);

    return { today, staff: rows.map((row) => toStaffDto(row, withHistory.has(row.id))) };
  };

  app.get('/staff', { preHandler: readStaff }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await roster(branch.id, branchBusinessDate(branch)));
  });

  app.post('/staff', { preHandler: writeStaff }, async (request, reply) => {
    const body = staffCreateRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    await assertPinUnused(prisma, branch.id, body.pin);

    let created;
    try {
      created = await prisma.staff.create({
        data: { branchId: branch.id, pinHash: await hashPin(body.pin), ...toStaffColumns(body) },
      });
    } catch (error) {
      if (isDuplicateEmail(error)) throw conflict('EMAIL_TAKEN', 'อีเมลนี้มีคนใช้แล้ว');
      throw error;
    }

    await audit(branch.id, request.user.staffId, 'CREATE_STAFF', created.id, {
      after: staffAuditShape(created),
    });

    return reply.status(201).send(await roster(branch.id, branchBusinessDate(branch)));
  });

  app.put('/staff/:id', { preHandler: writeStaff }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = staffRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireStaff(prisma, branch.id, id);

    await assertOwnerRemains(prisma, branch.id, id, { role: body.role, status: body.status });

    let updated;
    try {
      updated = await prisma.staff.update({ where: { id }, data: toStaffColumns(body) });
    } catch (error) {
      if (isDuplicateEmail(error)) throw conflict('EMAIL_TAKEN', 'อีเมลนี้มีคนใช้แล้ว');
      throw error;
    }

    await audit(branch.id, request.user.staffId, 'UPDATE_STAFF', id, {
      before: staffAuditShape(existing),
      after: staffAuditShape(updated),
    });

    return reply.send(await roster(branch.id, branchBusinessDate(branch)));
  });

  /**
   * Setting a PIN — for a new hire, or for the far more common case of someone
   * who has forgotten theirs and locked the account out.
   *
   * Its own endpoint rather than a field on the edit form, because those are
   * two different acts: one changes a phone number, the other changes who can
   * sign in as this person. Resetting also clears the lockout, since being
   * given a fresh PIN and still not being able to use it for five minutes is
   * exactly the moment a rush is happening.
   */
  app.post('/staff/:id/pin', { preHandler: writeStaff }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { pin } = staffPinRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireStaff(prisma, branch.id, id);

    assertPinChangeAllowed(existing, request.user.staffId);
    await assertPinUnused(prisma, branch.id, pin, id);

    await prisma.staff.update({
      where: { id },
      data: { pinHash: await hashPin(pin), failedPinAttempts: 0, pinLockedUntil: null },
    });

    // No before/after: the whole content of this change is a secret. That it
    // happened, to whom and by whom is the part worth keeping.
    await audit(branch.id, request.user.staffId, 'RESET_STAFF_PIN', id, {
      reason: `ตั้ง PIN ใหม่ให้ ${existing.fullName}`,
    });

    return reply.send(await roster(branch.id, branchBusinessDate(branch)));
  });

  /**
   * Give someone the back office, or change their password.
   *
   * Its own endpoint for the same reason the PIN has one: editing a phone
   * number and deciding who can read every wage in the shop are different
   * acts, and only one of them should be possible by accident while tidying a
   * form. Setting a password also clears the lockout — being handed a new one
   * and still not being able to use it for fifteen minutes is exactly the
   * moment somebody is standing there waiting.
   */
  app.post('/staff/:id/password', { preHandler: writeStaff }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { password } = staffPasswordRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireStaff(prisma, branch.id, id);

    // A password with no username is a hash nobody can ever present a
    // credential against — the office login screen asks for an email.
    if (!existing.email) {
      throw conflict(
        'STAFF_HAS_NO_EMAIL',
        'ต้องใส่อีเมลให้คนนี้ก่อน ถึงจะตั้งรหัสผ่านเข้าหลังร้านได้',
      );
    }

    await prisma.staff.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(password),
        failedLoginAttempts: 0,
        loginLockedUntil: null,
      },
    });

    // No before/after: the whole content of this change is a secret. That it
    // happened, to whom and by whom is the part worth keeping.
    await audit(branch.id, request.user.staffId, 'SET_STAFF_PASSWORD', id, {
      reason: `ตั้งรหัสผ่านหลังร้านให้ ${existing.fullName}`,
    });

    return reply.send(await roster(branch.id, branchBusinessDate(branch)));
  });

  /**
   * Take the back office away.
   *
   * Revokes their live sessions in the same breath. Clearing the hash alone
   * would stop the NEXT login and leave whatever they are already holding
   * working for hours — which is the exact failure the sessions table was
   * added to make impossible.
   */
  app.delete('/staff/:id/password', { preHandler: writeStaff }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireStaff(prisma, branch.id, id);

    await prisma.staff.update({
      where: { id },
      data: { passwordHash: null, failedLoginAttempts: 0, loginLockedUntil: null },
    });
    const revoked = await app.sessions.revokeAllFor(id);

    await audit(branch.id, request.user.staffId, 'REVOKE_STAFF_PASSWORD', id, {
      reason: `ปิดสิทธิ์เข้าหลังร้านของ ${existing.fullName} (ตัดเซสชัน ${revoked} เครื่อง)`,
    });

    return reply.send(await roster(branch.id, branchBusinessDate(branch)));
  });

  /**
   * Delete, and almost always refuse.
   *
   * The exit for a real employee is สถานะ "ลาออกแล้ว". This exists only for the
   * row that was typed in wrong five minutes ago and has touched nothing — and
   * the check is not decoration: deleting someone with history would blank
   * their name out of the audit log (the relation is optional, so Postgres sets
   * it to NULL rather than refusing) and cascade away every deduction ever
   * recorded against them, including ones already settled on a payslip.
   */
  app.delete('/staff/:id', { preHandler: writeStaff }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const existing = await requireStaff(prisma, branch.id, id);

    if (existing.id === request.user.staffId) {
      throw conflict('SELF_DELETE', 'ลบบัญชีตัวเองไม่ได้');
    }
    await assertOwnerRemains(prisma, branch.id, id, {
      role: existing.role,
      status: 'LEFT',
    });

    const history = await countHistory(prisma, id);
    if (history > 0 || existing.lastLoginAt) {
      throw conflict(
        'STAFF_HAS_HISTORY',
        `${existing.fullName} มีประวัติในระบบแล้ว (สลิป การอนุมัติ หรือ log) ลบไม่ได้ — ให้เปลี่ยนสถานะเป็น "ลาออกแล้ว" แทน`,
      );
    }

    await prisma.staff.delete({ where: { id } });
    await audit(branch.id, request.user.staffId, 'DELETE_STAFF', id, {
      before: staffAuditShape(existing),
    });

    return reply.send(await roster(branch.id, branchBusinessDate(branch)));
  });

  /* ---------------------------------------------------------------- */
  /* deductions                                                        */
  /* ---------------------------------------------------------------- */

  const deductionMonth = async (
    branchId: string,
    yearMonth: string,
  ): Promise<DeductionListResponse> => {
    const { start, endExclusive } = monthRange(yearMonth);
    const rows = await prisma.staffDeduction.findMany({
      where: { branchId, date: { gte: toDateColumn(start), lt: toDateColumn(endExclusive) } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      include: { staff: { select: { fullName: true, nickname: true } } },
    });

    const deductions: DeductionDto[] = rows.map((row) => ({
      id: row.id,
      staffId: row.staffId,
      staffName: row.staff.nickname ?? row.staff.fullName,
      date: formatDateColumn(row.date),
      type: row.type,
      amountSatang: row.amountSatang,
      note: row.note,
      isSettled: row.payrollLineId !== null,
    }));

    return {
      yearMonth,
      deductions,
      totalSatang: deductions.reduce((sum, row) => sum + row.amountSatang, 0),
      unsettledSatang: deductions
        .filter((row) => !row.isSettled)
        .reduce((sum, row) => sum + row.amountSatang, 0),
    };
  };

  app.get('/staff/deductions', { preHandler: readStaff }, async (request, reply) => {
    const { month } = deductionListQuerySchema.parse(request.query);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await deductionMonth(branch.id, month));
  });

  app.post('/staff/deductions', { preHandler: writeStaff }, async (request, reply) => {
    const body = deductionRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    await requireStaff(prisma, branch.id, body.staffId);

    const created = await prisma.staffDeduction.create({
      data: {
        branchId: branch.id,
        staffId: body.staffId,
        date: toDateColumn(body.date),
        type: body.type,
        amountSatang: body.amountSatang,
        note: body.note ?? null,
      },
    });

    await audit(branch.id, request.user.staffId, 'CREATE_DEDUCTION', created.id, {
      after: { date: body.date, type: body.type, amountSatang: body.amountSatang },
      entityType: 'StaffDeduction',
    });

    return reply.status(201).send(await deductionMonth(branch.id, yearMonthOf(body.date)));
  });

  app.delete('/staff/deductions/:id', { preHandler: writeStaff }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const existing = await prisma.staffDeduction.findFirst({ where: { id, branchId: branch.id } });
    if (!existing) throw notFound('DEDUCTION_NOT_FOUND', 'ไม่พบรายการหักเงินนี้');

    // A settled deduction has already come off a payslip that somebody has
    // been handed. Removing it now would not give the money back — it would
    // only make the slip and the database disagree.
    if (existing.payrollLineId) {
      throw conflict(
        'DEDUCTION_SETTLED',
        'รายการนี้หักไปแล้วในสลิปที่จ่ายแล้ว ลบไม่ได้ — ถ้าหักผิด ให้ยกเลิกการจ่ายเงินเดือนรอบนั้นก่อน',
      );
    }

    await prisma.staffDeduction.delete({ where: { id } });
    await audit(branch.id, request.user.staffId, 'DELETE_DEDUCTION', id, {
      before: {
        date: formatDateColumn(existing.date),
        type: existing.type,
        amountSatang: existing.amountSatang,
      },
      entityType: 'StaffDeduction',
    });

    return reply.send(
      await deductionMonth(branch.id, yearMonthOf(formatDateColumn(existing.date))),
    );
  });
}

/* ------------------------------------------------------------------ */

/**
 * Request fields to Prisma columns.
 *
 * pinHash is excluded from the RETURN TYPE, not merely left out of the object:
 * this is spread into an `update` as well as a `create`, and a stray empty
 * string here would silently replace someone's PIN hash with one that no PIN
 * matches — locking them out with no error anywhere to explain it.
 */
function toStaffColumns(
  body: StaffRequest,
): Omit<Prisma.StaffUncheckedCreateInput, 'branchId' | 'pinHash'> {
  return {
    fullName: body.fullName,
    nickname: body.nickname ?? null,
    position: body.position ?? null,
    role: body.role,
    phone: body.phone ?? null,
    email: body.email ?? null,
    startDate: toDateColumn(body.startDate),
    endDate: body.endDate ? toDateColumn(body.endDate) : null,
    status: body.status,
    nationality: body.nationality,
    passportNo: body.passportNo ?? null,
    passportExpiry: body.passportExpiry ? toDateColumn(body.passportExpiry) : null,
    workPermitNo: body.workPermitNo ?? null,
    workPermitExpiry: body.workPermitExpiry ? toDateColumn(body.workPermitExpiry) : null,
    wageType: body.wageType,
    wageRateSatang: body.wageRateSatang,
    note: body.note ?? null,
  };
}

/**
 * Turns a duplicate-email collision into something a screen can say.
 *
 * The unique index is table-wide, so the person already holding this address
 * may be at another branch and therefore invisible to whoever is typing. A
 * raw Prisma error would surface as a 500 and tell them nothing.
 */
function isDuplicateEmail(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002' &&
    JSON.stringify((error as { meta?: unknown }).meta ?? {}).includes('email')
  );
}

async function audit(
  branchId: string,
  staffId: string,
  action: string,
  entityId: string,
  extra: {
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
    entityType?: string;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      branchId,
      staffId,
      action,
      entityType: extra.entityType ?? 'Staff',
      entityId,
      before: extra.before,
      after: extra.after,
      reason: extra.reason,
    },
  });
}
