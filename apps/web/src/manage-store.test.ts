/**
 * The shared management store.
 *
 * Two things matter here and neither is obvious from the UI: a failed edit must
 * leave the menu on screen untouched (a half-applied menu is worse than a
 * refused one), and a successful one must say how many dishes it moved that
 * nobody asked it to.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuAdminResponse } from '@pos/shared';
import { api } from './api-client.js';
import { describeRecalculation, useManage } from './manage-store.js';

vi.mock('./api-client.js', () => ({ api: { manageMenu: vi.fn() } }));

const EMPTY: MenuAdminResponse = {
  categories: [],
  modifierGroups: [],
  ingredients: [],
  stations: [],
};

const LOADED: MenuAdminResponse = { ...EMPTY, stations: ['ครัวเส้น'] };

beforeEach(() => {
  vi.clearAllMocks();
  useManage.setState({ menu: null, loading: false, busy: false, error: null, notice: null });
});

describe('describeRecalculation', () => {
  it('says nothing when nothing moved', () => {
    // Renaming a dish recalculates nothing, and a banner saying "0 เมนู" would
    // train the owner to ignore the banner that matters.
    expect(describeRecalculation({ menuItems: 0, modifiers: 0 })).toBeNull();
  });

  it('names what changed without being asked to', () => {
    expect(describeRecalculation({ menuItems: 9, modifiers: 0 })).toBe(
      'คิดต้นทุนใหม่ให้ 9 เมนู แล้ว',
    );
    expect(describeRecalculation({ menuItems: 2, modifiers: 3 })).toBe(
      'คิดต้นทุนใหม่ให้ 2 เมนู และ 3 ตัวเลือก แล้ว',
    );
  });
});

describe('run', () => {
  it('replaces the whole menu on success, because a cascade has no patch', async () => {
    useManage.setState({ menu: EMPTY });
    const ok = await useManage.getState().run(async () => ({
      ok: true,
      data: { menu: LOADED, recalculated: { menuItems: 4, modifiers: 0 } },
    }));

    expect(ok).toBe(true);
    expect(useManage.getState().menu).toEqual(LOADED);
    expect(useManage.getState().notice).toContain('4 เมนู');
    expect(useManage.getState().busy).toBe(false);
  });

  it('leaves the menu alone when the server refuses', async () => {
    useManage.setState({ menu: LOADED });
    const ok = await useManage.getState().run(async () => ({
      ok: false,
      error: 'เคยขายไปแล้ว 12 ครั้ง ลบไม่ได้',
      offline: false,
      status: 409,
    }));

    expect(ok).toBe(false);
    expect(useManage.getState().menu).toEqual(LOADED);
    // The server's sentence carries the whole answer; a generic "ผิดพลาด"
    // would throw away the part that says what to do instead.
    expect(useManage.getState().error).toContain('12 ครั้ง');
    expect(useManage.getState().busy).toBe(false);
  });

  it('clears the previous notice before the next edit', async () => {
    useManage.setState({ notice: 'คิดต้นทุนใหม่ให้ 9 เมนู แล้ว' });
    await useManage.getState().run(async () => ({
      ok: true,
      data: { menu: LOADED, recalculated: { menuItems: 0, modifiers: 0 } },
    }));
    expect(useManage.getState().notice).toBeNull();
  });
});

describe('load', () => {
  it('keeps the error when the menu cannot be fetched', async () => {
    vi.mocked(api.manageMenu).mockResolvedValue({
      ok: false,
      error: 'เชื่อมต่อไม่ได้',
      offline: true,
    });
    await useManage.getState().load();
    expect(useManage.getState().menu).toBeNull();
    expect(useManage.getState().error).toBe('เชื่อมต่อไม่ได้');
    expect(useManage.getState().loading).toBe(false);
  });
});
