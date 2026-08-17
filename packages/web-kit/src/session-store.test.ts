/**
 * The session store WITHOUT a persistence adapter — the shape the back office
 * uses.
 *
 * The till caches its identity so a tablet that reloads on dead wifi still has
 * a till. The back office must not: it has no local database, and an identity
 * sitting in a browser after the server said no is a session that outlives its
 * own revocation.
 */

import { describe, expect, it, vi } from 'vitest';
import { Permission, Role, type MeResponse, type SessionUser } from '@pos/shared';
import { createSessionStore } from './session-store.js';

const user: SessionUser = {
  staffId: 's1',
  branchId: 'b1',
  role: Role.OWNER,
  fullName: 'หน่อย',
  nickname: null,
};

const branch: MeResponse['branch'] = {
  id: 'b1',
  name: 'ร้าน',
  branchCode: 'HQ',
  businessType: 'RESTAURANT',
  vatEnabled: false,
  vatRateBp: 0,
  priceIncludesVat: true,
  vatEffectiveDate: null,
  timezone: 'Asia/Bangkok',
  dayCutoffHour: 4,
  promptPayConfigured: false,
};

function apiStub(over: Partial<Parameters<typeof createSessionStore>[0]['api']> = {}) {
  return {
    me: vi.fn().mockResolvedValue({ ok: true, data: { user, permissions: [], branch } }),
    login: vi.fn().mockResolvedValue({ ok: true, data: { user } }),
    logout: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    ...over,
  };
}

describe('createSessionStore without persistence', () => {
  it('authenticates from /auth/me', async () => {
    const store = createSessionStore({ api: apiStub() });
    await store.getState().refresh();
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().user?.staffId).toBe('s1');
  });

  it('goes anonymous when the network is down instead of resurrecting a cached identity', async () => {
    // The till would fall back to its cache here. The back office has none, so
    // a dead connection must read as "not logged in", not as "still the owner".
    const api = apiStub({
      me: vi.fn().mockResolvedValue({ ok: false, error: 'offline', offline: true }),
    });
    const store = createSessionStore({ api });
    await store.getState().refresh();
    expect(store.getState().status).toBe('anonymous');
    expect(store.getState().offline).toBe(true);
  });

  it('logs out without asking about an unsent queue that cannot exist', async () => {
    const api = apiStub();
    const store = createSessionStore({ api });
    await store.getState().refresh();
    const result = await store.getState().logout();
    expect(result.ok).toBe(true);
    expect(api.logout).toHaveBeenCalled();
    expect(store.getState().status).toBe('anonymous');
  });

  it('answers can() from the same matrix the API enforces', async () => {
    const store = createSessionStore({ api: apiStub() });
    await store.getState().refresh();
    // OWNER has VIEW_PAYROLL; nobody else does.
    expect(store.getState().can(Permission.VIEW_PAYROLL)).toBe(true);
  });

  it('answers can() false before anyone has logged in', () => {
    const store = createSessionStore({ api: apiStub() });
    expect(store.getState().can(Permission.VIEW_PAYROLL)).toBe(false);
  });
});

describe('credentials the store does not understand', () => {
  it('hands whatever the app passes straight to that app’s api', async () => {
    // The store used to insist on (staffId, pin) — a till assumption living in
    // shared code. It now carries the credential without opening it.
    const api = apiStub();
    const store = createSessionStore<{ email: string; password: string }>({ api });

    await store.getState().login({ email: 'noi@example.com', password: 'a-long-password' });

    expect(api.login).toHaveBeenCalledWith({
      email: 'noi@example.com',
      password: 'a-long-password',
    });
  });

  it('reports the API’s message when the login is refused', async () => {
    const api = apiStub({
      me: vi.fn().mockResolvedValue({ ok: false, error: 'no', offline: false }),
      login: vi.fn().mockResolvedValue({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }),
    });
    const store = createSessionStore<{ email: string; password: string }>({ api });

    const result = await store.getState().login({ email: 'a@b.co', password: 'x'.repeat(12) });

    expect(result).toEqual({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    // A refused login must not leave the store looking authenticated.
    expect(store.getState().status).not.toBe('authenticated');
  });
});
