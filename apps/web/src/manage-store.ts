/**
 * The menu, as the management screens hold it.
 *
 * ONE COPY, SHARED BY THREE SCREENS. Dishes, options and ingredients are not
 * three subjects — an ingredient price change rewrites dish costs, and an
 * option belongs to the dishes that offer it. Three stores would mean the
 * ingredients page could show a price the menu page had already changed.
 *
 * Every mutation the API accepts answers with the WHOLE menu back, so `run`
 * simply replaces what is held. Nothing here merges or patches: after a
 * cascade there is no correct patch, only the new truth.
 *
 * NOT OFFLINE. Editing the menu needs the server, and unlike taking an order
 * there is no cost to waiting — nobody is standing at the counter while the
 * owner decides what to charge for pork.
 */

import { create } from 'zustand';
import type { MenuAdminMutationResponse, MenuAdminResponse } from '@pos/shared';
import { api, type ApiResult } from './api-client.js';

interface ManageState {
  menu: MenuAdminResponse | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  /** The quiet good news: "แก้ต้นทุนให้ 9 เมนูแล้ว". Cleared by the next action. */
  notice: string | null;

  load: () => Promise<void>;
  /** Runs one edit; true when it went through. */
  run: (work: () => Promise<ApiResult<MenuAdminMutationResponse>>) => Promise<boolean>;
  dismiss: () => void;
}

export const useManage = create<ManageState>((set) => ({
  menu: null,
  loading: false,
  busy: false,
  error: null,
  notice: null,

  load: async () => {
    set({ loading: true });
    const result = await api.manageMenu();
    if (result.ok) set({ menu: result.data, loading: false, error: null });
    else set({ loading: false, error: result.error });
  },

  run: async (work) => {
    set({ busy: true, error: null, notice: null });
    const result = await work();
    if (!result.ok) {
      // The server's sentence, not a generic one: it is the half that says
      // "เคยขายไปแล้ว 12 ครั้ง — ใช้เลิกขายแทน", which is the whole answer.
      set({ busy: false, error: result.error });
      return false;
    }
    set({
      busy: false,
      menu: result.data.menu,
      notice: describeRecalculation(result.data.recalculated),
    });
    return true;
  },

  dismiss: () => set({ error: null, notice: null }),
}));

/**
 * Says out loud what the owner did not do by hand.
 *
 * Raising an ingredient price silently rewrites several dishes. Without this
 * line the only way to notice is to compare rows, and the usual outcome of
 * that is not noticing.
 */
export function describeRecalculation(counts: {
  menuItems: number;
  modifiers: number;
}): string | null {
  const parts: string[] = [];
  if (counts.menuItems > 0) parts.push(`${counts.menuItems} เมนู`);
  if (counts.modifiers > 0) parts.push(`${counts.modifiers} ตัวเลือก`);
  return parts.length > 0 ? `คิดต้นทุนใหม่ให้ ${parts.join(' และ ')} แล้ว` : null;
}
