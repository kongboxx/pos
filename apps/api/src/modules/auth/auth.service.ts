/**
 * PIN login.
 *
 * The flow is: pick your name from a list, then type 4 digits. Picking first
 * means the server bcrypt-compares exactly ONE hash. The alternative ("try
 * this PIN against every staff row") costs ~100ms per employee per attempt and
 * quietly turns into a denial-of-service on the till as the shop hires people.
 *
 * A 4-digit PIN is 10,000 combinations, which is fine for stopping a colleague
 * and useless against a script. The lockout below is what closes that gap, so
 * treat it as part of the authentication, not as a nicety.
 */

import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import {
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MS,
  StaffStatus,
  type SessionUser,
  type StaffPublic,
} from '@pos/shared';

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'BAD_PIN'; attemptsLeft: number }
  | { ok: false; reason: 'LOCKED'; lockedUntil: Date }
  | { ok: false; reason: 'NOT_FOUND' };

export class AuthService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Who can log in at this branch.
   *
   * Returns names and roles only — never the hash, never the lock state. The
   * login screen is reachable without a session, so anything returned here is
   * effectively public on the shop wifi.
   */
  async listStaff(branchId: string): Promise<StaffPublic[]> {
    const rows = await this.db.staff.findMany({
      where: { branchId, status: { not: StaffStatus.LEFT } },
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
      select: { id: true, fullName: true, nickname: true, role: true },
    });
    return rows;
  }

  async login(branchId: string, staffId: string, pin: string): Promise<LoginResult> {
    const staff = await this.db.staff.findFirst({
      where: { id: staffId, branchId, status: { not: StaffStatus.LEFT } },
    });
    if (!staff) return { ok: false, reason: 'NOT_FOUND' };

    const now = new Date();
    if (staff.pinLockedUntil && staff.pinLockedUntil > now) {
      // Do not even hash: a locked account must cost an attacker a wait, not
      // a CPU cycle they can measure.
      return { ok: false, reason: 'LOCKED', lockedUntil: staff.pinLockedUntil };
    }

    const matches = await bcrypt.compare(pin, staff.pinHash);

    if (!matches) {
      const attempts = staff.failedPinAttempts + 1;
      const shouldLock = attempts >= MAX_PIN_ATTEMPTS;
      const lockedUntil = shouldLock ? new Date(now.getTime() + PIN_LOCKOUT_MS) : null;

      await this.db.staff.update({
        where: { id: staff.id },
        // The counter resets when the lock is set, so the wait buys a fresh
        // five tries rather than one attempt per lockout forever.
        data: { failedPinAttempts: shouldLock ? 0 : attempts, pinLockedUntil: lockedUntil },
      });

      if (lockedUntil) return { ok: false, reason: 'LOCKED', lockedUntil };
      return { ok: false, reason: 'BAD_PIN', attemptsLeft: MAX_PIN_ATTEMPTS - attempts };
    }

    await this.db.staff.update({
      where: { id: staff.id },
      data: { failedPinAttempts: 0, pinLockedUntil: null, lastLoginAt: now },
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
