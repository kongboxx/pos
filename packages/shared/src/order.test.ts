/**
 * The hand-typed note.
 *
 * It is one short string, and every mistake it can make is a mistake somebody
 * only finds out about at the pass: a blank that prints an empty `*` line, two
 * different instructions merged into one row, or the same instruction typed
 * with a stray space refusing to merge and going to the kitchen twice.
 */

import { describe, expect, it } from 'vitest';
import { addOrderLineRequestSchema, MAX_ORDER_NOTE, normalizeNote, sameNote } from './order.js';

describe('normalizeNote', () => {
  it('turns blank and whitespace into no note at all', () => {
    // A cashier who opens the box, thinks better of it and leaves a space
    // behind must not put a bare `*` on the customer's receipt.
    expect(normalizeNote('')).toBeNull();
    expect(normalizeNote('   ')).toBeNull();
    expect(normalizeNote(null)).toBeNull();
    expect(normalizeNote(undefined)).toBeNull();
  });

  it('trims the edges but leaves the words alone', () => {
    expect(normalizeNote('  เผ็ดน้อย ')).toBe('เผ็ดน้อย');
    expect(normalizeNote('ไม่ใส่ผักชี ไม่เผ็ด')).toBe('ไม่ใส่ผักชี ไม่เผ็ด');
  });

  it('caps a note that would swallow the kitchen slip', () => {
    expect(normalizeNote('ก'.repeat(500))).toHaveLength(MAX_ORDER_NOTE);
  });
});

describe('sameNote', () => {
  it('treats blank, spaces and null as the same nothing', () => {
    expect(sameNote(null, '')).toBe(true);
    expect(sameNote(undefined, '  ')).toBe(true);
  });

  it('ignores a stray space around the same instruction', () => {
    // Otherwise "เผ็ดน้อย" and "เผ็ดน้อย " become two rows on the bill and two
    // bowls the kitchen has to guess about.
    expect(sameNote('เผ็ดน้อย', ' เผ็ดน้อย')).toBe(true);
  });

  it('keeps two different instructions apart', () => {
    expect(sameNote('เผ็ดน้อย', 'เผ็ดมาก')).toBe(false);
    expect(sameNote(null, 'เผ็ดน้อย')).toBe(false);
  });
});

describe('the wire', () => {
  it('normalises on the way in, so the server stores one shape', () => {
    const parsed = addOrderLineRequestSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      menuItemId: '22222222-2222-4222-8222-222222222222',
      qty: 1,
      note: '   ',
    });
    expect(parsed.note).toBeNull();
  });

  it('refuses a note longer than the cap rather than silently cutting it', () => {
    // Cutting a note the CLIENT sent would be a different order than the one
    // the cashier read back to the customer. The trim above is for whitespace.
    const result = addOrderLineRequestSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      menuItemId: '22222222-2222-4222-8222-222222222222',
      qty: 1,
      note: 'ก'.repeat(MAX_ORDER_NOTE + 1),
    });
    expect(result.success).toBe(false);
  });
});
