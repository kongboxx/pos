/**
 * Thai-aware text measurement and layout for fixed-width receipts.
 *
 * WHY THIS FILE EXISTS
 *
 * A thermal printer lays characters out in a fixed grid — an 80mm printer in
 * Font A gives 48 cells per line. To right-align a price you pad the left side
 * to (width - price.length) cells.
 *
 * With Thai text `String.length` is the WRONG number. Thai vowels and tone
 * marks that sit above or below the base consonant occupy no horizontal cell
 * on the printer, but each counts as 1 in JavaScript:
 *
 *   'ก๋วยเตี๋ยวหมู'.length === 13   but it prints in 10 cells
 *
 * Using .length means every column on the receipt is pushed right by the
 * number of tone marks in the item name — so no two rows line up and the
 * totals column zig-zags down the page. It is the single most common bug in
 * Thai receipt printing, and it cannot be fixed later without re-testing every
 * template, so the measurement lives here and everything else uses it.
 *
 * Zero-width ranges (Thai block U+0E00–U+0E7F):
 *   U+0E31          ั          above vowel
 *   U+0E34–U+0E37   ิ ี ึ ื    above vowels
 *   U+0E38–U+0E3A   ุ ู ฺ      below vowels
 *   U+0E47–U+0E4E   ็ ่ ้ ๊ ๋ ์ ํ ๎  tone marks and diacritics
 *
 * Everything else in the block — including the leading vowels เ แ โ ใ ไ and
 * the composite ำ — takes a full cell.
 */

/** Code points that render on top of / below the previous cell. */
function isZeroWidth(codePoint: number): boolean {
  return (
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    // Generic combining marks, in case a name is pasted in from elsewhere.
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x200b // zero-width space
  );
}

/** How many printer cells a string occupies. Use this, never `.length`. */
export function thaiWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (!isZeroWidth(codePoint)) width += 1;
  }
  return width;
}

/**
 * Cuts a string to at most `maxWidth` printer cells.
 *
 * A tone mark is never separated from the consonant it sits on: if the cut
 * would land between them, both stay or both go.
 */
export function truncateThai(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (thaiWidth(text) <= maxWidth) return text;

  let width = 0;
  let result = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    const charWidth = isZeroWidth(codePoint) ? 0 : 1;
    if (width + charWidth > maxWidth) break;
    width += charWidth;
    result += char;
  }
  return result;
}

export type Align = 'left' | 'right' | 'center';

/** Pads (or truncates) a string to exactly `width` printer cells. */
export function padThai(text: string, width: number, align: Align = 'left'): string {
  const clipped = truncateThai(text, width);
  const padding = width - thaiWidth(clipped);
  if (padding <= 0) return clipped;

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + clipped;
    case 'center': {
      const left = Math.floor(padding / 2);
      return ' '.repeat(left) + clipped + ' '.repeat(padding - left);
    }
    case 'left':
      return clipped + ' '.repeat(padding);
  }
}

/**
 * Two columns on one line: label on the left, value hard against the right
 * edge. The label is truncated if the two would collide — the value (a price)
 * is never sacrificed.
 */
export function leftRight(left: string, right: string, width: number): string {
  const rightWidth = thaiWidth(right);
  if (rightWidth >= width) return truncateThai(right, width);
  const leftWidth = width - rightWidth;
  return padThai(left, leftWidth, 'left') + right;
}

/**
 * Wraps text to `width` cells, breaking on spaces when possible.
 *
 * Thai does not use spaces between words, so a long Thai run has no break
 * opportunity and falls back to a hard character break — which is what a
 * receipt printer would do anyway, only now the break lands on a cell boundary
 * instead of mid-glyph.
 */
export function wrapThai(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    let remaining = paragraph;
    while (thaiWidth(remaining) > width) {
      const candidate = truncateThai(remaining, width);
      // Prefer a space break, but only if it does not waste half the line.
      const lastSpace = candidate.lastIndexOf(' ');
      const breakAt = lastSpace > width / 2 ? lastSpace : candidate.length;
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

/** A full-width rule, e.g. `repeatToWidth('-', 48)`. */
export function repeatToWidth(char: string, width: number): string {
  if (thaiWidth(char) !== 1) throw new RangeError(`rule character must be 1 cell wide: "${char}"`);
  return char.repeat(Math.max(0, width));
}
