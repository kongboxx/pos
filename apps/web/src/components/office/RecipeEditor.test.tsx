/**
 * The recipe editor.
 *
 * What is tested is what makes the screen trustworthy: the total has to move
 * while a quantity is being typed, and a row that cannot be saved has to be
 * refused HERE rather than at the server — because the server's rejection
 * arrives after the owner has moved on to the next dish.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AdminIngredientDto, AdminRecipeLineDto } from '@pos/shared';
import { RecipeEditor } from './RecipeEditor.js';

const NOODLE: AdminIngredientDto = {
  id: 'ing-noodle',
  name: 'เส้นเล็ก',
  baseUnit: 'กรัม',
  avgCostSatang: 3,
  shelfLifeDays: 2,
  isActive: true,
  usedByCount: 4,
};

const PORK: AdminIngredientDto = {
  id: 'ing-pork',
  name: 'หมูชิ้น',
  baseUnit: 'กรัม',
  avgCostSatang: 20,
  shelfLifeDays: 2,
  isActive: true,
  usedByCount: 3,
};

const NOODLE_LINE: AdminRecipeLineDto = {
  ingredientId: NOODLE.id,
  name: NOODLE.name,
  baseUnit: NOODLE.baseUnit,
  quantity: 120,
  unitCostSatang: 3,
  lineCostSatang: 360,
};

function setup(overrides: Partial<React.ComponentProps<typeof RecipeEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(true);
  render(
    <RecipeEditor
      lines={[NOODLE_LINE]}
      ingredients={[NOODLE, PORK]}
      allowNegative={false}
      busy={false}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { onSave };
}

async function type(label: string, value: string): Promise<void> {
  const user = userEvent.setup();
  const field = screen.getByLabelText(label);
  await act(async () => {
    await user.clear(field);
    // userEvent.type throws on an empty string, and "cleared the box and walked
    // away" is exactly the state this editor has to refuse to save.
    if (value !== '') await user.type(field, value);
  });
}

describe('the running total', () => {
  it('shows what the recipe costs before anything is saved', () => {
    setup();
    expect(screen.getByText('ต้นทุนรวม').parentElement).toHaveTextContent('3.60');
  });

  it('follows the quantity as it is typed', async () => {
    setup();
    await type('จำนวน เส้นเล็ก', '200');
    // 200 g x 3 satang. An owner who has to press save to find out what a
    // change did will stop trying changes.
    expect(screen.getByText('ต้นทุนรวม').parentElement).toHaveTextContent('6.00');
  });

  it('says plainly that a dish with no recipe is not free', () => {
    setup({ lines: [] });
    expect(screen.getByText(/ยังไม่ได้ใส่สูตร/)).toBeInTheDocument();
  });
});

describe('what it refuses to send', () => {
  it('will not save a row with no quantity typed yet', async () => {
    const { onSave } = setup();
    await type('จำนวน เส้นเล็ก', '');
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'บันทึกสูตร' }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ยังมีบรรทัดที่ไม่ได้ใส่จำนวน');
  });

  it('will not let a DISH subtract an ingredient', async () => {
    const { onSave } = setup();
    await type('จำนวน เส้นเล็ก', '-50');
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'บันทึกสูตร' }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ติดลบ');
  });

  it('lets an OPTION subtract, because that is what a swap is', async () => {
    // บะหมี่ takes the 120 g of เส้นเล็ก back out and puts its own noodles in.
    const { onSave } = setup({ allowNegative: true });
    await type('จำนวน เส้นเล็ก', '-120');
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'บันทึกสูตร' }));
    });
    expect(onSave).toHaveBeenCalledWith([{ ingredientId: NOODLE.id, quantity: -120 }]);
  });

  it('refuses a fifth decimal place the database cannot hold', async () => {
    const { onSave } = setup();
    await type('จำนวน เส้นเล็ก', '0.00001');
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'บันทึกสูตร' }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('ทศนิยม');
  });
});

describe('editing the list', () => {
  it('adds an ingredient that is not already in the recipe', async () => {
    setup();
    const user = userEvent.setup();
    await act(async () => {
      await user.selectOptions(screen.getByLabelText('เพิ่มวัตถุดิบ'), PORK.id);
    });
    expect(screen.getByLabelText('จำนวน หมูชิ้น')).toBeInTheDocument();
    // Offering an ingredient the recipe already has would create two rows for
    // one thing, and fixing one of them would leave the other behind.
    expect(screen.queryByRole('option', { name: /เส้นเล็ก/ })).not.toBeInTheDocument();
  });

  it('removes a row', async () => {
    setup();
    await act(async () => {
      await userEvent.setup().click(screen.getByRole('button', { name: 'ลบ' }));
    });
    expect(screen.queryByLabelText('จำนวน เส้นเล็ก')).not.toBeInTheDocument();
    expect(screen.getByText('ต้นทุนรวม').parentElement).toHaveTextContent('0.00');
  });
});
