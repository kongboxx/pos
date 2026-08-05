import { describe, expect, it } from 'vitest';
import {
  leftRight,
  padThai,
  repeatToWidth,
  thaiWidth,
  truncateThai,
  wrapThai,
} from './thai-text.js';

describe('thaiWidth — the bug that misaligns every Thai receipt', () => {
  it('counts plain ASCII as one cell each', () => {
    expect(thaiWidth('Hello')).toBe(5);
    expect(thaiWidth('120.00')).toBe(6);
    expect(thaiWidth('')).toBe(0);
  });

  it('ignores tone marks and above/below vowels', () => {
    // ก ๋ ว ย เ ต ี ๋ ย ว ห ม ู
    //   ^     zero   ^ ^        ^  -> 4 of the 13 code points take no cell
    expect('ก๋วยเตี๋ยวหมู'.length).toBe(13);
    expect(thaiWidth('ก๋วยเตี๋ยวหมู')).toBe(9);
  });

  it.each([
    ['ั', 0x0e31],
    ['ิ', 0x0e34],
    ['ี', 0x0e35],
    ['ึ', 0x0e36],
    ['ื', 0x0e37],
    ['ุ', 0x0e38],
    ['ู', 0x0e39],
    ['่', 0x0e48],
    ['้', 0x0e49],
    ['๊', 0x0e4a],
    ['๋', 0x0e4b],
    ['็', 0x0e47],
    ['์', 0x0e4c],
  ])('treats %s (U+%s) as zero width', (mark) => {
    expect(thaiWidth(mark)).toBe(0);
  });

  it.each(['เ', 'แ', 'โ', 'ใ', 'ไ', 'ำ', 'า', 'ะ', 'ก', 'ฮ', '๙', '฿'])(
    'treats %s as a full cell',
    (char) => {
      expect(thaiWidth(char)).toBe(1);
    },
  );

  it('measures real menu names correctly', () => {
    expect(thaiWidth('น้ำเปล่า')).toBe(6);
    expect(thaiWidth('ก๋วยเตี๋ยวเนื้อ')).toBe(10);
    expect(thaiWidth('ชาดำเย็น')).toBe(7);
  });

  it('gives the same width to สระอำ however it was typed', () => {
    // Two encodings a customer or a menu import can produce for "นํ้า"/"น้ำ":
    //   U+0E33 (ำ)                vs   U+0E4D (ํ) + U+0E49 (้)
    // They look identical on paper and must measure identically, or the same
    // menu item imported twice would align differently on the receipt.
    const withSaraAm = 'น้ำเปล่า';
    const withNikhahit = 'นํ้าเปล่า';
    expect(withSaraAm.length).not.toBe(withNikhahit.length);
    expect(thaiWidth(withSaraAm)).toBe(thaiWidth(withNikhahit));
  });
});

describe('padThai', () => {
  it('pads ASCII to an exact cell count', () => {
    expect(padThai('abc', 6)).toBe('abc   ');
    expect(padThai('abc', 6, 'right')).toBe('   abc');
    expect(padThai('abc', 7, 'center')).toBe('  abc  ');
  });

  it('pads Thai by CELLS, not by string length', () => {
    const padded = padThai('ก๋วยเตี๋ยวหมู', 20);
    // 9 cells of text + 11 spaces = 20 cells on paper, but 24 JS characters.
    // Padding to .length instead would have produced a 20-char string that
    // prints only 16 cells wide, and the price column would shift left by 4.
    expect(thaiWidth(padded)).toBe(20);
    expect(padded.length).toBe(24);
  });

  it('truncates when the text is wider than the field', () => {
    expect(thaiWidth(padThai('ก๋วยเตี๋ยวรวมมิตรพิเศษ', 8))).toBe(8);
  });
});

describe('leftRight — the money column', () => {
  it('puts the value hard against the right edge', () => {
    const line = leftRight('รวม', '120.00', 24);
    expect(thaiWidth(line)).toBe(24);
    expect(line.endsWith('120.00')).toBe(true);
  });

  it('aligns two rows with different tone-mark counts to the same column', () => {
    const a = leftRight('ก๋วยเตี๋ยวหมู', '50.00', 32);
    const b = leftRight('นํ้าเปล่า', '10.00', 32);
    const c = leftRight('Coke', '20.00', 32);

    // Every row is exactly 32 cells, so the prices sit in the same columns.
    expect(thaiWidth(a)).toBe(32);
    expect(thaiWidth(b)).toBe(32);
    expect(thaiWidth(c)).toBe(32);

    // The naive .length approach would have produced three different lengths.
    expect(new Set([a.length, b.length, c.length]).size).toBeGreaterThan(1);
  });

  it('sacrifices the label, never the price, when they collide', () => {
    const line = leftRight('ก๋วยเตี๋ยวรวมมิตรพิเศษใส่ทุกอย่าง', '1,250.00', 20);
    expect(thaiWidth(line)).toBe(20);
    expect(line.endsWith('1,250.00')).toBe(true);
  });
});

describe('truncateThai', () => {
  it('never splits a tone mark from its consonant', () => {
    // Cutting 'ก๋วย' at 1 cell must yield 'ก๋' (consonant + its mark), not 'ก'.
    const cut = truncateThai('ก๋วย', 1);
    expect(thaiWidth(cut)).toBe(1);
    expect(cut).toBe('ก๋');
  });

  it('returns the input untouched when it already fits', () => {
    expect(truncateThai('abc', 10)).toBe('abc');
  });

  it('returns empty for a non-positive width', () => {
    expect(truncateThai('abc', 0)).toBe('');
  });
});

describe('wrapThai', () => {
  it('wraps ASCII on spaces', () => {
    expect(wrapThai('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
  });

  it('hard-breaks Thai, which has no inter-word spaces', () => {
    const lines = wrapThai('ก๋วยเตี๋ยวหมูน้ำตกพิเศษใส่ผักเยอะ', 10);
    for (const line of lines) {
      expect(thaiWidth(line)).toBeLessThanOrEqual(10);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it('preserves explicit newlines', () => {
    expect(wrapThai('a\nb', 10)).toEqual(['a', 'b']);
  });
});

describe('repeatToWidth', () => {
  it('draws a rule', () => {
    expect(repeatToWidth('-', 5)).toBe('-----');
  });

  it('rejects a multi-cell rule character', () => {
    expect(() => repeatToWidth('ab', 5)).toThrow(RangeError);
  });
});
