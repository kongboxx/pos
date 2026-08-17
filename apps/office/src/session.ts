/**
 * The back office's session: the shared store with NO persistence.
 *
 * Nothing is cached on the device. A dead connection reads as "not logged in",
 * which is correct here — an identity cached in a browser is an identity that
 * outlives its own revocation, and this site is on the open internet.
 *
 * That absence is the whole difference from the till's session.ts, which does
 * pass a persistence adapter because a cashier must keep working when the wifi
 * drops. Nobody needs to read last month's P&L during a blackout.
 */

import { createSessionStore, type OfficeCredentials } from '@pos/web-kit';
import { officeApi } from './api-office.js';

export const useSession = createSessionStore<OfficeCredentials>({ api: officeApi });
