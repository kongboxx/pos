/**
 * Reference data kept on the device: the menu, the floor plan, and who is
 * logged in.
 *
 * ABOUT CACHING THE IDENTITY — this reverses a decision from Step 2, so here is
 * the reasoning in full.
 *
 * Step 2 said the session lives only in the httpOnly cookie and the UI re-asks
 * `/auth/me` on every boot. That is still true of the CREDENTIAL. What broke it
 * is a boot with no network: `/auth/me` fails, the app has no idea who is
 * standing there, and it shows the PIN screen — which cannot work either,
 * because logging in needs the server. A tablet that reloads during an outage
 * would be a brick for the rest of the outage, and tablets reload: they sleep,
 * they run out of memory, staff pull the charger.
 *
 * So the NAME, ROLE AND BRANCH SETTINGS are cached, and the cookie is not.
 * The cached copy authorises nothing — every call to the server still carries
 * the httpOnly cookie or it is a 401. The worst a stale cache can do is let
 * someone take orders that then fail to sync, which is visible and recoverable.
 * It is capped at the session's own lifetime so it can never outlive the cookie
 * it is describing.
 */

import {
  SESSION_TTL_SECONDS,
  toBusinessDate,
  vatConfigForDate,
  type MeResponse,
  type MenuResponse,
  type Permission,
  type SessionUser,
  type TableDto,
} from '@pos/shared';
import { db } from './db.js';
import type { LocalContext } from './mutations.js';

const MENU_KEY = 'menu';
const TABLES_KEY = 'tables';
const IDENTITY_KEY = 'identity';

/** Same 12 hours as the cookie. A cache that outlived the session would put a
 *  name on screen for a shift that ended. */
export const IDENTITY_MAX_AGE_MS = SESSION_TTL_SECONDS * 1000;

export interface CachedIdentity {
  user: SessionUser;
  permissions: Permission[];
  branch: MeResponse['branch'];
}

async function read<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
  const row = await db.cache.get(key);
  return row ? { value: row.value as T, savedAt: row.savedAt } : null;
}

async function write(key: string, value: unknown): Promise<void> {
  await db.cache.put({ key, value, savedAt: Date.now() });
}

/* ---------------- menu ---------------- */

export const saveMenu = (menu: MenuResponse): Promise<void> => write(MENU_KEY, menu);

export async function loadMenu(): Promise<MenuResponse | null> {
  return (await read<MenuResponse>(MENU_KEY))?.value ?? null;
}

/* ---------------- floor plan ---------------- */

export const saveTables = (tables: TableDto[]): Promise<void> => write(TABLES_KEY, tables);

export async function loadTables(): Promise<TableDto[] | null> {
  return (await read<TableDto[]>(TABLES_KEY))?.value ?? null;
}

/* ---------------- identity ---------------- */

export const saveIdentity = (identity: CachedIdentity): Promise<void> =>
  write(IDENTITY_KEY, identity);

export async function loadIdentity(now = Date.now()): Promise<CachedIdentity | null> {
  const row = await read<CachedIdentity>(IDENTITY_KEY);
  if (!row) return null;
  if (now - row.savedAt > IDENTITY_MAX_AGE_MS) {
    await db.cache.delete(IDENTITY_KEY);
    return null;
  }
  return row.value;
}

export const forgetIdentity = (): Promise<void> => db.cache.delete(IDENTITY_KEY);

/* ---------------- the reducer's context ---------------- */

/**
 * Everything applyMutation needs, assembled from what is on the device.
 *
 * Returns null when the tablet has never been online — there is no menu to
 * price a bowl with, so there is nothing honest to show. That case only exists
 * on a brand new device.
 */
export async function loadLocalContext(now = new Date()): Promise<LocalContext | null> {
  const [menu, identity] = await Promise.all([loadMenu(), loadIdentity(now.getTime())]);
  if (!menu || !identity) return null;

  const businessDate = toBusinessDate(now, {
    timezone: identity.branch.timezone,
    dayCutoffHour: identity.branch.dayCutoffHour,
  });

  return {
    branchId: identity.branch.id,
    // Resolved against the bill's own trading day, not against the switch's
    // current position (Step 10). A tablet that only knew `vatEnabled` would
    // start charging VAT the instant the owner set the switch — including on
    // the bill open in front of it, dated two days before the registration
    // takes effect — and the server would then recompute that bill at 0% on
    // sync. Same function on both sides, so they cannot disagree.
    vat: vatConfigForDate(identity.branch, businessDate),
    businessDate,
    itemsById: new Map(
      menu.categories.flatMap((category) => category.items).map((item) => [item.id, item]),
    ),
    groupsById: new Map(menu.modifierGroups.map((group) => [group.id, group])),
  };
}
