/**
 * The sync queue.
 *
 * These are the cases that decide whether a night's takings survive a bad
 * router: the order things are replayed in, what happens to the rest of the
 * shop when one bill is refused, and whether anything can be silently lost.
 * Nothing here is mocked except the network itself.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearLocalData, db } from './db.js';
import type { Mutation } from './mutations.js';
import {
  discardOrder,
  enqueue,
  flushOutbox,
  MAX_ATTEMPTS,
  rejectedItems,
  retryOrder,
  totalUnsent,
  unsentCount,
  type SendOutcome,
  type Sender,
} from './outbox.js';

const BILL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BILL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const openBill = (orderId: string): Mutation => ({
  kind: 'createOrder',
  orderId,
  tableId: null,
  channel: 'TAKEAWAY',
  tableName: null,
});

const addLine = (orderId: string, lineId: string): Mutation => ({
  kind: 'addLine',
  orderId,
  lineId,
  menuItemId: 'item-1',
  qty: 1,
  modifierIds: [],
  note: null,
});

const setQty = (orderId: string, lineId: string, qty: number): Mutation => ({
  kind: 'updateLine',
  orderId,
  lineId,
  qty,
  note: null,
});

/** Records what was actually sent, and answers however the test wants. */
function recorder(answer: (mutation: Mutation) => SendOutcome): {
  send: Sender;
  seen: Mutation[];
} {
  const seen: Mutation[] = [];
  return {
    seen,
    send: (mutation) => {
      seen.push(mutation);
      return Promise.resolve(answer(mutation));
    },
  };
}

const ok = (): SendOutcome => ({ kind: 'ok' });

beforeEach(async () => {
  await clearLocalData();
});

describe('queueing', () => {
  it('replays in the order the taps happened', async () => {
    // "Add a line" cannot reach the server before the bill it belongs to.
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));
    await enqueue(setQty(BILL_A, 'line-1', 2));

    const { send, seen } = recorder(ok);
    await flushOutbox(send);

    expect(seen.map((m) => m.kind)).toEqual(['createOrder', 'addLine', 'updateLine']);
  });

  it('collapses a run of quantity taps into the last one', async () => {
    // Holding "+" offline would otherwise queue one request per tap, and every
    // one but the last is already obsolete by the time the wifi returns.
    await enqueue(addLine(BILL_A, 'line-1'));
    await enqueue(setQty(BILL_A, 'line-1', 2));
    await enqueue(setQty(BILL_A, 'line-1', 3));
    await enqueue(setQty(BILL_A, 'line-1', 4));

    expect(await totalUnsent()).toBe(2);

    const { send, seen } = recorder(ok);
    await flushOutbox(send);

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'updateLine', qty: 4 });
  });

  it('does not collapse across two different lines', async () => {
    await enqueue(setQty(BILL_A, 'line-1', 2));
    await enqueue(setQty(BILL_A, 'line-2', 5));
    await enqueue(setQty(BILL_A, 'line-1', 9));

    const { send, seen } = recorder(ok);
    await flushOutbox(send);

    expect(seen.map((m) => (m.kind === 'updateLine' ? [m.lineId, m.qty] : null))).toEqual([
      ['line-1', 2],
      ['line-2', 5],
      ['line-1', 9],
    ]);
  });
});

describe('losing the connection', () => {
  it('stops the pass and keeps everything queued', async () => {
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));

    const { send, seen } = recorder(() => ({ kind: 'offline' }));
    const result = await flushOutbox(send);

    expect(result.offline).toBe(true);
    // It stopped after the first failure instead of hammering a dead network.
    expect(seen).toHaveLength(1);
    expect(await totalUnsent()).toBe(2);
  });

  it('sends everything once the connection comes back', async () => {
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));
    await flushOutbox(recorder(() => ({ kind: 'offline' })).send);

    const result = await flushOutbox(recorder(ok).send);

    expect(result.sent).toBe(2);
    expect(await totalUnsent()).toBe(0);
  });
});

describe('when the server refuses', () => {
  it('blocks only the bill that was refused', async () => {
    // Table 7's dish sold out. Table 3's bill must still reach the server —
    // one bad bowl cannot freeze the whole evening's takings.
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));
    await enqueue(openBill(BILL_B));
    await enqueue(addLine(BILL_B, 'line-2'));

    const { send, seen } = recorder((mutation) =>
      mutation.orderId === BILL_A && mutation.kind === 'addLine'
        ? { kind: 'rejected', message: '"ก๋วยเตี๋ยวหมู" หมดแล้ว' }
        : { kind: 'ok' },
    );
    const result = await flushOutbox(send);

    expect(result.rejected).toBe(1);
    expect(result.sent).toBe(3);
    expect(await unsentCount(BILL_B)).toBe(0);
    expect(seen.map((m) => m.orderId)).toEqual([BILL_A, BILL_A, BILL_B, BILL_B]);
  });

  it('holds the rest of that bill back instead of sending it into the void', async () => {
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));
    await enqueue(addLine(BILL_A, 'line-2'));

    const { send, seen } = recorder((mutation) =>
      mutation.kind === 'createOrder'
        ? { kind: 'rejected', message: 'โต๊ะ A1 มีบิลค้างอยู่แล้ว' }
        : { kind: 'ok' },
    );
    await flushOutbox(send);

    expect(seen).toHaveLength(1);
    expect(await unsentCount(BILL_A)).toBe(3);
  });

  it("keeps the server's own Thai wording for staff to read", async () => {
    await enqueue(addLine(BILL_A, 'line-1'));
    await flushOutbox(
      recorder(() => ({ kind: 'rejected', message: '"ก๋วยเตี๋ยวหมู" หมดแล้ว' })).send,
    );

    const rejects = await rejectedItems();
    expect(rejects).toHaveLength(1);
    expect(rejects[0]!.error).toBe('"ก๋วยเตี๋ยวหมู" หมดแล้ว');
  });
});

describe('when the server is broken rather than unwilling', () => {
  it('tries a few more times before asking a person', async () => {
    await enqueue(addLine(BILL_A, 'line-1'));
    const { send } = recorder(() => ({ kind: 'retry', message: 'HTTP 500' }));

    for (let pass = 1; pass < MAX_ATTEMPTS; pass += 1) {
      await flushOutbox(send);
      expect(await rejectedItems()).toHaveLength(0);
    }

    await flushOutbox(send);
    expect(await rejectedItems()).toHaveLength(1);
  });
});

describe('draining', () => {
  it("adopts the server's version of a bill once nothing is queued for it", async () => {
    await enqueue(openBill(BILL_A));

    const serverOrder = { id: BILL_A, orderNo: '260730-004' } as never;
    const result = await flushOutbox(() =>
      Promise.resolve<SendOutcome>({ kind: 'ok', order: serverOrder }),
    );

    expect(result.drained).toEqual([BILL_A]);
    expect(result.orders.get(BILL_A)).toBe(serverOrder);
  });

  it('does not call a bill drained while it still has work queued', async () => {
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));

    const result = await flushOutbox((mutation) =>
      Promise.resolve<SendOutcome>(
        mutation.kind === 'createOrder' ? { kind: 'ok' } : { kind: 'rejected', message: 'ไม่ได้' },
      ),
    );

    expect(result.drained).toEqual([]);
  });
});

describe('recovering from a rejection', () => {
  it('puts the whole bill back in the queue on retry', async () => {
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));
    await flushOutbox(recorder(() => ({ kind: 'rejected', message: 'ไม่ได้' })).send);

    await retryOrder(BILL_A);

    const items = await db.outbox.where('orderId').equals(BILL_A).toArray();
    expect(items.every((item) => item.status === 'pending' && item.attempts === 0)).toBe(true);
  });

  it('throws away the whole chain on discard, not just the failing step', async () => {
    // Keeping "add a line" to a bill whose opening was refused would send it
    // nowhere for the rest of the day.
    await enqueue(openBill(BILL_A));
    await enqueue(addLine(BILL_A, 'line-1'));
    await enqueue(openBill(BILL_B));

    await discardOrder(BILL_A);

    expect(await unsentCount(BILL_A)).toBe(0);
    expect(await unsentCount(BILL_B)).toBe(1);
  });
});
