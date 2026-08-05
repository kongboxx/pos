/**
 * PromptPay QR payload.
 *
 * Thai customers pay by scanning, so the till has to draw a QR that any bank
 * app accepts. The format is EMVCo "Merchant Presented QR" with the Thai
 * PromptPay application id inside — a flat list of (tag, length, value)
 * triplets, ASCII, ending in a CRC.
 *
 * Two details are the whole reason this file exists rather than a library:
 *
 *  1. The amount is written as a DECIMAL STRING ("235.00"), which is the only
 *     place in this codebase where money leaves integer satang. It is built by
 *     integer division here, never by dividing a float, so 23500 satang can
 *     never become "234.99999999999997".
 *  2. The CRC is computed over the payload INCLUDING the "6304" header of the
 *     CRC field itself. Getting that wrong produces a QR that scans and then
 *     fails inside the bank app, which is far worse than one that does not
 *     scan at all.
 *
 * Nothing here talks to a bank. The slip still has to be confirmed by a human
 * (see Step 2 notes) — automatic verification needs a bank API and is not part
 * of this system yet.
 */

import { assertSatang, SATANG_PER_BAHT, type Satang } from './money.js';

/** Application id that tells the bank app this is a PromptPay transfer. */
const PROMPTPAY_AID = 'A000000677010111';

const TAG_PAYLOAD_FORMAT = '00';
const TAG_POINT_OF_INITIATION = '01';
const TAG_MERCHANT_ACCOUNT = '29';
const TAG_CURRENCY = '53';
const TAG_AMOUNT = '54';
const TAG_COUNTRY = '58';
const TAG_CRC = '63';

/** ISO 4217 numeric code for Thai baht. */
const CURRENCY_THB = '764';
const COUNTRY_TH = 'TH';

/** 11 = reusable (no amount), 12 = single use (amount fixed). */
const POI_STATIC = '11';
const POI_DYNAMIC = '12';

export type PromptPayTargetType = 'MOBILE' | 'NATIONAL_ID' | 'EWALLET';

export interface PromptPayTarget {
  type: PromptPayTargetType;
  /** The value exactly as it goes into the QR, already normalised. */
  value: string;
}

/**
 * Works out what kind of PromptPay id was typed and normalises it.
 *
 * Accepts the shapes an owner actually types:
 *   "081-234-5678", "0812345678", "+66 81 234 5678" -> mobile
 *   "1103700123456"                                 -> national id (13 digits)
 *   "004999012345678"                               -> e-wallet (15 digits)
 *
 * Returns null instead of throwing, because this runs on whatever is in the
 * branch settings field and a bad value must show as "PromptPay ยังตั้งค่าไม่ถูก"
 * rather than crash the payment screen.
 */
export function parsePromptPayId(input: string): PromptPayTarget | null {
  const digits = input.replace(/\D/g, '');

  // Mobile: stored as 13 chars, zero-padded, with country code 66 and the
  // national leading zero removed. 0812345678 -> 0066812345678
  if (digits.length === 10 && digits.startsWith('0')) {
    return { type: 'MOBILE', value: `0066${digits.slice(1)}` };
  }
  if (digits.length === 11 && digits.startsWith('66')) {
    return { type: 'MOBILE', value: `0066${digits.slice(2)}` };
  }
  if (digits.length === 13) {
    return { type: 'NATIONAL_ID', value: digits };
  }
  if (digits.length === 15) {
    return { type: 'EWALLET', value: digits };
  }
  return null;
}

/** Sub-tag inside the merchant account field, one per id type. */
const TARGET_SUBTAG: Readonly<Record<PromptPayTargetType, string>> = {
  MOBILE: '01',
  NATIONAL_ID: '02',
  EWALLET: '03',
};

export interface PromptPayPayloadInput {
  /** The shop's PromptPay id, in any of the shapes parsePromptPayId accepts. */
  promptPayId: string;
  /**
   * Amount to lock into the QR. Omit for a reusable QR the customer types the
   * amount into — a till always passes it, so the customer cannot mistype.
   */
  amountSatang?: Satang | null;
}

/**
 * Builds the string that goes inside the QR image.
 * Throws when the id cannot be parsed — the caller checks with
 * parsePromptPayId first and shows a settings error instead.
 */
export function buildPromptPayPayload(input: PromptPayPayloadInput): string {
  const target = parsePromptPayId(input.promptPayId);
  if (!target) {
    throw new RangeError(`ไม่รู้จักรูปแบบพร้อมเพย์: "${input.promptPayId}"`);
  }

  const hasAmount = input.amountSatang !== undefined && input.amountSatang !== null;
  if (hasAmount) {
    assertSatang(input.amountSatang as number, 'promptpay amount');
    if ((input.amountSatang as number) <= 0) {
      throw new RangeError('ยอดพร้อมเพย์ต้องมากกว่า 0');
    }
  }

  const merchantAccount =
    field('00', PROMPTPAY_AID) + field(TARGET_SUBTAG[target.type], target.value);

  const body =
    field(TAG_PAYLOAD_FORMAT, '01') +
    field(TAG_POINT_OF_INITIATION, hasAmount ? POI_DYNAMIC : POI_STATIC) +
    field(TAG_MERCHANT_ACCOUNT, merchantAccount) +
    field(TAG_CURRENCY, CURRENCY_THB) +
    (hasAmount ? field(TAG_AMOUNT, formatAmountForQr(input.amountSatang as Satang)) : '') +
    field(TAG_COUNTRY, COUNTRY_TH);

  // The CRC covers everything up to and including "6304".
  const withCrcHeader = `${body}${TAG_CRC}04`;
  return `${withCrcHeader}${crc16(withCrcHeader)}`;
}

/**
 * Satang -> "235.00" using integer arithmetic only.
 *
 * Deliberately not `(satang / 100).toFixed(2)`: that goes through a float and
 * is the exact shape of bug rule #2 exists to prevent.
 */
export function formatAmountForQr(amountSatang: Satang): string {
  assertSatang(amountSatang, 'promptpay amount');
  if (amountSatang < 0) throw new RangeError('ยอดพร้อมเพย์ต้องไม่ติดลบ');
  const baht = Math.trunc(amountSatang / SATANG_PER_BAHT);
  const satang = amountSatang % SATANG_PER_BAHT;
  return `${baht}.${String(satang).padStart(2, '0')}`;
}

/** One EMVCo triplet: 2-digit tag, 2-digit length, value. */
function field(tag: string, value: string): string {
  if (value.length > 99) {
    throw new RangeError(`EMVCo field ${tag} is too long (${value.length} chars)`);
  }
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no input/output reflection,
 * no final xor. Returned as 4 uppercase hex digits.
 *
 * `>>> 0` keeps the running value unsigned — without it the shift turns the
 * accumulator negative once bit 15 is set and every checksum after that is
 * wrong.
 */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
