/**
 * `/api/qr/*` — the only routes in this system with NO session behind them.
 *
 * The credential is the token in the path, which is printed on a sticker in a
 * public room and must be assumed to leak. What stops that from mattering:
 *
 *  - Everything written lands as a request awaiting a member of staff.
 *  - Nothing readable here is worth stealing: one table's bill, and a menu that
 *    is on a board on the wall.
 *  - A branch-level switch closes the whole thing without peeling stickers off
 *    the furniture.
 *  - Two rate limiters keep a script from filling the approval queue faster
 *    than a human can empty it.
 *
 * Deliberately NOT here: paying. A customer's phone cannot settle a bill, and
 * PromptPay stays at the counter where a human reads the slip — see the note in
 * order.routes.ts about automatic verification needing a bank API.
 */

import type { FastifyInstance } from 'fastify';
import { qrSubmitRequestSchema, qrTokenSchema } from '@pos/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { tooManyRequests } from '../../http-error.js';
import { liveHub } from '../../realtime/hub.js';
import { PrintService } from '../print/print.service.js';
import { OrderService } from '../orders/order.service.js';
import { QrService } from './qr.service.js';
import { RateLimiter } from './rate-limit.js';

const tokenParams = z.object({ token: qrTokenSchema });

/**
 * Reads are generous, writes are not.
 *
 * The page polls every few seconds while it is open — that is how "รอพนักงาน
 * ยืนยัน" becomes "ส่งครัวแล้ว" without a socket the customer cannot
 * authenticate — so 60 reads a minute is a table with several phones on it, not
 * an attack. Six submissions a minute is already more orders than anyone types.
 */
const READ_LIMIT = new RateLimiter(60, 60_000);
const SUBMIT_LIMIT = new RateLimiter(6, 60_000);

/**
 * Clears the counters. For the route tests ONLY.
 *
 * A test file sends twenty orders to one table in ten seconds, which is exactly
 * the shape of the thing the limiter exists to refuse — and the first version
 * of qr.routes.test.ts failed halfway through for precisely that reason, which
 * is the nicest possible way to find out a limiter works.
 */
export function resetQrRateLimits(): void {
  READ_LIMIT.reset();
  SUBMIT_LIMIT.reset();
}

export function registerQrRoutes(app: FastifyInstance): void {
  const orders = new OrderService(prisma, new PrintService(prisma));
  const service = new QrService(prisma, orders);

  const limit = (limiter: RateLimiter, token: string, what: string): void => {
    const decision = limiter.check(token);
    if (decision.allowed) return;
    throw tooManyRequests('QR_RATE_LIMITED', `${what}เร็วเกินไป กรุณารอสักครู่`);
  };

  /** First load: shop, table, menu and whatever is already on the bill. */
  app.get('/qr/:token', async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    limit(READ_LIMIT, token, 'เปิดหน้าสั่งอาหาร');

    const scanned = await service.resolve(token);
    return reply.send(await service.tableView(scanned));
  });

  /** What the open page polls — the bill only, without re-sending the menu. */
  app.get('/qr/:token/bill', async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    limit(READ_LIMIT, token, 'ตรวจสอบรายการ');

    const scanned = await service.resolve(token);
    return reply.send({ bill: await service.bill(scanned) });
  });

  app.post('/qr/:token/order', async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    limit(SUBMIT_LIMIT, token, 'ส่งออร์เดอร์');

    const body = qrSubmitRequestSchema.parse(request.body ?? {});
    const scanned = await service.resolve(token);
    const result = await service.submit(scanned, body);

    // Told AFTER the write committed, and told even when `accepted` is 0: a
    // resend means the customer is still sitting there waiting, and a staff
    // screen that has been open for ten minutes should refresh its clock.
    //
    // Two events because two different screens care: the approvals queue and
    // the floor-plan badge listen for 'qr', the bill that happens to be open on
    // someone's tablet listens for its own id.
    liveHub.broadcast(scanned.branch.id, { type: 'qr' });
    liveHub.broadcast(scanned.branch.id, { type: 'order', orderId: result.orderId });

    return reply.status(201).send({ bill: result.bill, accepted: result.accepted });
  });
}
