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

/* ------------------------------------------------------------------ */
/* the back office door (plan 2)                                       */
/* ------------------------------------------------------------------ */

/**
 * Length, and only length.
 *
 * No rule about capitals or symbols, on purpose and following NIST: those
 * rules do not add entropy, they add Passw0rd! — a password that satisfies
 * every requirement and sits on every cracking list.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * bcrypt hashes the first 72 BYTES of its input and silently ignores whatever
 * follows. Accepting more would let someone set a 200-character password,
 * believe it is a 200-character password, and have the last 128 characters
 * count for nothing. Bytes, not characters: a Thai character is three of them,
 * so this is 24 Thai characters and 72 ASCII ones.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Wrong passwords allowed before the account freezes.
 *
 * Looser than the PIN's five, deliberately. A 12-character password is not
 * brute-forced in ten guesses or in ten million, so a tight lockout here buys
 * almost no protection — while handing anyone who knows the owner's email a
 * way to lock them out of their own accounts on payroll day. The per-IP limit
 * in the route is what actually holds; this is the backstop behind it.
 */
export const MAX_PASSWORD_ATTEMPTS = 10;
export const PASSWORD_LOCKOUT_MS = 15 * 60 * 1000;

/** Lowercased and trimmed, so the unique index means what a human means. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('อีเมลไม่ถูกต้อง')
  .max(160, 'อีเมลยาวเกินไป');

/**
 * How many bytes this string is once encoded as UTF-8.
 *
 * Counted by hand rather than with `TextEncoder`, which exists in both Node and
 * the browser but is declared in neither of the type libraries this package
 * compiles against (`lib: ["ES2022"]`, no DOM and no node types — see
 * tsconfig.base.json). Adding DOM for one class would hand a package that must
 * never touch the DOM the whole DOM.
 *
 * `for...of` over a string yields code points, not UTF-16 units, so an emoji
 * counts once at four bytes instead of twice at three.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * NOT trimmed. A leading or trailing space is part of the secret, and trimming
 * it would make a password that works in one client fail in another.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`)
  .refine(
    (value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES,
    `รหัสผ่านยาวเกินไป (ยาวได้ถึง ${PASSWORD_MAX_BYTES} ไบต์ — ภาษาไทยตัวละ 3 ไบต์)`,
  );

export const officeLoginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type OfficeLoginRequest = z.infer<typeof officeLoginRequestSchema>;
