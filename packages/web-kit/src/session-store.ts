/**
 * Who is logged in — as a factory, not a ready-made store.
 *
 * THE CREDENTIAL IS STILL ONLY IN THE COOKIE. Nothing here holds a token and
 * nothing here can be replayed against the server; every request is authorised
 * by the httpOnly cookie the browser manages, which JavaScript cannot read.
 *
 * The two apps differ in exactly one capability, and it is injected rather
 * than branched on:
 *
 *   the till     passes `persistence`, so a tablet that reloads while the wifi
 *                is down still boots into a working till instead of a PIN
 *                screen it could never get past. It also refuses to log out
 *                while orders are queued — wiping local data then would delete
 *                food that has already been served.
 *
 *   the office   passes nothing. It has no local database and must not grow
 *                one: an identity cached in a browser is an identity that
 *                outlives its own revocation.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { can, type MeResponse, type Permission, type SessionUser } from '@pos/shared';
import type { ApiResult } from './http.js';

export interface CachedIdentity {
  user: SessionUser;
  permissions: Permission[];
  branch: MeResponse['branch'];
}

export interface SessionPersistence {
  save(identity: CachedIdentity): Promise<void>;
  load(): Promise<{ user: SessionUser; branch: MeResponse['branch'] } | null>;
  forget(): Promise<void>;
  clearAll(): Promise<void>;
  unsentCount(): Promise<number>;
}

export interface SessionApi {
  me(): Promise<ApiResult<MeResponse>>;
  login(staffId: string, pin: string, branchId?: string): Promise<ApiResult<{ user: SessionUser }>>;
  logout(): Promise<ApiResult<unknown>>;
}

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export interface SessionState {
  status: SessionStatus;
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

export function createSessionStore(deps: {
  api: SessionApi;
  persistence?: SessionPersistence;
}): UseBoundStore<StoreApi<SessionState>> {
  const { api, persistence } = deps;

  return create<SessionState>((set, get) => ({
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
        await persistence?.save({
          user: result.data.user,
          permissions: result.data.permissions,
          branch: result.data.branch,
        });
        return;
      }

      // A network failure is NOT a logout. Clearing the session here would
      // throw a cashier back to the PIN screen every time the wifi blinks.
      if (result.offline) {
        const cached = await persistence?.load();
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
      await persistence?.forget();
      set({ status: 'anonymous', user: null, branch: null, offline: false });
    },

    login: async (staffId, pin, branchId) => {
      const result = await api.login(staffId, pin, branchId);
      if (!result.ok) return { ok: false, error: result.error };
      await get().refresh();
      return { ok: true };
    },

    logout: async () => {
      const unsent = (await persistence?.unsentCount()) ?? 0;
      if (unsent > 0) {
        return {
          ok: false,
          error: `ยังมี ${unsent} รายการที่ยังไม่ได้ส่งเข้าระบบ — ต่อเน็ตให้ส่งครบก่อนออกจากระบบ`,
        };
      }

      await api.logout();
      await persistence?.clearAll();
      set({ status: 'anonymous', user: null, branch: null });
      return { ok: true };
    },

    can: (permission) => {
      const { user } = get();
      return user ? can(user.role, permission) : false;
    },
  }));
}
