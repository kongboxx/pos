/**
 * The customer-facing contract.
 *
 * What is tested here is what a customer or a script can send, and what the
 * shop is protected from — not the shape of the DTOs, which TypeScript already
 * checks. The endpoints behind these schemas need no login, so validation is
 * the only wall.
 */

import { describe, expect, it } from 'vitest';
import {
  approveQrLinesRequestSchema,
  MAX_QR_LINES_PER_SUBMIT,
  qrOrderUrl,
  qrSubmitRequestSchema,
  qrTokenSchema,
  QR_WAIT_LATE_SECONDS,
  qrWaitUrgency,
  secondsWaiting,
} from './qr-order.js';
import { calculateOrderTotal } from './order-total.js';

const VAT_OFF = { enabled: false, rateBp: 0, priceIncludesVat: true };

function line(id: string): { id: string; menuItemId: string; qty: number } {
  return { id, menuItemId: '11111111-1111-4111-8111-111111111111', qty: 1 };
}

describe('the token on the sticker', () => {
  it('accepts a base64url token and rejects anything with room for a path in it', () => {
    expect(qrTokenSchema.safeParse('AbCd1234_efGH-ij').success).toBe(true);
    // The token goes straight into a URL segment. A slash or a dot would let a
    // crafted sticker point at a different route entirely.
    expect(qrTokenSchema.safeParse('AbCd1234/efGH-ij').success).toBe(false);
    expect(qrTokenSchema.safeParse('../../etc/passwd').success).toBe(false);
    expect(qrTokenSchema.safeParse('short').success).toBe(false);
  });

  it('builds the sticker URL without doubling the slash', () => {
    expect(qrOrderUrl('http://192.168.1.20:5173', 'AbCd1234_efGH-ij')).toBe(
      'http://192.168.1.20:5173/t/AbCd1234_efGH-ij',
    );
    // The management screen reads window.location.origin, which sometimes has
    // a trailing slash depending on how it was built.
    expect(qrOrderUrl('http://shop.local/', 'AbCd1234_efGH-ij')).toBe(
      'http://shop.local/t/AbCd1234_efGH-ij',
    );
  });
});

describe('what one submission may carry', () => {
  it('refuses an empty order rather than opening a bill for nothing', () => {
    const result = qrSubmitRequestSchema.safeParse({ lines: [] });
    expect(result.success).toBe(false);
  });

  it('caps the number of lines, because this endpoint has no login', () => {
    const tooMany = Array.from({ length: MAX_QR_LINES_PER_SUBMIT + 1 }, (_, index) =>
      line(`0000000${index}-1111-4111-8111-111111111111`.slice(-36)),
    );
    expect(qrSubmitRequestSchema.safeParse({ lines: tooMany }).success).toBe(false);
  });

  it('defaults qty to 1 and still refuses 0 or a fraction', () => {
    const parsed = qrSubmitRequestSchema.parse({
      lines: [{ id: '22222222-2222-4222-8222-222222222222', menuItemId: line('x').menuItemId }],
    });
    expect(parsed.lines[0]?.qty).toBe(1);

    for (const qty of [0, -1, 1.5, 100]) {
      const result = qrSubmitRequestSchema.safeParse({
        lines: [{ ...line('22222222-2222-4222-8222-222222222222'), qty }],
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('approving', () => {
  it('sends the order to the kitchen unless the caller says otherwise', () => {
    const parsed = approveQrLinesRequestSchema.parse({
      lineIds: ['22222222-2222-4222-8222-222222222222'],
    });
    expect(parsed.fire).toBe(true);
  });

  it('will not approve nothing', () => {
    expect(approveQrLinesRequestSchema.safeParse({ lineIds: [] }).success).toBe(false);
  });
});

describe('a pending line is not money', () => {
  it('is left out of the bill total until a member of staff agrees to it', () => {
    const pending = {
      nameSnapshot: 'ก๋วยเตี๋ยวหมู',
      qty: 1,
      unitPriceSatang: 5000,
      unitCostSatang: 2000,
      awaitingApproval: true,
    };
    const confirmed = { ...pending, awaitingApproval: false };

    expect(calculateOrderTotal([pending], VAT_OFF).totalSatang).toBe(0);
    expect(calculateOrderTotal([pending], VAT_OFF).lineCount).toBe(0);
    // ...and the cost too, or the profit report would count a bowl nobody cooked.
    expect(calculateOrderTotal([pending], VAT_OFF).costSatang).toBe(0);

    expect(calculateOrderTotal([confirmed], VAT_OFF).totalSatang).toBe(5000);
    expect(calculateOrderTotal([pending, confirmed], VAT_OFF).totalSatang).toBe(5000);
  });
});

describe('how long the customer has been waiting', () => {
  it('counts in seconds, not minutes — a minute of silence is already too long', () => {
    const now = new Date('2026-07-30T12:00:00Z');
    expect(secondsWaiting('2026-07-30T11:59:15Z', now)).toBe(45);
    // A clock that is slightly ahead must not produce a negative wait.
    expect(secondsWaiting('2026-07-30T12:00:30Z', now)).toBe(0);
  });

  it('turns red at three minutes, which is when the customer gives up on it', () => {
    const now = new Date('2026-07-30T12:00:00Z');
    const ago = (seconds: number): string => new Date(now.getTime() - seconds * 1000).toISOString();

    expect(qrWaitUrgency(ago(10), now)).toBe('fresh');
    expect(qrWaitUrgency(ago(90), now)).toBe('warn');
    expect(qrWaitUrgency(ago(QR_WAIT_LATE_SECONDS), now)).toBe('late');
  });
});
