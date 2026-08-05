import { describe, expect, it } from 'vitest';
import {
  defaultSelectionFor,
  formatModifierSummary,
  lineSignature,
  minSelectOf,
  selectedModifiersOf,
  selectionPriceDeltaSatang,
  validateSelection,
  type ModifierDto,
  type ModifierGroupDto,
} from './modifier.js';

/* ids are readable rather than real uuids — nothing here parses them. */
const modifier = (over: Partial<ModifierDto> & { id: string; name: string }): ModifierDto => ({
  priceDeltaSatang: 0,
  isDefault: false,
  isAvailable: true,
  ...over,
});

const NOODLE: ModifierGroupDto = {
  id: 'g-noodle',
  name: 'เส้น',
  isRequired: true,
  minSelect: 1,
  maxSelect: 1,
  isNegative: false,
  modifiers: [
    modifier({ id: 'm-small', name: 'เส้นเล็ก', isDefault: true }),
    modifier({ id: 'm-egg', name: 'บะหมี่' }),
    modifier({ id: 'm-glass', name: 'วุ้นเส้น', priceDeltaSatang: 500 }),
  ],
};

const SIZE: ModifierGroupDto = {
  id: 'g-size',
  name: 'ขนาด',
  isRequired: true,
  minSelect: 1,
  maxSelect: 1,
  isNegative: false,
  modifiers: [
    modifier({ id: 'm-normal', name: 'ธรรมดา', isDefault: true }),
    modifier({ id: 'm-large', name: 'พิเศษ', priceDeltaSatang: 1000 }),
  ],
};

const EXTRAS: ModifierGroupDto = {
  id: 'g-extra',
  name: 'เพิ่มเติม',
  isRequired: false,
  minSelect: 0,
  maxSelect: 2,
  isNegative: false,
  modifiers: [
    modifier({ id: 'm-ball', name: 'เพิ่มลูกชิ้น', priceDeltaSatang: 1000 }),
    modifier({ id: 'm-pork', name: 'เพิ่มหมู', priceDeltaSatang: 1500 }),
    modifier({ id: 'm-egg2', name: 'ไข่ต้ม', priceDeltaSatang: 1000, isAvailable: false }),
  ],
};

const REMOVALS: ModifierGroupDto = {
  id: 'g-no',
  name: 'ไม่ใส่',
  isRequired: false,
  minSelect: 0,
  maxSelect: 5,
  isNegative: true,
  modifiers: [modifier({ id: 'm-noveg', name: 'ไม่ผัก' })],
};

const GROUPS = [NOODLE, SIZE, EXTRAS, REMOVALS];

describe('minSelectOf', () => {
  it('treats "required" as at least one whatever minSelect says', () => {
    // A menu editor will eventually tick "บังคับเลือก" and leave minSelect at
    // 0. Required has to win, or a bowl ships with no noodles.
    expect(minSelectOf({ ...NOODLE, minSelect: 0 })).toBe(1);
    expect(minSelectOf({ ...NOODLE, isRequired: false, minSelect: 0 })).toBe(0);
    expect(minSelectOf({ ...EXTRAS, isRequired: true, minSelect: 2 })).toBe(2);
  });
});

describe('defaultSelectionFor', () => {
  it('preselects the common bowl so an ordinary order is open-and-confirm', () => {
    expect(defaultSelectionFor(GROUPS)).toEqual(['m-small', 'm-normal']);
  });

  it('produces a selection that validates', () => {
    // The whole fast path rests on this: if the defaults were ever illegal the
    // sheet would open with its confirm button already disabled.
    expect(validateSelection(GROUPS, defaultSelectionFor(GROUPS))).toBeNull();
  });

  it('skips a default that is sold out', () => {
    const soldOut: ModifierGroupDto = {
      ...NOODLE,
      modifiers: [
        modifier({ id: 'm-small', name: 'เส้นเล็ก', isDefault: true, isAvailable: false }),
        modifier({ id: 'm-egg', name: 'บะหมี่' }),
      ],
    };
    expect(defaultSelectionFor([soldOut])).toEqual([]);
  });
});

describe('validateSelection', () => {
  it('accepts a legal selection', () => {
    expect(validateSelection(GROUPS, ['m-egg', 'm-large', 'm-ball', 'm-noveg'])).toBeNull();
  });

  it('rejects a missing required group and names it', () => {
    const problem = validateSelection(GROUPS, ['m-normal']);
    expect(problem?.code).toBe('TOO_FEW');
    expect(problem?.groupId).toBe('g-noodle');
    // The message goes straight under the confirm button, so it has to say
    // which group — "เลือกไม่ครบ" would leave staff hunting.
    expect(problem?.message).toContain('เส้น');
  });

  it('rejects two picks in a single-select group', () => {
    const problem = validateSelection(GROUPS, ['m-small', 'm-egg', 'm-normal']);
    expect(problem?.code).toBe('TOO_MANY');
    expect(problem?.groupId).toBe('g-noodle');
  });

  it('rejects more than maxSelect in a multi-select group', () => {
    const problem = validateSelection(GROUPS, [
      'm-small',
      'm-normal',
      'm-ball',
      'm-pork',
      'm-noveg',
    ]);
    expect(problem).toBeNull();

    const tooMany = validateSelection([{ ...EXTRAS, maxSelect: 1 }], ['m-ball', 'm-pork']);
    expect(tooMany?.code).toBe('TOO_MANY');
    expect(tooMany?.message).toContain('1');
  });

  it('rejects a sold-out option by name', () => {
    const problem = validateSelection(GROUPS, ['m-small', 'm-normal', 'm-egg2']);
    expect(problem?.code).toBe('MODIFIER_UNAVAILABLE');
    expect(problem?.message).toContain('ไข่ต้ม');
  });

  it('rejects an option that belongs to another item', () => {
    // This is the tampered-client case, and the reason the API validates at all
    // instead of trusting the sheet that just ran the same function.
    const problem = validateSelection(GROUPS, ['m-small', 'm-normal', 'm-from-another-menu']);
    expect(problem?.code).toBe('UNKNOWN_MODIFIER');
  });

  it('rejects the same option sent twice', () => {
    // Otherwise a double-tap would charge for two "พิเศษ" on one bowl.
    const problem = validateSelection(GROUPS, ['m-small', 'm-normal', 'm-ball', 'm-ball']);
    expect(problem?.code).toBe('DUPLICATE_MODIFIER');
  });

  it('accepts anything for an item with no groups', () => {
    expect(validateSelection([], [])).toBeNull();
  });
});

describe('selectedModifiersOf', () => {
  it('returns group order, not the order they were tapped', () => {
    // The kitchen reads these at 1.5m; a stable order is what makes two
    // identical bowls look identical on paper.
    const tappedBackwards = selectedModifiersOf(GROUPS, ['m-noveg', 'm-large', 'm-egg']);
    expect(tappedBackwards.map((m) => m.name)).toEqual(['บะหมี่', 'พิเศษ', 'ไม่ผัก']);
  });
});

describe('selectionPriceDeltaSatang', () => {
  it('sums deltas as integers', () => {
    expect(selectionPriceDeltaSatang(GROUPS, ['m-glass', 'm-large', 'm-ball'])).toBe(2500);
    expect(selectionPriceDeltaSatang(GROUPS, ['m-small', 'm-normal'])).toBe(0);
  });

  it('handles a negative delta', () => {
    const giveBack: ModifierGroupDto = {
      ...NOODLE,
      modifiers: [modifier({ id: 'm-nonoodle', name: 'เกาเหลา', priceDeltaSatang: -500 })],
    };
    expect(selectionPriceDeltaSatang([giveBack], ['m-nonoodle'])).toBe(-500);
  });
});

describe('formatModifierSummary', () => {
  it('joins with the separator the receipt renderer expects', () => {
    expect(formatModifierSummary(['เส้นเล็ก', 'น้ำตก'])).toBe('เส้นเล็ก · น้ำตก');
    expect(formatModifierSummary([])).toBe('');
  });
});

describe('lineSignature', () => {
  it('ignores the order options were tapped in', () => {
    expect(lineSignature('item', ['b', 'a'])).toBe(lineSignature('item', ['a', 'b']));
  });

  it('separates two bowls of the same dish with different options', () => {
    // Before Step 3 the till merged on menu item alone. Merging these two would
    // send the kitchen one ticket for two identical bowls — and one customer
    // would get the wrong noodles.
    expect(lineSignature('item', ['m-small'])).not.toBe(lineSignature('item', ['m-egg']));
  });

  it('separates lines with different notes', () => {
    expect(lineSignature('item', ['a'], 'เผ็ดน้อย')).not.toBe(lineSignature('item', ['a']));
    expect(lineSignature('item', ['a'], null)).toBe(lineSignature('item', ['a']));
  });
});
