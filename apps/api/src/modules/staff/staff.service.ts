/**
 * The rules around a staff record that are worth more than the CRUD (Step 9).
 *
 * Three of them, in order of how much they cost when they are missing:
 *
 *  1. TWO PEOPLE MUST NOT SHARE A PIN. Login picks the name first and then
 *     checks one hash, so a duplicate cannot log you in as the wrong person —
 *     but it can do something worse. The void approval and the payslip both put
 *     a NAME next to an action, and the moment two people can type the same
 *     four digits, "who approved this" stops being an answer. bcrypt salts every
 *     hash, so the unique index on the column cannot see a duplicate; only
 *     comparing the candidate against each stored hash can.
 *
 *  2. THE SHOP MUST NOT BE ABLE TO LOCK ITSELF OUT. Only an OWNER may open
 *     these screens, so demoting the last owner — or marking them as having
 *     left — takes the staff, payroll and branch screens away from everybody,
 *     with no way back that does not involve someone editing the database.
 *
 *  3. A PERSON WHO HAS DONE ANYTHING MUST NOT BE DELETABLE. Their name is on
 *     payslips, on approved voids, and in the audit log, which is the one place
 *     rule #8 promises will still make sense a year from now. "ลาออก" is the
 *     exit; DELETE is only for a row created by mistake five minutes ago.
 */

import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient, Staff } from '@prisma/client';
import { Role, StaffStatus, type StaffDto } from '@pos/shared';
import { badRequest, conflict, notFound } from '../../http-error.js';
import { formatDateColumn } from '../orders/order.mapper.js';

/**
 * Cost factor for a real PIN, against 10 in the dev seed.
 *
 * 12 is ~4x slower to verify, which is the point: a 4-digit PIN is 10,000
 * combinations and the work factor is half of what makes that survivable (the
 * login lockout is the other half). It is only paid on login and approval, not
 * per request, because the session lives in a JWT.
 */
export const PIN_SALT_ROUNDS = 12;

export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, PIN_SALT_ROUNDS);
}

/**
 * Refuses a PIN that somebody else at this branch is already using.
 *
 * Costs one bcrypt compare per employee — ~100ms each, so ~1s for ten people.
 * That is fine HERE and would not be at login: this runs when an owner adds a
 * member of staff, which happens a handful of times a year.
 */
export async function assertPinUnused(
  db: PrismaClient,
  branchId: string,
  pin: string,
  exceptStaffId?: string,
): Promise<void> {
  const others = await db.staff.findMany({
    where: {
      branchId,
      status: { not: StaffStatus.LEFT },
      ...(exceptStaffId ? { id: { not: exceptStaffId } } : {}),
    },
    select: { fullName: true, nickname: true, pinHash: true },
  });

  for (const other of others) {
    if (await pinMatches(pin, other.pinHash)) {
      // Naming them is not a leak: only an owner can reach this, and the
      // alternative — "PIN นี้ใช้ไม่ได้" — sends them guessing.
      throw conflict(
        'PIN_TAKEN',
        `PIN นี้ ${other.nickname ?? other.fullName} ใช้อยู่แล้ว กรุณาใช้เลขอื่น`,
      );
    }
  }
}

/**
 * bcrypt.compare, except that a hash it cannot parse is "no match" rather than
 * an exception.
 *
 * bcryptjs THROWS on a malformed hash instead of returning false. Left
 * unhandled, one corrupt row — a half-finished import, a hand-edited record, a
 * restore from a partial dump — turns every "add an employee" and every "reset
 * a PIN" into a 500 with nothing on screen to connect it to the row that caused
 * it. The shop cannot hire anyone until somebody reads a stack trace.
 *
 * Skipping it is also the safe direction: the worst case is that a corrupt hash
 * fails to block a duplicate PIN, and nobody can log in with that row anyway —
 * login runs the same compare and fails the same way.
 */
async function pinMatches(pin: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(pin, hash);
  } catch {
    return false;
  }
}

/**
 * Refuses a change that would leave the branch with no usable owner.
 *
 * "Usable" means role OWNER and not LEFT. A branch in that state cannot open
 * the staff screen to fix itself, which makes this the one validation here that
 * has no manual workaround.
 */
export async function assertOwnerRemains(
  db: PrismaClient,
  branchId: string,
  staffId: string,
  next: { role: Role; status: StaffStatus },
): Promise<void> {
  if (next.role === Role.OWNER && next.status !== StaffStatus.LEFT) return;

  const otherOwners = await db.staff.count({
    where: { branchId, id: { not: staffId }, role: Role.OWNER, status: { not: StaffStatus.LEFT } },
  });
  if (otherOwners > 0) return;

  throw conflict(
    'LAST_OWNER',
    'คนนี้เป็นเจ้าของร้านคนเดียวที่เหลืออยู่ — ถ้าเปลี่ยนแล้วจะไม่มีใครเข้าหน้าจัดการได้อีก ตั้งเจ้าของอีกคนก่อน',
  );
}

/** Every table that would lose or mangle a record if this person were deleted. */
export async function countHistory(db: PrismaClient, staffId: string): Promise<number> {
  const counts = await Promise.all([
    db.payrollLine.count({ where: { staffId } }),
    db.staffDeduction.count({ where: { staffId } }),
    db.auditLog.count({ where: { staffId } }),
    db.voidLog.count({ where: { requestedByStaffId: staffId } }),
    db.voidLog.count({ where: { approvedByStaffId: staffId } }),
    db.prepBatch.count({ where: { madeByStaffId: staffId } }),
    db.shift.count({ where: { staffId } }),
    // Both sides of a credit note (Step 10). Their name is on a tax document
    // that reversed a sale; deleting the row would blank it out, because the
    // relation is optional and the database is allowed to set it null.
    db.creditNote.count({ where: { issuedByStaffId: staffId } }),
    db.creditNote.count({ where: { approvedByStaffId: staffId } }),
  ]);

  return counts.reduce((sum, count) => sum + count, 0);
}

/**
 * Which staff ids have history, in one pass over each table.
 *
 * The list screen needs this for every row to decide whether to offer a delete
 * button, and doing `countHistory` per person would be seven queries times the
 * whole payroll.
 */
export async function staffIdsWithHistory(
  db: PrismaClient,
  branchId: string,
): Promise<Set<string>> {
  const scope = { where: { branchId } };
  const [payrollLines, deductions, auditLogs, voidLogs, prepBatches, shifts, creditNotes] =
    await Promise.all([
      db.payrollLine.findMany({ ...scope, select: { staffId: true }, distinct: ['staffId'] }),
      db.staffDeduction.findMany({ ...scope, select: { staffId: true }, distinct: ['staffId'] }),
      db.auditLog.findMany({ ...scope, select: { staffId: true }, distinct: ['staffId'] }),
      db.voidLog.findMany({
        ...scope,
        select: { requestedByStaffId: true, approvedByStaffId: true },
      }),
      db.prepBatch.findMany({
        ...scope,
        select: { madeByStaffId: true },
        distinct: ['madeByStaffId'],
      }),
      db.shift.findMany({ ...scope, select: { staffId: true }, distinct: ['staffId'] }),
      db.creditNote.findMany({
        ...scope,
        select: { issuedByStaffId: true, approvedByStaffId: true },
      }),
    ]);

  const used = new Set<string>();
  const add = (id: string | null): void => {
    if (id) used.add(id);
  };

  for (const row of [...payrollLines, ...deductions, ...auditLogs, ...shifts]) add(row.staffId);
  for (const row of voidLogs) {
    add(row.requestedByStaffId);
    add(row.approvedByStaffId);
  }
  for (const row of creditNotes) {
    add(row.issuedByStaffId);
    add(row.approvedByStaffId);
  }
  for (const row of prepBatches) add(row.madeByStaffId);

  return used;
}

export async function requireStaff(
  db: PrismaClient,
  branchId: string,
  staffId: string,
): Promise<Staff> {
  const staff = await db.staff.findFirst({ where: { id: staffId, branchId } });
  if (!staff) throw notFound('STAFF_NOT_FOUND', 'ไม่พบพนักงานคนนี้');
  return staff;
}

/**
 * The row as the screen sees it.
 *
 * pinHash, failedPinAttempts and pinLockedUntil are not on it. The hash is the
 * one field in this table worth stealing, and a response that never carries it
 * cannot lose it to a screenshot, a proxy log or a service worker cache.
 */
export function toStaffDto(row: Staff, hasHistory: boolean, now = new Date()): StaffDto {
  return {
    id: row.id,
    fullName: row.fullName,
    nickname: row.nickname,
    position: row.position,
    role: row.role,
    phone: row.phone,
    email: row.email,
    // The boolean, never the hash. A screen only needs to know whether the
    // door exists, and a hash on the wire is a hash in someone's devtools.
    hasOfficeAccess: row.passwordHash !== null,
    isLoginLocked: !!row.loginLockedUntil && row.loginLockedUntil > now,

    startDate: formatDateColumn(row.startDate),
    endDate: row.endDate ? formatDateColumn(row.endDate) : null,
    status: row.status,

    nationality: row.nationality,
    passportNo: row.passportNo,
    passportExpiry: row.passportExpiry ? formatDateColumn(row.passportExpiry) : null,
    workPermitNo: row.workPermitNo,
    workPermitExpiry: row.workPermitExpiry ? formatDateColumn(row.workPermitExpiry) : null,

    wageType: row.wageType,
    wageRateSatang: row.wageRateSatang,

    note: row.note,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    isPinLocked: !!row.pinLockedUntil && row.pinLockedUntil > now,
    hasHistory,
  };
}

/** What an audit reader needs, minus anything Prisma-shaped or secret. */
export function staffAuditShape(row: Staff): Prisma.InputJsonValue {
  return {
    fullName: row.fullName,
    nickname: row.nickname,
    role: row.role,
    email: row.email,
    status: row.status,
    wageType: row.wageType,
    wageRateSatang: row.wageRateSatang,
    startDate: formatDateColumn(row.startDate),
    endDate: row.endDate ? formatDateColumn(row.endDate) : null,
  };
}

/** Guards the one edit that has no undo: taking someone's PIN away from them. */
export function assertPinChangeAllowed(target: Staff, actingStaffId: string): void {
  if (target.status === StaffStatus.LEFT && target.id !== actingStaffId) {
    throw badRequest('STAFF_LEFT', 'คนนี้ลาออกแล้ว ถ้าจะให้กลับมาทำงาน เปลี่ยนสถานะก่อน');
  }
}
