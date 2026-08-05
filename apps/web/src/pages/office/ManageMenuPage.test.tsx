/**
 * The menu management screen.
 *
 * The point of this screen is the three numbers next to the price, so that is
 * what is tested: they have to be right, they have to refuse to appear when
 * there is no recipe behind them, and there must be nowhere to type a cost by
 * hand — the moment there is, the recipe stops being the answer.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { AdminMenuItemDto, MenuAdminResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { useManage } from '../../manage-store.js';
import { ManageMenuPage } from './ManageMenuPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    manageMenu: vi.fn(),
    createMenuItem: vi.fn(),
    updateMenuItem: vi.fn(),
    deleteMenuItem: vi.fn(),
    saveMenuItemRecipe: vi.fn(),
    moveMenuItem: vi.fn(),
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    deleteCategory: vi.fn(),
    moveCategory: vi.fn(),
  },
}));

function item(overrides: Partial<AdminMenuItemDto> = {}): AdminMenuItemDto {
  return {
    id: 'item-1',
    categoryId: 'cat-1',
    name: 'ก๋วยเตี๋ยวหมู',
    subcategory: 'หมู',
    priceSatang: 5000,
    costSatang: 2140,
    hasRecipe: true,
    station: 'ครัวเส้น',
    isAvailable: true,
    isActive: true,
    sortOrder: 0,
    groupIds: [],
    recipe: [
      {
        ingredientId: 'ing-1',
        name: 'เส้นเล็ก',
        baseUnit: 'กรัม',
        quantity: 120,
        unitCostSatang: 3,
        lineCostSatang: 360,
      },
    ],
    soldCount: 0,
    ...overrides,
  };
}

function category(
  overrides: Partial<MenuAdminResponse['categories'][number]> = {},
): MenuAdminResponse['categories'][number] {
  return {
    id: 'cat-1',
    name: 'ก๋วยเตี๋ยว',
    icon: '🍜',
    subcategories: ['หมู', 'เนื้อ'],
    sortOrder: 1,
    isActive: true,
    items: [],
    ...overrides,
  };
}

function menu(items: AdminMenuItemDto[], categories = [category({ items })]): MenuAdminResponse {
  return {
    categories,
    modifierGroups: [],
    ingredients: [
      {
        id: 'ing-1',
        name: 'เส้นเล็ก',
        baseUnit: 'กรัม',
        avgCostSatang: 3,
        shelfLifeDays: 2,
        isActive: true,
        usedByCount: 1,
      },
    ],
    stations: ['ครัวเส้น'],
  };
}

async function show(
  items: AdminMenuItemDto[],
  categories?: MenuAdminResponse['categories'],
): Promise<void> {
  vi.mocked(api.manageMenu).mockResolvedValue({ ok: true, data: menu(items, categories) });
  render(
    <MemoryRouter>
      <ManageMenuPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('navigation', { name: 'หมวด' })).toBeInTheDocument());
}

/** What one mutation answers with — the whole menu, like every menu route. */
function mutated(items: AdminMenuItemDto[], categories?: MenuAdminResponse['categories']) {
  return {
    ok: true as const,
    data: { menu: menu(items, categories), recalculated: { menuItems: 0, modifiers: 0 } },
  };
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useManage.setState({ menu: null, loading: false, busy: false, error: null, notice: null });
});

describe('the numbers on the list', () => {
  it('puts cost, profit and food-cost percentage next to the price', async () => {
    await show([item()]);
    const row = screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ });
    expect(row).toHaveTextContent('50.00');
    expect(row).toHaveTextContent('21.40');
    expect(row).toHaveTextContent('28.60');
    expect(row).toHaveTextContent('42.8%');
  });

  it('refuses to show a cost for a dish with no recipe', async () => {
    // A 0 that means "we never worked it out" and a 0 that means "it is free"
    // look identical, and Step 8's profit report would inherit the confusion.
    await show([item({ hasRecipe: false, costSatang: 0 })]);
    const row = screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ });
    expect(row).toHaveTextContent('ยังไม่ได้ใส่สูตร');
    expect(row).toHaveTextContent('ต้นทุน —');
    expect(row).toHaveTextContent('กำไร —');
    // And no food-cost percentage, which would be a share of nothing.
    expect(row).not.toHaveTextContent('%');
  });

  it('marks a discontinued dish differently from one that ran out today', async () => {
    await show([
      item({ id: 'a', name: 'เลิกขายแล้ว', isActive: false }),
      item({ id: 'b', name: 'หมดวันนี้เท่านั้น', isAvailable: false }),
    ]);
    expect(screen.getByRole('button', { name: /^เลิกขายแล้ว/ })).toHaveTextContent('เลิกขาย');
    expect(screen.getByRole('button', { name: /^หมดวันนี้เท่านั้น/ })).toHaveTextContent(
      'หมดวันนี้',
    );
  });
});

describe('the editor', () => {
  it('has no field for cost at all', async () => {
    await show([item()]);
    await tap(screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ }));
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getByLabelText('ราคาขาย (บาท)')).toBeInTheDocument();
    // Cost comes from the recipe below, or it does not exist. A box here would
    // be a second answer to the same question.
    expect(dialog.queryByLabelText(/ต้นทุน.*บาท/)).not.toBeInTheDocument();
    expect(dialog.getByRole('region', { name: 'สูตร' })).toBeInTheDocument();
  });

  it('sends the price in satang, not baht', async () => {
    vi.mocked(api.updateMenuItem).mockResolvedValue({
      ok: true,
      data: {
        menu: menu([item({ priceSatang: 5500 })]),
        recalculated: { menuItems: 0, modifiers: 0 },
      },
    });
    await show([item()]);
    await tap(screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ }));

    const dialog = within(screen.getByRole('dialog'));
    const price = dialog.getByLabelText('ราคาขาย (บาท)');
    await act(async () => {
      const user = userEvent.setup();
      await user.clear(price);
      await user.type(price, '55');
    });
    await tap(dialog.getByRole('button', { name: 'บันทึก' }));

    expect(api.updateMenuItem).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ priceSatang: 5500 }),
    );
  });

  it('will not send a price that is not a number', async () => {
    await show([item()]);
    await tap(screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ }));

    const dialog = within(screen.getByRole('dialog'));
    await act(async () => {
      const user = userEvent.setup();
      await user.clear(dialog.getByLabelText('ราคาขาย (บาท)'));
      await user.type(dialog.getByLabelText('ราคาขาย (บาท)'), 'ห้าสิบ');
    });
    await tap(dialog.getByRole('button', { name: 'บันทึก' }));

    expect(api.updateMenuItem).not.toHaveBeenCalled();
    expect(dialog.getByRole('alert')).toHaveTextContent('ราคาไม่ถูกต้อง');
  });

  it('needs two taps to delete, and says why a sold dish cannot go', async () => {
    await show([item({ soldCount: 12 })]);
    await tap(screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ }));
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getByText(/ขายไปแล้ว 12 ครั้ง/)).toBeInTheDocument();
    await tap(dialog.getByRole('button', { name: 'ลบเมนู' }));
    // The first tap only arms it; nothing has been sent yet.
    expect(api.deleteMenuItem).not.toHaveBeenCalled();
    expect(dialog.getByRole('button', { name: 'ยืนยันลบถาวร' })).toBeInTheDocument();
  });
});

describe('arranging the menu', () => {
  it('moves a category without asking the screen to guess a number', async () => {
    // The client never posts a sortOrder — two rows sharing one fall back to
    // sorting by name, so a guessed number moves a category nowhere visible.
    vi.mocked(api.moveCategory).mockResolvedValue(mutated([]));
    await show([], [category(), category({ id: 'cat-2', name: 'เครื่องดื่ม', icon: null })]);

    await tap(screen.getByRole('button', { name: 'เลื่อน เครื่องดื่ม ขึ้น' }));
    expect(api.moveCategory).toHaveBeenCalledWith('cat-2', 'UP');
  });

  it('will not offer to move the first one up or the last one down', async () => {
    await show([], [category(), category({ id: 'cat-2', name: 'เครื่องดื่ม', icon: null })]);

    expect(screen.getByRole('button', { name: 'เลื่อน ก๋วยเตี๋ยว ขึ้น' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'เลื่อน เครื่องดื่ม ลง' })).toBeDisabled();
  });

  it('moves a dish inside its own category', async () => {
    vi.mocked(api.moveMenuItem).mockResolvedValue(mutated([]));
    await show([item(), item({ id: 'item-2', name: 'บะหมี่เกี๊ยว' })]);

    await tap(screen.getByRole('button', { name: 'เลื่อน บะหมี่เกี๊ยว ขึ้น' }));
    expect(api.moveMenuItem).toHaveBeenCalledWith('item-2', 'UP');
  });
});

describe('categories', () => {
  it('adds one without sending a position for it', async () => {
    vi.mocked(api.createCategory).mockResolvedValue(mutated([]));
    await show([]);

    await tap(screen.getByRole('button', { name: '+ เพิ่มหมวด' }));
    const dialog = within(screen.getByRole('dialog'));
    await act(async () => {
      await userEvent.setup().type(dialog.getByLabelText('ชื่อหมวด'), 'ของหวาน');
    });
    await tap(dialog.getByRole('button', { name: 'บันทึก' }));

    expect(api.createCategory).toHaveBeenCalledWith({
      name: 'ของหวาน',
      icon: null,
      subcategories: [],
      isActive: true,
    });
  });

  it('will not save a category with no name', async () => {
    await show([]);
    await tap(screen.getByRole('button', { name: '+ เพิ่มหมวด' }));

    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'บันทึก' }),
    ).toBeDisabled();
    expect(api.createCategory).not.toHaveBeenCalled();
  });

  it('opens on what the category already is, subcategories one per line', async () => {
    await show([]);
    await tap(screen.getByRole('button', { name: 'แก้ไขหมวด' }));
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getByLabelText('ชื่อหมวด')).toHaveValue('ก๋วยเตี๋ยว');
    // A regex, not the exact string: the label carries its hint sentence too.
    expect(dialog.getByLabelText(/ไอคอน/)).toHaveValue('🍜');
    expect(dialog.getByLabelText(/หมวดย่อย/)).toHaveValue('หมู\nเนื้อ');
  });

  it('drops blank lines from the subcategory list rather than saving them', async () => {
    // An empty subcategory becomes a filter chip on the till with no name and
    // nothing behind it.
    vi.mocked(api.updateCategory).mockResolvedValue(mutated([]));
    await show([]);
    await tap(screen.getByRole('button', { name: 'แก้ไขหมวด' }));

    const dialog = within(screen.getByRole('dialog'));
    await act(async () => {
      const user = userEvent.setup();
      await user.clear(dialog.getByLabelText(/หมวดย่อย/));
      await user.type(dialog.getByLabelText(/หมวดย่อย/), 'หมู\n\n  \nไก่');
    });
    await tap(dialog.getByRole('button', { name: 'บันทึก' }));

    expect(api.updateCategory).toHaveBeenCalledWith(
      'cat-1',
      expect.objectContaining({ subcategories: ['หมู', 'ไก่'] }),
    );
  });

  it('does not offer to delete a category that still has dishes in it', async () => {
    await show([item()]);
    await tap(screen.getByRole('button', { name: 'แก้ไขหมวด' }));
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.queryByRole('button', { name: 'ลบหมวด' })).not.toBeInTheDocument();
    expect(dialog.getByText(/มีเมนูอยู่ 1 รายการ ลบไม่ได้/)).toBeInTheDocument();
  });

  it('needs two taps to delete an empty one', async () => {
    vi.mocked(api.deleteCategory).mockResolvedValue(mutated([]));
    await show([]);
    await tap(screen.getByRole('button', { name: 'แก้ไขหมวด' }));

    const dialog = within(screen.getByRole('dialog'));
    await tap(dialog.getByRole('button', { name: 'ลบหมวด' }));
    expect(api.deleteCategory).not.toHaveBeenCalled();

    await tap(dialog.getByRole('button', { name: 'ยืนยันลบหมวด' }));
    expect(api.deleteCategory).toHaveBeenCalledWith('cat-1');
  });
});

describe('when the server refuses', () => {
  it('shows the sentence the server sent rather than a generic one', async () => {
    vi.mocked(api.updateMenuItem).mockResolvedValue({
      ok: false,
      error: '"ก๋วยเตี๋ยวหมู" เคยขายไปแล้ว 12 ครั้ง ลบไม่ได้ — ใช้ "เลิกขาย" แทน',
      offline: false,
      status: 409,
    });
    await show([item()]);
    await tap(screen.getByRole('button', { name: /^ก๋วยเตี๋ยวหมู/ }));
    await tap(within(screen.getByRole('dialog')).getByRole('button', { name: 'บันทึก' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ใช้ "เลิกขาย" แทน');
  });
});
