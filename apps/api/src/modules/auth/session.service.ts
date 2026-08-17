/**
 * The row behind every token.
 *
 * Before this existed, logging out cleared the cookie and nothing else — the
 * README said so plainly: "JWT ที่ถูกก๊อปไว้ก่อนหน้ายังใช้ได้จนหมดอายุ". On a
 * shop LAN that was a small gap. On the open internet it is the gap, so the
 * JWT now carries this row's id as `jti` and every request checks the row.
 *
 * The cost is one indexed lookup per request. A shop with twelve tables will
 * never feel it, and it buys four things at once: a logout that actually ends
 * the session, "sign out everywhere", cutting off someone who left today
 * instead of in twelve hours, and an owner who can see how many devices are
 * still holding a session.
 */

import { createHmac } from 'node:crypto';
import type { PrismaClient, SessionSurface } from '@prisma/client';

/**
 * How long a dead session is kept before it is deleted.
 *
 * Not zero, because "who was logged in on the night the drawer came up short"
 * is a question that gets asked weeks later and has no other source.
 */
export const SESSION_RETENTION_DAYS = 90;

export interface IssuedSession {
  id: string;
  expiresAt: Date;
}

export interface IssueInput {
  branchId: string;
  staffId: string;
  surface: SessionSurface;
  ttlSeconds: number;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export class SessionService {
  constructor(
    private readonly db: PrismaClient,
    /** Keys the IP hash. The JWT secret, so there is one secret to rotate. */
    private readonly secret: string,
  ) {}

  async issue(input: IssueInput, now: Date = new Date()): Promise<IssuedSession> {
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

    const row = await this.db.session.create({
      data: {
        branchId: input.branchId,
        staffId: input.staffId,
        surface: input.surface,
        createdAt: now,
        expiresAt,
        // Truncated: a user-agent is attacker-controlled and unbounded, and
        // this column exists to say "Safari on an iPad", not to store an essay.
        userAgent: input.userAgent?.slice(0, 255) ?? null,
        ipHash: input.ip ? this.hashIp(input.ip) : null,
      },
      select: { id: true, expiresAt: true },
    });

    return row;
  }

  /**
   * Whether this id still authorises a request.
   *
   * Answers false for anything it does not recognise — a forged jti, a deleted
   * row, a string that is not a uuid at all. This runs on EVERY request, so
   * throwing here would turn a malformed cookie into a 500 instead of a 401.
   */
  async isLive(id: string, now: Date = new Date()): Promise<boolean> {
    if (!UUID.test(id)) return false;

    const row = await this.db.session.findUnique({
      where: { id },
      select: { expiresAt: true, revokedAt: true },
    });
    if (!row) return false;

    return row.revokedAt === null && row.expiresAt > now;
  }

  /**
   * Ends one session.
   *
   * `revokedAt: null` in the filter is what makes this idempotent: revoking
   * twice keeps the FIRST time, because the moment the session stopped being
   * valid is the fact worth keeping, not the moment someone asked again.
   */
  async revoke(id: string, now: Date = new Date()): Promise<void> {
    if (!UUID.test(id)) return;
    await this.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Ends every live session this person has. Returns how many actually died. */
  async revokeAllFor(staffId: string, now: Date = new Date()): Promise<number> {
    const result = await this.db.session.updateMany({
      where: { staffId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count;
  }

  /** Deletes sessions that expired longer ago than the retention window. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    return result.count;
  }

  /**
   * HMAC, not a bare digest.
   *
   * sha256 of an IPv4 address is not anonymisation — there are only four
   * billion of them, and building the whole reverse table takes minutes on a
   * laptop. Keyed with a secret, the digest still compares equal for the same
   * address (which is the entire point of storing it) but cannot be walked
   * backwards by anyone who does not already have the key.
   */
  private hashIp(ip: string): string {
    return createHmac('sha256', this.secret).update(ip).digest('hex');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
