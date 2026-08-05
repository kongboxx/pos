/**
 * The tablet's own database.
 *
 * IndexedDB, never localStorage — that is a project rule, and the reason is
 * not storage size. localStorage is synchronous (every write blocks the frame
 * that is drawing the bill), it holds strings only (so every bill would be
 * JSON.parse'd by hand), and it has no transactions: a tab killed halfway
 * through "save the bill AND queue the mutation" leaves the two disagreeing,
 * which is exactly the corruption an offline till cannot recover from.
 *
 * Three tables, and the split matters:
 *
 *  - `orders` is a MIRROR. It is what the screen draws. It is authoritative
 *    while the bill still has unsent work, and is overwritten by the server's
 *    answer once the queue for that bill drains.
 *  - `outbox` is the QUEUE of things the server has not been told yet. It is
 *    the only durable record of an offline order, so it is written in the same
 *    transaction as the mirror.
 *  - `cache` is read-only reference data (the menu, the floor plan, who is
 *    logged in) — throwing it away costs a refetch and nothing else.
 *
 * Nothing here holds a credential. The session cookie stays httpOnly in the
 * browser's own store; see identity() in catalog.ts for what is cached and why
 * that is not the same thing.
 */

import Dexie, { type Table } from 'dexie';
import type { OrderDto } from '@pos/shared';
import type { Mutation } from './mutations.js';

/** A bill as this device currently believes it to be. */
export interface StoredOrder extends OrderDto {
  /** Epoch ms of the last local or server write — used to drop stale days. */
  updatedAt: number;
  /** true until the server has confirmed every mutation for this bill. */
  unsynced: boolean;
}

export type OutboxStatus =
  /** Waiting its turn, or waiting for the network. */
  | 'pending'
  /** The server said no. Needs a human: retry it or throw it away. */
  | 'rejected';

export interface OutboxItem {
  /** Auto-increment. This IS the send order — see flushOutbox. */
  seq?: number;
  /** The bill this belongs to. One poisoned bill must not block the others. */
  orderId: string;
  mutation: Mutation;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  /** The server's Thai message, shown to staff verbatim when rejected. */
  error: string | null;
}

export interface CacheRow {
  key: string;
  value: unknown;
  savedAt: number;
}

export class PosDatabase extends Dexie {
  orders!: Table<StoredOrder, string>;
  outbox!: Table<OutboxItem, number>;
  cache!: Table<CacheRow, string>;

  constructor(name = 'pos') {
    super(name);
    this.version(1).stores({
      orders: 'id, status, tableId, updatedAt',
      outbox: '++seq, orderId, status',
      cache: 'key',
    });
  }
}

export const db = new PosDatabase();

/* ------------------------------------------------------------------ */
/* change notification                                                 */
/* ------------------------------------------------------------------ */

/**
 * A short pub/sub instead of dexie-react-hooks.
 *
 * The screens need to redraw when a bill changes underneath them — a local
 * edit, or a background sync adopting the server's version. That is the only
 * cross-component event there is, and a whole reactive-query layer for one
 * event would be more moving parts than the problem has.
 *
 * A `put` carries the new bill with it rather than just saying "something
 * changed". Subscribers can then update in place instead of each firing its own
 * read back at IndexedDB — which on the order screen meant a database round
 * trip per tap, landing a frame or two after the tap it belonged to.
 */
export type OrdersChange =
  | { kind: 'put'; order: StoredOrder }
  /** A bill was removed, or everything was wiped: re-read what you need. */
  | { kind: 'reset' };

type Listener = (change: OrdersChange) => void;
const listeners = new Set<Listener>();

export function onOrdersChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyOrdersChanged(change: OrdersChange = { kind: 'reset' }): void {
  for (const listener of listeners) listener(change);
}

/* ------------------------------------------------------------------ */

/** Writes the mirror and tells whoever is drawing it. */
export async function putOrder(order: OrderDto, unsynced: boolean): Promise<void> {
  const stored: StoredOrder = { ...order, updatedAt: Date.now(), unsynced };
  await db.orders.put(stored);
  notifyOrdersChanged({ kind: 'put', order: stored });
}

export async function getOrder(orderId: string): Promise<StoredOrder | undefined> {
  return db.orders.get(orderId);
}

export async function dropOrder(orderId: string): Promise<void> {
  await db.orders.delete(orderId);
  notifyOrdersChanged();
}

/** Every bill this device still thinks is open — including ones the server
 *  has never heard of, which is the whole point on the floor plan. */
export async function localOpenOrders(): Promise<StoredOrder[]> {
  return db.orders.where('status').equals('OPEN').toArray();
}

/** Wipes everything. Used by logout and by the tests. */
export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', db.orders, db.outbox, db.cache, async () => {
    await Promise.all([db.orders.clear(), db.outbox.clear(), db.cache.clear()]);
  });
  notifyOrdersChanged();
}
