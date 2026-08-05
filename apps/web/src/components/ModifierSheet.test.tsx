/**
 * The option sheet.
 *
 * What is worth testing here is the behaviour a cashier feels at a counter,
 * not the markup: that the sheet opens on the usual bowl, that a single-select
 * group swaps rather than stacks, that the price on the confirm button is the
 * price the customer is about to be charged, and that an illegal bowl cannot
 * be confirmed and says why.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ORDER_NOTE, type ModifierDto, type ModifierGroupDto } from '@pos/shared';
import { ModifierSheet } from './ModifierSheet.js';

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

const EXTRAS: ModifierGroupDto = {
  id: 'g-extra',
  name: 'เพิ่มเติม',
  isRequired: false,
  minSelect: 0,
  maxSelect: 1,
  isNegative: false,
  modifiers: [
    modifier({ id: 'm-ball', name: 'เพิ่มลูกชิ้น', priceDeltaSatang: 1000 }),
    modifier({ id: 'm-egg2', name: 'ไข่ต้ม', priceDeltaSatang: 1000, isAvailable: false }),
  ],
};

const GROUPS = [NOODLE, EXTRAS];

afterEach(() => {
  vi.clearAllMocks();
});

function renderSheet(over: Partial<React.ComponentProps<typeof ModifierSheet>> = {}): {
  onConfirm: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  render(
    <ModifierSheet
      itemName="ก๋วยเตี๋ยวหมู"
      basePriceSatang={5000}
      groups={GROUPS}
      initialSelection={['m-small']}
      initialQty={1}
      mode="add"
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm };
}

describe('the fast path', () => {
  it('opens with the defaults chosen and confirms in one tap', async () => {
    // Two taps for an ordinary bowl — tap the item, tap confirm — is the whole
    // reason the sheet is allowed to exist at all.
    const { onConfirm } = renderSheet();
    expect(screen.getByRole('button', { name: /เส้นเล็ก/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: /เพิ่มลงบิล/ }));
    expect(onConfirm).toHaveBeenCalledWith(['m-small'], 1, null);
  });

  it('shows the price the customer will be charged on the button', async () => {
    renderSheet();
    expect(screen.getByRole('button', { name: /เพิ่มลงบิล 50\.00/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /เพิ่มลูกชิ้น/ }));
    // 50.00 + 10.00
    expect(screen.getByRole('button', { name: /เพิ่มลงบิล 60\.00/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'เพิ่มจำนวน' }));
    expect(screen.getByRole('button', { name: /เพิ่มลงบิล 120\.00/ })).toBeInTheDocument();
  });
});

describe('choosing', () => {
  it('swaps rather than stacks in a single-select group', async () => {
    const { onConfirm } = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: /บะหมี่/ }));

    expect(screen.getByRole('button', { name: /บะหมี่/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /เส้นเล็ก/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await userEvent.click(screen.getByRole('button', { name: /เพิ่มลงบิล/ }));
    expect(onConfirm).toHaveBeenCalledWith(['m-egg'], 1, null);
  });

  it('does not let a required choice be turned off', async () => {
    // Tapping the chosen noodle again reads as "it deselected itself" at a
    // counter and costs a second tap to undo. Required groups stay filled.
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: /เส้นเล็ก/ }));
    expect(screen.getByRole('button', { name: /เส้นเล็ก/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('lets an optional choice be turned off again', async () => {
    const { onConfirm } = renderSheet();
    const ball = screen.getByRole('button', { name: /เพิ่มลูกชิ้น/ });
    await userEvent.click(ball);
    await userEvent.click(ball);

    await userEvent.click(screen.getByRole('button', { name: /เพิ่มลงบิล/ }));
    expect(onConfirm).toHaveBeenCalledWith(['m-small'], 1, null);
  });

  it('cannot pick a sold-out option', async () => {
    renderSheet();
    expect(screen.getByRole('button', { name: /ไข่ต้ม/ })).toBeDisabled();
  });
});

describe('an illegal bowl', () => {
  it('blocks confirm and names the group that is missing', () => {
    // The sheet cannot normally reach this state, but an edited line whose
    // option was retired from the menu opens straight into it.
    renderSheet({ initialSelection: [] });

    expect(screen.getByRole('button', { name: /เพิ่มลงบิล/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('เส้น');
  });
});

describe('editing an existing line', () => {
  it('opens on what was already ordered and says "บันทึก"', () => {
    renderSheet({ mode: 'edit', initialSelection: ['m-egg', 'm-ball'], initialQty: 3 });

    expect(screen.getByRole('button', { name: /บะหมี่/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /เพิ่มลูกชิ้น/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 3 x (50.00 + 10.00)
    expect(screen.getByRole('button', { name: /บันทึก 180\.00/ })).toBeInTheDocument();
  });
});

describe('the note', () => {
  it('is not offered unless the screen asks for it', () => {
    // The customer's QR page shares this sheet. Free text from a stranger
    // going straight to the pass is a decision, not a default.
    renderSheet();
    expect(screen.queryByLabelText(/หมายเหตุถึงครัว/)).not.toBeInTheDocument();
  });

  it('carries what was typed through to the bill', async () => {
    const { onConfirm } = renderSheet({ noteEnabled: true });
    await userEvent.type(screen.getByLabelText(/หมายเหตุถึงครัว/), 'เผ็ดน้อย');
    await userEvent.click(screen.getByRole('button', { name: /เพิ่มลงบิล/ }));

    expect(onConfirm).toHaveBeenCalledWith(['m-small'], 1, 'เผ็ดน้อย');
  });

  it('sends nothing rather than a space somebody left behind', async () => {
    // A `" "` is not null, so the receipt would print a bare `*` line and the
    // kitchen slip would grow a blank row telling nobody anything.
    const { onConfirm } = renderSheet({ noteEnabled: true });
    await userEvent.type(screen.getByLabelText(/หมายเหตุถึงครัว/), '   ');
    await userEvent.click(screen.getByRole('button', { name: /เพิ่มลงบิล/ }));

    expect(onConfirm).toHaveBeenCalledWith(['m-small'], 1, null);
  });

  it('opens on the note the line already carries when editing', () => {
    renderSheet({ mode: 'edit', noteEnabled: true, initialNote: 'ไม่ใส่ผักชี' });
    expect(screen.getByLabelText(/หมายเหตุถึงครัว/)).toHaveValue('ไม่ใส่ผักชี');
  });

  it('cannot be typed longer than the kitchen slip can wrap', () => {
    renderSheet({ noteEnabled: true });
    expect(screen.getByLabelText(/หมายเหตุถึงครัว/)).toHaveAttribute(
      'maxlength',
      String(MAX_ORDER_NOTE),
    );
  });
});
