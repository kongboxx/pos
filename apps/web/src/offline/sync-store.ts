/**
 * Connection state and the background sync loop.
 *
 * WHY `navigator.onLine` IS NOT THE ANSWER: it reports whether the device has a
 * network interface with a route, not whether this shop's server is reachable.
 * A tablet joined to the shop wifi while the router is rebooting, or while the
 * mini-PC running the API is off, reports `true` — and the till would keep
 * telling staff everything is fine. So `online` here means "the last request we
 * actually made got an answer". `navigator.onLine` is used only as a hint to
 * try again immediately when the interface comes back.
 *
 * The loop is a plain 5-second interval rather than exponential backoff. The
 * server is on the same LAN and the request is tiny; the thing that matters is
 * that a bill taken during an outage lands SOON after the wifi returns, not
 * that we were clever about it. Backoff would mean a bill sitting unsynced for
 * a minute after everything is working again, which staff read as "it's broken".
 */

import { create } from 'zustand';
import { api } from '../api-client.js';
import { dropOrder, notifyOrdersChanged, putOrder } from './db.js';
import { discardOrder, flushOutbox, rejectedItems, retryOrder, totalUnsent } from './outbox.js';
import { sendMutation } from './sender.js';

/** How often the queue is retried while there is work or the link is down. */
export const SYNC_INTERVAL_MS = 5000;

export interface RejectedBill {
  orderId: string;
  /** The server's own Thai message — shown to staff verbatim. */
  message: string;
  count: number;
}

interface SyncState {
  /** The last request got an answer. Starts optimistic; corrected on first try. */
  online: boolean;
  /** Mutations the server has not accepted yet, across every bill. */
  pending: number;
  /** Bills the server refused. These need a person. */
  rejected: RejectedBill[];
  syncing: boolean;
  lastSyncedAt: number | null;

  refresh: () => Promise<void>;
  flush: () => Promise<void>;
  retry: (orderId: string) => Promise<void>;
  discard: (orderId: string) => Promise<void>;
  /** Starts the loop; returns the teardown. Called once, from the app shell. */
  start: () => () => void;
}

export const useSync = create<SyncState>((set, get) => ({
  online: true,
  pending: 0,
  rejected: [],
  syncing: false,
  lastSyncedAt: null,

  refresh: async () => {
    const [pending, rejects] = await Promise.all([totalUnsent(), rejectedItems()]);

    const byOrder = new Map<string, RejectedBill>();
    for (const item of rejects) {
      const existing = byOrder.get(item.orderId);
      if (existing) existing.count += 1;
      // The FIRST rejection is the one that matters: everything behind it in
      // the chain failed because of it.
      else
        byOrder.set(item.orderId, { orderId: item.orderId, message: item.error ?? '', count: 1 });
    }

    set({ pending, rejected: [...byOrder.values()] });
  },

  flush: async () => {
    if (get().syncing) return;
    set({ syncing: true });

    try {
      if ((await totalUnsent()) === 0) {
        // Nothing to send, so this is a heartbeat.
        //
        // It runs whether or not we currently believe we are online, and that
        // is the point in both directions: it is what re-enables the pay button
        // after an outage, and it is what tells a cashier the server has gone
        // BEFORE they promise a customer a receipt. Finding out at the moment
        // you press "รับเงิน" is finding out too late.
        const health = await api.health();
        // Any answer at all means the link is up — even an unhappy one.
        // "Offline" here is strictly "the request could not leave".
        set({
          online: health.ok || !health.offline,
          ...(health.ok ? { lastSyncedAt: Date.now() } : {}),
        });
        return;
      }

      const result = await flushOutbox(sendMutation);

      // A bill whose queue is empty is the server's again — adopt its version,
      // which is where the real bill number finally comes from.
      for (const orderId of result.drained) {
        const fromFlush = result.orders.get(orderId);
        if (fromFlush) {
          await putOrder(fromFlush, false);
          continue;
        }
        const fetched = await api.getOrder(orderId);
        if (fetched.ok) await putOrder(fetched.data.order, false);
        else if (!fetched.offline && fetched.status === 404) await dropOrder(orderId);
      }

      set({
        online: !result.offline,
        ...(result.sent > 0 ? { lastSyncedAt: Date.now() } : {}),
      });
      notifyOrdersChanged();
    } finally {
      set({ syncing: false });
      await get().refresh();
    }
  },

  retry: async (orderId) => {
    await retryOrder(orderId);
    await get().flush();
  },

  discard: async (orderId) => {
    await discardOrder(orderId);
    // Whatever the server has is now the truth, including "no such bill".
    const fetched = await api.getOrder(orderId);
    if (fetched.ok) await putOrder(fetched.data.order, false);
    else if (!fetched.offline) await dropOrder(orderId);
    await get().refresh();
  },

  start: () => {
    const kick = (): void => void get().flush();

    // The interface coming back is a hint worth acting on immediately; losing
    // it is worth believing straight away so the pay button locks at once.
    const onOnline = (): void => kick();
    const onOffline = (): void => set({ online: false });

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = window.setInterval(kick, SYNC_INTERVAL_MS);

    void get().refresh();
    kick();

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(timer);
    };
  },
}));
