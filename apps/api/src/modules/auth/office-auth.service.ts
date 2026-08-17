/**
 * Email and password, for office.<domain>.
 *
 * The till keeps its PIN and this does not touch it. The two doors want
 * different things: a cashier hands the tablet to the next cashier twenty
 * times a shift and a long password on a screen by the till ends up on paper
 * taped to the monitor, which is worse than four digits behind a lockout. An
 * owner signs in once a day, from anywhere on the internet, to a screen that
 * shows every wage and every passport number in the shop.
 *
 * There is no staff list here and there must never be one. Picking your name
 * from a list is what makes the PIN flow work on a tablet; on a page anyone
 * can reach it is a directory of who works here and who the owner is.
 */

import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import {
  MAX_PASSWORD_ATTEMPTS,
  PASSWORD_LOCKOUT_MS,
  StaffStatus,
  type SessionUser,
} from '@pos/shared';

/**
 * Cost 12, up from the PIN's 10.
 *
 * ~0.6-1.2s on this hardware, which is invisible on a login that happens once
 * a day and expensive for anyone working through a list offline. Not argon2id,
 * though it is stronger: bcryptjs is pure JS with no build step, and argon2
 * would add a native dependency to install on a VPS for a gain that does not
 * matter at one login a day. Recorded as the upgrade path if that changes.
 */
export const PASSWORD_SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
}

export type OfficeLoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'BAD_CREDENTIALS' }
  | { ok: false; reason: 'LOCKED'; lockedUntil: Date; staffId: string; branchId: string };

/**
 * A real bcrypt hash of a string nobody knows, compared against when there is
 * no account to compare against.
 *
 * Without it, "no such email" returns in a millisecond and "wrong password"
 * returns in a second, and the difference tells anyone with a stopwatch which
 * addresses exist. Generated once from 32 random bytes and pasted here rather
 * than computed at boot, so the cost is paid by whoever wrote this file and
 * not by every start. Nobody knows the input and nothing can be logged in with.
 */
const ABSENT_ACCOUNT_HASH = '$2a$12$n0iQLMU2o.NrqZFfsCg2v.POl7pGYB.ga8lyqI8Bn2E0djjLPi2zq';

export class OfficeAuthService {
  constructor(private readonly db: PrismaClient) {}

  async login(email: string, password: string, now: Date = new Date()): Promise<OfficeLoginResult> {
    const staff = await this.db.staff.findUnique({ where: { email } });

    // Three different ways to have no account here — unknown address, no
    // password set, left the shop — and they all have to look identical from
    // the outside, in wall-clock time as well as in the response.
    const usable =
      staff !== null && staff.passwordHash !== null && staff.status !== StaffStatus.LEFT;

    if (!usable) {
      await bcrypt.compare(password, ABSENT_ACCOUNT_HASH);
      return { ok: false, reason: 'BAD_CREDENTIALS' };
    }

    if (staff.loginLockedUntil && staff.loginLockedUntil > now) {
      // Do not even hash: a frozen account must cost an attacker a wait, not a
      // CPU cycle they can measure.
      return {
        ok: false,
        reason: 'LOCKED',
        lockedUntil: staff.loginLockedUntil,
        staffId: staff.id,
        branchId: staff.branchId,
      };
    }

    const matches = await bcrypt.compare(password, staff.passwordHash as string);

    if (!matches) {
      const attempts = staff.failedLoginAttempts + 1;
      const shouldLock = attempts >= MAX_PASSWORD_ATTEMPTS;
      const lockedUntil = shouldLock ? new Date(now.getTime() + PASSWORD_LOCKOUT_MS) : null;

      await this.db.staff.update({
        where: { id: staff.id },
        // The counter resets when the lock is set, so the wait buys a fresh
        // allowance rather than one attempt per lockout forever.
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          loginLockedUntil: lockedUntil,
        },
      });

      if (lockedUntil) {
        return {
          ok: false,
          reason: 'LOCKED',
          lockedUntil,
          staffId: staff.id,
          branchId: staff.branchId,
        };
      }
      // No attemptsLeft in the answer, unlike the PIN login. There the count is
      // shown to a cashier who mistyped on a keypad; here it would tell a bot
      // exactly how much budget it has left.
      return { ok: false, reason: 'BAD_CREDENTIALS' };
    }

    await this.db.staff.update({
      where: { id: staff.id },
      // Only the password counters. The PIN lockout is a separate fact about a
      // separate door and must not be cleared by getting in through this one.
      data: { failedLoginAttempts: 0, loginLockedUntil: null, lastLoginAt: now },
    });

    return {
      ok: true,
      user: {
        staffId: staff.id,
        branchId: staff.branchId,
        role: staff.role,
        fullName: staff.fullName,
        nickname: staff.nickname,
      },
    };
  }
}
