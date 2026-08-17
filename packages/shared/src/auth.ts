/**
 * Session shapes shared by the API and the PWA.
 *
 * How login works, and why:
 *
 * The staff list is shown first, then the PIN. That is not just nicer on a
 * tablet — it means the server hashes ONE candidate instead of every staff
 * row. bcrypt is deliberately slow (~100ms), so "try the PIN against everyone"
 * would take a second per attempt with ten staff and get worse as the shop
 * hires.
 *
 * A 4-digit PIN is only 10,000 combinations, so the lockout in the API is not
 * optional decoration: it is the thing that makes a 4-digit secret acceptable.
 */

import { z } from 'zod';
import { Permission } from './permissions.js';
import { pinSchema, roleSchema, uuidSchema } from './schemas.js';

/** How long a till session lasts. One long shift, so nobody re-logs in mid-service. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * How long a back office session lasts.
 *
 * Shorter than the till's on purpose. A cashier who is signed out mid-service
 * is a queue at the counter; an owner who is signed out is one password on a
 * machine that is not a tablet bolted to a counter — and this session can read
 * every wage in the shop from anywhere on the internet.
 */
export const OFFICE_SESSION_TTL_SECONDS = 8 * 60 * 60;

export const SESSION_COOKIE_NAME = 'pos_session';

/**
 * A DIFFERENT cookie for the back office, not the same name on another host.
 *
 * Cookies ignore the port. In dev the till is localhost:5173 and the office is
 * localhost:5174, which is one cookie jar — one name would mean logging into
 * the office kicks the till out, and back, all day. In production the hosts
 * differ so it would work either way, and it is still worth having: an office
 * cookie that cannot be presented as a till cookie is the split being true in
 * the browser rather than only in the design.
 */
export const OFFICE_SESSION_COOKIE_NAME = 'office_session';

/** Wrong PINs allowed before the account is frozen. */
export const MAX_PIN_ATTEMPTS = 5;
/** How long the freeze lasts. Long enough to kill brute force, short enough
 *  that a tired cashier is not locked out for the rest of the night. */
export const PIN_LOCKOUT_MS = 5 * 60 * 1000;

/** A staff member as shown on the login screen. Contains no secret. */
export const staffPublicSchema = z.object({
  id: uuidSchema,
  fullName: z.string(),
  nickname: z.string().nullable(),
  role: roleSchema,
});
export type StaffPublic = z.infer<typeof staffPublicSchema>;

export const loginRequestSchema = z.object({
  /**
   * Which shop (Step 10). Optional so a single-branch till keeps working
   * unchanged, and so it stays the SERVER that decides: the staff id already
   * belongs to exactly one branch, and login refuses when the two disagree
   * rather than trusting the body. Sending it is how a two-branch login screen
   * says "I meant this shop's สมชาย, not that one's".
   */
  branchId: uuidSchema.optional(),
  staffId: uuidSchema,
  pin: pinSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * What the JWT carries and what /auth/me returns.
 *
 * branchId is in the token on purpose: every query in the API is scoped by it
 * (rule #1), and taking it from the token rather than from the request body
 * means a tablet cannot ask for another branch's data by editing a parameter.
 */
export const sessionUserSchema = z.object({
  staffId: uuidSchema,
  branchId: uuidSchema,
  role: roleSchema,
  fullName: z.string(),
  nickname: z.string().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const meResponseSchema = z.object({
  user: sessionUserSchema,
  /** Resolved from the role so the UI never re-implements the matrix. */
  permissions: z.array(z.nativeEnum(Permission)),
  branch: z.object({
    id: uuidSchema,
    name: z.string(),
    branchCode: z.string(),
    businessType: z.string(),

    /**
     * Everything the tablet needs to total a bill BY ITSELF (Step 4).
     *
     * While the connection is down the till still has to show a running total
     * and read it to the customer, so it runs the same calculateOrderTotal the
     * server runs. Handing it the branch's actual VAT settings — rather than
     * letting it assume 0% — is what stops the offline total and the total the
     * server recomputes on sync from disagreeing the day VAT is switched on.
     */
    vatEnabled: z.boolean(),
    vatRateBp: z.number().int().min(0),
    priceIncludesVat: z.boolean(),
    /**
     * The day VAT starts applying (Step 10), null when it applies from the
     * beginning. Sent for the same offline reason as the rest: a tablet that
     * knew only `vatEnabled` would start charging VAT the moment the owner set
     * the switch — including on the bill open in front of it, dated two days
     * before registration takes effect.
     */
    vatEffectiveDate: z.string().nullable(),

    /** Same reason: which trading day a bill opened offline belongs to (rule #4). */
    timezone: z.string(),
    dayCutoffHour: z.number().int().min(0).max(23),

    promptPayConfigured: z.boolean(),
  }),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
