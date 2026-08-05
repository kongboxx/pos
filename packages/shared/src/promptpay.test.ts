import { describe, expect, it } from 'vitest';
import { buildPromptPayPayload, crc16, formatAmountForQr, parsePromptPayId } from './promptpay.js';

describe('crc16', () => {
  /**
   * The published check value for CRC-16/CCITT-FALSE. If this one line is
   * wrong, every QR this system prints is scannable and then rejected by the
   * bank app — the worst possible failure mode, because it looks like it works.
   */
  it('matches the standard check vector', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('always returns four uppercase hex digits', () => {
    for (const input of ['', 'a', 'the quick brown fox', '0002010102']) {
      expect(crc16(input)).toMatch(/^[0-9A-F]{4}$/);
    }
  });
});

describe('parsePromptPayId', () => {
  it('normalises a mobile number typed any of the usual ways', () => {
    const expected = { type: 'MOBILE', value: '0066812345678' };
    expect(parsePromptPayId('0812345678')).toEqual(expected);
    expect(parsePromptPayId('081-234-5678')).toEqual(expected);
    expect(parsePromptPayId('+66 81 234 5678')).toEqual(expected);
    expect(parsePromptPayId('66812345678')).toEqual(expected);
  });

  it('recognises a 13-digit tax id and a 15-digit e-wallet', () => {
    expect(parsePromptPayId('1103700123456')).toEqual({
      type: 'NATIONAL_ID',
      value: '1103700123456',
    });
    expect(parsePromptPayId('004999012345678')).toEqual({
      type: 'EWALLET',
      value: '004999012345678',
    });
  });

  it('returns null rather than throwing on rubbish', () => {
    // The value comes from a settings field, so a bad one must show as a
    // disabled button, not a crashed payment screen.
    expect(parsePromptPayId('')).toBeNull();
    expect(parsePromptPayId('12345')).toBeNull();
    expect(parsePromptPayId('ไม่ใช่เบอร์')).toBeNull();
  });
});

describe('formatAmountForQr', () => {
  it('formats satang without ever touching a float', () => {
    expect(formatAmountForQr(23500)).toBe('235.00');
    expect(formatAmountForQr(6050)).toBe('60.50');
    expect(formatAmountForQr(5)).toBe('0.05');
    expect(formatAmountForQr(0)).toBe('0.00');
  });

  it('is exact for an amount that float division would mangle', () => {
    // 1000070 / 100 is 10000.699999999999 in IEEE 754.
    expect(formatAmountForQr(1_000_070)).toBe('10000.70');
  });

  it('refuses a non-integer amount', () => {
    expect(() => formatAmountForQr(60.5)).toThrow(TypeError);
  });
});

/**
 * Reads the payload back as {tag: value}.
 *
 * Asserting on a parsed structure rather than on substrings matters here: the
 * raw string is all digits, so `toContain('54')` would happily match the middle
 * of a phone number and pass for the wrong reason.
 */
function parseTlv(payload: string): [string, string][] {
  const fields: [string, string][] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const tag = payload.slice(cursor, cursor + 2);
    const length = Number(payload.slice(cursor + 2, cursor + 4));
    if (!Number.isInteger(length)) throw new Error(`bad length at ${cursor} in "${payload}"`);
    const value = payload.slice(cursor + 4, cursor + 4 + length);
    if (value.length !== length) throw new Error(`field ${tag} overruns the payload`);
    fields.push([tag, value]);
    cursor += 4 + length;
  }
  // Landing exactly on the end proves every declared length was correct.
  if (cursor !== payload.length) throw new Error('trailing bytes after the last field');
  return fields;
}

const valueOf = (fields: [string, string][], tag: string): string | undefined =>
  fields.find(([candidate]) => candidate === tag)?.[1];

describe('buildPromptPayPayload', () => {
  const payload = buildPromptPayPayload({ promptPayId: '0812345678', amountSatang: 23500 });
  const fields = parseTlv(payload);

  it('is a well-formed TLV string with no trailing junk', () => {
    // parseTlv throws on any overrun or leftover, so simply parsing is the
    // assertion. A field order check comes free: EMVCo requires 00 first.
    expect(fields[0]?.[0]).toBe('00');
    expect(fields.at(-1)?.[0]).toBe('63');
  });

  it('declares EMVCo v1 and marks the QR single-use when an amount is fixed', () => {
    expect(valueOf(fields, '00')).toBe('01');
    expect(valueOf(fields, '01')).toBe('12');
  });

  it('carries the PromptPay application id and the normalised mobile number', () => {
    expect(parseTlv(valueOf(fields, '29') as string)).toEqual([
      ['00', 'A000000677010111'],
      ['01', '0066812345678'],
    ]);
  });

  it('carries the amount, baht and Thailand', () => {
    expect(valueOf(fields, '54')).toBe('235.00');
    expect(valueOf(fields, '53')).toBe('764');
    expect(valueOf(fields, '58')).toBe('TH');
  });

  it('ends with a CRC computed over everything including the 6304 header', () => {
    const withoutChecksum = payload.slice(0, -4);
    expect(withoutChecksum.endsWith('6304')).toBe(true);
    expect(payload.slice(-4)).toBe(crc16(withoutChecksum));
  });

  it('omits the amount and marks the QR reusable when no amount is given', () => {
    const reusable = parseTlv(buildPromptPayPayload({ promptPayId: '0812345678' }));
    expect(valueOf(reusable, '01')).toBe('11');
    expect(valueOf(reusable, '54')).toBeUndefined();
  });

  it('produces a different checksum for a different amount', () => {
    // Guards against a copy-pasted constant checksum, which would scan fine
    // and pay the wrong shop nothing.
    const other = buildPromptPayPayload({ promptPayId: '0812345678', amountSatang: 23600 });
    expect(other.slice(-4)).not.toBe(payload.slice(-4));
  });

  it('refuses an id it cannot parse and a zero amount', () => {
    expect(() => buildPromptPayPayload({ promptPayId: 'nope', amountSatang: 100 })).toThrow();
    expect(() => buildPromptPayPayload({ promptPayId: '0812345678', amountSatang: 0 })).toThrow();
  });
});
