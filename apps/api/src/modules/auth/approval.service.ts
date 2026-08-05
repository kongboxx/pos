/**
 * Supervisor approval at the terminal.
 *
 * A void is the one thing a cashier can do that makes money disappear from the
 * day's takings, so it is never self-served (rule #8). The manager walks over,
 * types their own PIN on the cashier's tablet, and their name goes on the
 * record next to the reason.
 *
 * THIS DOES NOT CREATE A SESSION. It verifies one PIN for one event and returns
 * a name. Signing the manager in would mean the tablet is left holding a
 * manager's session after they walk away — which is precisely the hole the
 * approval was supposed to close.
 *
 * The PIN goes through the SAME lockout as login, on the same counter. An
 * approval prompt that could be brute-forced would otherwise be a way around
 * the login's five-attempt limit: same 4 digits, no lockout.
 */

import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  can,
  MAX_PIN_ATTEMPTS,
  Permission,
  PIN_LOCKOUT_MS,
  StaffStatus,
  type Role,
} from '@pos/shared';
import {
  badRequest,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../../http-error.js';

export interface Approver {
  staffId: string;
  fullName: string;
  role: Role;
}

export interface ApprovalRequest {
  branchId: string;
  /** Who is asking. Used to refuse self-approval. */
  requestedByStaffId: string;
  approverStaffId: string;
  approverPin: string;
  permission: Permission;
  /** "ยกเลิกรายการ" — goes into the Thai error when the role is too low. */
  what: string;
}

/**
 * Verifies the approver and returns who they are, or throws.
 *
 * Run this OUTSIDE the transaction that performs the change: bcrypt costs
 * ~100ms and holding a Postgres transaction open for that long, on every void,
 * during a rush, is how a till starts feeling slow.
 */
export async function verifyApproval(
  db: PrismaClient | Prisma.TransactionClient,
  input: ApprovalRequest,
): Promise<Approver> {
  if (input.approverStaffId === input.requestedByStaffId) {
    throw badRequest('SELF_APPROVAL', 'ต้องให้ผู้จัดการหรือเจ้าของเป็นผู้อนุมัติ ไม่ใช่ตัวเอง');
  }

  const approver = await db.staff.findFirst({
    where: {
      id: input.approverStaffId,
      branchId: input.branchId,
      status: { not: StaffStatus.LEFT },
    },
  });
  if (!approver) throw notFound('APPROVER_NOT_FOUND', 'ไม่พบผู้อนุมัติคนนี้ในสาขา');

  if (!can(approver.role, input.permission)) {
    throw forbidden(`${approver.fullName} ไม่มีสิทธิ์อนุมัติ${input.what}`);
  }

  const now = new Date();
  if (approver.pinLockedUntil && approver.pinLockedUntil > now) {
    const minutes = Math.max(
      1,
      Math.ceil((approver.pinLockedUntil.getTime() - now.getTime()) / 60_000),
    );
    throw tooManyRequests('PIN_LOCKED', `บัญชีผู้อนุมัติถูกล็อก กรุณารออีก ${minutes} นาที`);
  }

  const matches = await bcrypt.compare(input.approverPin, approver.pinHash);

  if (!matches) {
    const attempts = approver.failedPinAttempts + 1;
    const shouldLock = attempts >= MAX_PIN_ATTEMPTS;

    await db.staff.update({
      where: { id: approver.id },
      data: {
        failedPinAttempts: shouldLock ? 0 : attempts,
        pinLockedUntil: shouldLock ? new Date(now.getTime() + PIN_LOCKOUT_MS) : null,
      },
    });

    throw unauthorized('PIN ผู้อนุมัติไม่ถูกต้อง');
  }

  // A correct PIN clears the counter, exactly as a successful login does.
  // `lastLoginAt` is deliberately NOT touched: approving a void is not a login,
  // and the payroll and audit screens read that column as "was at work".
  if (approver.failedPinAttempts !== 0 || approver.pinLockedUntil !== null) {
    await db.staff.update({
      where: { id: approver.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
  }

  return { staffId: approver.id, fullName: approver.fullName, role: approver.role };
}

/** The permission a void approval needs. Named so callers cannot pass the wrong one. */
export const VOID_APPROVAL = Permission.APPROVE_VOID;

/**
 * And the one a discount needs.
 *
 * A separate constant even though both roles that hold one hold the other
 * today, because they answer different questions — "may this person write off
 * food" and "may this person give money away" — and the day the owner wants a
 * shift leader who can do the first but not the second, that is one line in the
 * permission matrix rather than a hunt through the services.
 */
export const DISCOUNT_APPROVAL = Permission.APPROVE_DISCOUNT;
