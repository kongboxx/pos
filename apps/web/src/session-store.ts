/**
 * Who is logged in.
 *
 * THE CREDENTIAL IS STILL ONLY IN THE COOKIE. Nothing here holds a token, and
 * nothing here can be replayed against the server; every request is authorised
 * by the httpOnly cookie the browser manages, which JavaScript cannot read.
 *
 * What changed in Step 4 is that the DESCRIPTION of the session — name, role,
 * branch settings — is now written to IndexedDB. Step 2 deliberately did not do
 * this, and the reason it now must is concrete: a tablet that reloads while the
 * wifi is down cannot call `/auth/me`, so it would show the PIN screen, and the
 * PIN screen cannot work either because logging in needs the server. The shop
 * would lose the till until the network came back. Caching the description
 * makes that boot work; it grants nothing, because the moment a real request
 * goes out, the cookie is still the only thing that decides.
 *
 * The cache is capped at the session's own lifetime and is wiped on logout.
 */

import { create } from 'zustand';
import { can, type MeResponse, type Permission, type SessionUser } from '@pos/shared';
import { api } from './api-client.js';
import { forgetIdentity, loadIdentity, saveIdentity } from './offline/catalog.js';
import { clearLocalData } from './offline/db.js';
import { totalUnsent } from './offline/outbox.js';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface SessionState {
  status: Status;
  user: SessionUser | null;
  branch: MeResponse['branch'] | null;
  /** True when the last call failed because the network is down, not the login. */
  offline: boolean;

  refresh: () => Promise<void>;
  login: (
    staffId: string,
    pin: string,
    branchId?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Same matrix the API enforces — this only decides whether to draw a button. */
  can: (permission: Permission) => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  user: null,
  branch: null,
  offline: false,

  refresh: async () => {
    const result = await api.me();
    if (result.ok) {
      set({
        status: 'authenticated',
        user: result.data.user,
        branch: result.data.branch,
        offline: false,
      });
      await saveIdentity({
        user: result.data.user,
        permissions: result.data.permissions,
        branch: result.data.branch,
      });
      return;
    }

    // A network failure is NOT a logout. Clearing the session here would throw
    // a cashier back to the PIN screen every time the shop wifi blinks.
    if (result.offline) {
      const cached = await loadIdentity();
      if (cached) {
        set({
          status: 'authenticated',
          user: cached.user,
          branch: cached.branch,
          offline: true,
        });
        return;
      }
      set({ offline: true, status: get().user ? 'authenticated' : 'anonymous' });
      return;
    }

    // The server answered and said no. That is a real logout — forget the
    // cached description too, or the next offline boot would resurrect it.
    await forgetIdentity();
    set({ status: 'anonymous', user: null, branch: null, offline: false });
  },

  login: async (staffId, pin, branchId) => {
    const result = await api.login(staffId, pin, branchId);
    if (!result.ok) return { ok: false, error: result.error };
    await get().refresh();
    return { ok: true };
  },

  /**
   * Logging out throws away this device's local data, so it must not happen
   * while the device is the ONLY place some of that data exists. An unsent
   * queue means bills that no server has ever seen; wiping them would delete
   * food that has already been served.
   */
  logout: async () => {
    const unsent = await totalUnsent();
    if (unsent > 0) {
      return {
        ok: false,
        error: `ยังมี ${unsent} รายการที่ยังไม่ได้ส่งเข้าระบบ — ต่อเน็ตให้ส่งครบก่อนออกจากระบบ`,
      };
    }

    await api.logout();
    await clearLocalData();
    set({ status: 'anonymous', user: null, branch: null });
    return { ok: true };
  },

  can: (permission) => {
    const { user } = get();
    return user ? can(user.role, permission) : false;
  },
}));
