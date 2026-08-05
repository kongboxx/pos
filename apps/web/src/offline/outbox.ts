/**
 * The queue of things the server has not been told yet.
 *
 * Three decisions here are the whole design:
 *
 * 1. STRICT ORDER, PER BILL. `addLine` cannot be sent before the `createOrder`
 *    it belongs to, so the queue replays in the order it was written. But the
 *    ordering only matters WITHIN one bill: if table 7's bill is rejected
 *    because a dish sold out, table 3 must keep syncing. So a failure blocks
 *    exactly one orderId and the pass carries on with the others. A single
 *    global chain would let one bad bowl freeze the whole shop's takings.
 *
 * 2. REPLAY IS SAFE. Every mutation is idempotent on the id the tablet
 *    generated (rule #6): re-sending `createOrder` returns the same bill,
 *    re-sending `addLine` returns the same line, and `PATCH qty = 3` sets three
 *    rather than adding three. That is why a dropped response needs no
 *    reconciliation protocol — it just gets sent again. A `DELETE` for a line
 *    the server never had is treated as success, because "it isn't there" is
 *    precisely what was being asked for.
 *
 * 3. A REJECTION IS A PERSON'S PROBLEM, NOT A RETRY LOOP. If the server says
 *    "ก๋วยเตี๋ยวหมู หมดแล้ว", no amount of retrying will change its mind. The
 *    item is parked as `rejected` with the server's own Thai message and the
 *    bill is surfaced to staff, who decide: try again, or throw the offline
 *    changes away and take the server's version. Silently dropping it would
 *    mean food that was cooked never appears on a bill.
 */

import type { OrderDto } from '@pos/shared';
import { db, type OutboxItem } from './db.js';
import type { Mutation } from './mutations.js';

/** Retryable failures (a 500, a proxy hiccup) before a human has to look. */
export const MAX_ATTEMPTS = 5;

export type SendOutcome =
  /** Landed. `order` is the server's version of the whole bill, when it sent one. */
  | { kind: 'ok'; order?: OrderDto }
  /** fetch itself failed — the network is down, stop the whole pass. */
  | { kind: 'offline' }
  /** Might work later (5xx). Counted, then given up on. */
  | { kind: 'retry'; message: string }
  /** The server refused on the merits (4xx). Needs a human. */
  | { kind: 'rejected'; message: string };

export type Sender = (mutation: Mutation) => Promise<SendOutcome>;

export interface FlushResult {
  sent: number;
  rejected: number;
  /** True when the pass stopped early because there is no connection. */
  offline: boolean;
  /** Bills whose queue is now empty — the server's copy is the truth again. */
  drained: string[];
  /** The freshest server version of each bill this pass saw, so the caller can
   *  adopt it without a second round trip just to learn the bill number. */
  orders: Map<string, OrderDto>;
}

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Adds a mutation to the queue.
 *
 * COLLAPSING: holding "+" on a quantity offline would otherwise queue one PATCH
 * per tap, and every one of them would be sent when the wifi returns — all but
 * the last already obsolete. When the newest queued item is a quantity/option
 * edit of the same line, it is REPLACED rather than appended. Only the newest
 * qualifies: rewriting anything further back would reorder the queue.
 */
export async function enqueue(mutation: Mutation): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const newest = await newestFor(mutation.orderId);

    if (
      newest?.seq !== undefined &&
      newest.status === 'pending' &&
      newest.mutation.kind === 'updateLine' &&
      mutation.kind === 'updateLine' &&
      newest.mutation.lineId === mutation.lineId
    ) {
      await db.outbox.update(newest.seq, { mutation });
      return;
    }

    await db.outbox.add({
      orderId: mutation.orderId,
      mutation,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: 'pending',
      error: null,
    });
  });
}

async function newestFor(orderId: string): Promise<OutboxItem | undefined> {
  const items = await db.outbox.where('orderId').equals(orderId).sortBy('seq');
  return items.at(-1);
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

/** How many mutations this bill is still carrying. 0 means the server agrees. */
export async function unsentCount(orderId: string): Promise<number> {
  return db.outbox.where('orderId').equals(orderId).count();
}

export async function totalUnsent(): Promise<number> {
  return db.outbox.count();
}

export async function rejectedItems(): Promise<OutboxItem[]> {
  return db.outbox.where('status').equals('rejected').sortBy('seq');
}

/** Bills that currently have something the server has not accepted. */
export async function unsentOrderIds(): Promise<Set<string>> {
  const ids = await db.outbox.orderBy('orderId').uniqueKeys();
  return new Set(ids.map(String));
}

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */

export async function flushOutbox(send: Sender): Promise<FlushResult> {
  const pending = await db.outbox.where('status').equals('pending').sortBy('seq');
  const result: FlushResult = {
    sent: 0,
    rejected: 0,
    offline: false,
    drained: [],
    orders: new Map(),
  };
  if (pending.length === 0) return result;

  const blocked = new Set<string>();
  const touched = new Set<string>();

  for (const item of pending) {
    if (item.seq === undefined) continue;
    // Anything queued behind a failure for the SAME bill has to wait: sending
    // "add a line" to a bill whose "open the bill" was refused just produces a
    // second, more confusing error.
    if (blocked.has(item.orderId)) continue;

    const outcome = await send(item.mutation);

    if (outcome.kind === 'offline') {
      result.offline = true;
      break;
    }

    touched.add(item.orderId);

    if (outcome.kind === 'ok') {
      await db.outbox.delete(item.seq);
      result.sent += 1;
      if (outcome.order) result.orders.set(item.orderId, outcome.order);
      continue;
    }

    const attempts = item.attempts + 1;
    const giveUp = outcome.kind === 'rejected' || attempts >= MAX_ATTEMPTS;
    await db.outbox.update(item.seq, {
      attempts,
      status: giveUp ? 'rejected' : 'pending',
      error: outcome.message,
    });
    if (giveUp) result.rejected += 1;
    blocked.add(item.orderId);
  }

  for (const orderId of touched) {
    if ((await unsentCount(orderId)) === 0) result.drained.push(orderId);
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* recovering                                                          */
/* ------------------------------------------------------------------ */

/**
 * Try this bill again.
 *
 * Per BILL, not per mutation, because the mutations of one bill are a chain:
 * retrying the middle of it in isolation is meaningless.
 */
export async function retryOrder(orderId: string): Promise<void> {
  const items = await db.outbox.where('orderId').equals(orderId).toArray();
  await db.transaction('rw', db.outbox, async () => {
    for (const item of items) {
      if (item.seq === undefined) continue;
      await db.outbox.update(item.seq, { status: 'pending', attempts: 0, error: null });
    }
  });
}

/**
 * Give up on this bill's queued changes.
 *
 * The WHOLE chain goes, for the same reason: keeping the later mutations of a
 * bill whose opening was refused would send them into a void. The caller is
 * expected to then refetch the bill so the screen shows what the server
 * actually has — which may be nothing at all.
 */
export async function discardOrder(orderId: string): Promise<void> {
  await db.outbox.where('orderId').equals(orderId).delete();
}
