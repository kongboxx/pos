/**
 * Turns environment variables into the description of a brand-new shop.
 *
 * This lives in src/ and has tests, rather than sitting inline in the seed,
 * because everything it decides is decided ONCE — on the afternoon the shop is
 * set up — and a mistake is invisible afterwards:
 *
 *   - the branch code is baked into every document number for the year and is
 *     frozen the moment the first receipt prints (rule #9), so a code that was
 *     quietly accepted with a space in it is a problem in December;
 *   - the owner's PIN is the only key to the till on day one, and a PIN this
 *     file accepted when it should not have is a till that opens too easily.
 *
 * Nothing here touches the database. It reads env, validates, and either
 * returns a shop or throws with every problem listed at once — being told
 * about the bad code and the bad PIN in one go beats finding out one per run.
 */

import { randomInt } from 'node:crypto';
import { PASSWORD_MIN_LENGTH } from '@pos/shared';

export interface NewShopOwner {
  fullName: string;
  nickname: string;
  pin: string;
  /** The username for office.<domain>. Unique across the whole staff table. */
  email: string;
  password: string;
}

export interface NewShop {
  name: string;
  branchCode: string;
  owner: NewShopOwner;
  /**
   * true when nobody supplied OWNER_PIN, so the seed has to print the PIN it
   * made up. A generated PIN that is never shown is a locked shop.
   */
  pinWasGenerated: boolean;
  /** Same, for the back office password. */
  passwordWasGenerated: boolean;
}

export const SHOP_DEFAULTS = {
  name: 'ร้านของฉัน',
  branchCode: 'HQ',
  ownerFullName: 'เจ้าของร้าน',
  /**
   * Deliberately not a real-looking address. It appears on the setup output
   * and has to read as "change this", not as an address that might belong to
   * a stranger who would then receive the shop's password reset one day.
   */
  ownerEmail: 'owner@localhost',
} as const;

const MAX_NAME = 80;
const MAX_NICKNAME = 40;

/**
 * A random 4-digit PIN.
 *
 * `crypto.randomInt`, not `Math.random`: this is the credential that opens the
 * till and prints the money reports. Padded so `0042` stays four digits — the
 * PIN is a string everywhere in this system for exactly that reason.
 */
export function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/**
 * Characters that survive being read off a terminal and typed into a browser.
 *
 * No 0/O, no 1/l/I. This string is shown exactly once, to someone who cannot
 * ask for it again, and "was that a one or an ell" is how a shop locks itself
 * out on setup day.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Long enough that nobody needs to think about whether it is long enough. */
const GENERATED_PASSWORD_LENGTH = 20;

/**
 * A random password for the back office.
 *
 * `randomInt`, not `Math.random`, for the same reason as the PIN: this opens
 * the screen with every wage and passport number in the shop on it.
 */
export function generatePassword(): string {
  let out = '';
  for (let index = 0; index < GENERATED_PASSWORD_LENGTH; index += 1) {
    out += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** Reads one variable, treating whitespace-only as absent. */
function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function resolveNewShop(
  env: NodeJS.ProcessEnv = process.env,
  makePin: () => string = generatePin,
  makePassword: () => string = generatePassword,
): NewShop {
  const problems: string[] = [];

  const name = read(env, 'SHOP_NAME') ?? SHOP_DEFAULTS.name;
  if (name.length > MAX_NAME) {
    problems.push(`SHOP_NAME ยาวเกิน ${MAX_NAME} ตัวอักษร`);
  }

  const branchCode = read(env, 'SHOP_CODE') ?? SHOP_DEFAULTS.branchCode;
  if (!/^[A-Za-z0-9]{1,8}$/.test(branchCode)) {
    problems.push(`SHOP_CODE ต้องเป็นตัวอักษรอังกฤษหรือตัวเลข 1-8 ตัว (ได้ "${branchCode}")`);
  }

  const fullName = read(env, 'OWNER_NAME') ?? SHOP_DEFAULTS.ownerFullName;
  if (fullName.length > MAX_NAME) {
    problems.push(`OWNER_NAME ยาวเกิน ${MAX_NAME} ตัวอักษร`);
  }

  // The nickname is what appears on the kitchen ticket and the shift record,
  // so it falls back to the full name rather than to nothing.
  const nickname = read(env, 'OWNER_NICKNAME') ?? fullName.slice(0, MAX_NICKNAME);
  if (nickname.length > MAX_NICKNAME) {
    problems.push(`OWNER_NICKNAME ยาวเกิน ${MAX_NICKNAME} ตัวอักษร`);
  }

  const typedPin = read(env, 'OWNER_PIN');
  if (typedPin !== undefined && !/^\d{4}$/.test(typedPin)) {
    // The PIN itself is not echoed back into the error — it goes to a terminal
    // that scrolls, into CI logs, into a screenshot someone sends for help.
    problems.push('OWNER_PIN ต้องเป็นตัวเลข 4 หลัก');
  }

  const email = read(env, 'OWNER_EMAIL')?.toLowerCase() ?? SHOP_DEFAULTS.ownerEmail;
  // Deliberately loose: one @, something either side, no spaces. A stricter
  // pattern here would reject valid addresses, and the only thing this field
  // does is identify one row — it is never posted to.
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    problems.push(`OWNER_EMAIL ต้องเป็นอีเมลที่ถูกต้อง (ได้ "${email}")`);
  }

  // NOT via read(): that trims, and a leading or trailing space is part of a
  // password. Only "absent" and "present but empty" collapse together here.
  const typedPassword = env['OWNER_PASSWORD'];
  const hasPassword = typedPassword !== undefined && typedPassword !== '';
  if (hasPassword && new TextEncoder().encode(typedPassword).length < PASSWORD_MIN_LENGTH) {
    // The password itself is never echoed back, exactly like the PIN above.
    problems.push(`OWNER_PASSWORD ต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`);
  }

  if (problems.length > 0) {
    throw new Error(`ตั้งค่าร้านไม่ถูกต้อง:\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  }

  return {
    name,
    branchCode,
    owner: {
      fullName,
      nickname,
      pin: typedPin ?? makePin(),
      email,
      password: hasPassword ? typedPassword : makePassword(),
    },
    pinWasGenerated: typedPin === undefined,
    passwordWasGenerated: !hasPassword,
  };
}
