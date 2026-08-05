/**
 * Which branch is "this one".
 *
 * EVERY authenticated request answers this from the SESSION TOKEN, never from
 * the request body. Rule #1 — every table carries branchId — is only worth
 * something if the scope cannot be chosen by the caller; a `branchId` in a
 * body would make the whole tenant boundary a suggestion.
 *
 * Step 10 opened the shop up to more than one branch and did NOT change that.
 * A session still belongs to exactly one branch and can only operate that one.
 * The single deliberate exception is the owner's read-only "all branches"
 * summary, which is guarded by its own permission (VIEW_ALL_BRANCHES) and
 * still never accepts a branchId from the caller — it lists every branch or
 * none.
 *
 * The two `default branch` helpers below survive for the login screen only,
 * where there is no session yet and a single-branch shop should not have to
 * pick its only shop out of a list of one.
 */

import type { Branch, PrismaClient } from '@prisma/client';
import { StaffStatus, type BranchChoice } from '@pos/shared';
import { notFound } from './http-error.js';

export async function findDefaultBranch(db: PrismaClient): Promise<Branch | null> {
  return db.branch.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
}

export async function requireDefaultBranch(db: PrismaClient): Promise<Branch> {
  const branch = await findDefaultBranch(db);
  if (!branch) {
    throw notFound('BRANCH_NOT_FOUND', 'ยังไม่มีสาขาในระบบ — รัน pnpm db:seed ก่อน');
  }
  return branch;
}

/**
 * The branches the login screen may offer.
 *
 * A branch with nobody who can log in is left OUT rather than shown and then
 * dead-ending on an empty staff list. That state is reachable: the last person
 * at a branch is marked as having left, and the branch keeps trading in the
 * reports while nobody can open the till.
 */
export async function listLoginBranches(db: PrismaClient): Promise<BranchChoice[]> {
  const branches = await db.branch.findMany({
    where: {
      isActive: true,
      staff: { some: { status: { not: StaffStatus.LEFT } } },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, branchCode: true },
  });
  return branches;
}

/**
 * The branch a login attempt is for.
 *
 * With one shop there is nothing to pick, so the picker never appears and the
 * id never arrives — that is the `undefined` case. When it does arrive it is
 * still not trusted: it only narrows the lookup, and `AuthService.login`
 * scopes by (branchId, staffId) so a mismatched pair fails exactly like an
 * unknown staff member.
 */
export async function resolveLoginBranch(
  db: PrismaClient,
  branchId: string | undefined,
): Promise<Branch> {
  if (!branchId) return requireDefaultBranch(db);

  const branch = await db.branch.findFirst({ where: { id: branchId, isActive: true } });
  if (!branch) throw notFound('BRANCH_NOT_FOUND', 'ไม่พบสาขานี้ หรือสาขาถูกปิดใช้งาน');
  return branch;
}

/**
 * The branch to check a PIN against when the client did not name one.
 *
 * A staff id belongs to exactly one branch, so this is not a guess. It exists
 * for the tablet that was installed while the shop had one branch and is still
 * running that cached build the week a second one opens: without it, everyone
 * at the new branch is told "PIN ไม่ถูกต้อง" by a screen that is not wrong
 * about the PIN.
 *
 * An unknown staff id falls back to the default branch rather than throwing,
 * so a bad id fails as a 401 from the PIN check like every other bad id. A 404
 * here would answer "does this staff id exist" to anyone who asks.
 */
export async function resolveLoginBranchForStaff(
  db: PrismaClient,
  staffId: string,
): Promise<Branch> {
  const staff = await db.staff.findFirst({
    where: { id: staffId, status: { not: StaffStatus.LEFT }, branch: { isActive: true } },
    select: { branch: true },
  });
  return staff?.branch ?? requireDefaultBranch(db);
}

/** The branch the session belongs to. Falls back to a 404 if it was deactivated. */
export async function requireSessionBranch(db: PrismaClient, branchId: string): Promise<Branch> {
  const branch = await db.branch.findFirst({ where: { id: branchId, isActive: true } });
  if (!branch) {
    throw notFound('BRANCH_NOT_FOUND', 'ไม่พบสาขาของผู้ใช้นี้ หรือสาขาถูกปิดใช้งาน');
  }
  return branch;
}
