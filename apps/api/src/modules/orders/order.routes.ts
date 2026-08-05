/**
 * Floor plan and bill endpoints.
 *
 * Note which permission guards which route. TAKE_ORDER covers opening a bill
 * and putting food on it; TAKE_PAYMENT covers money leaving the customer's
 * hand. STAFF holds both — the split matters the day a branch wants order-only
 * terminals, and it costs nothing to get right now.
 *
 * Every handler resolves the branch from the SESSION, never from a parameter.
 */

import type { FastifyInstance } from 'fastify';
import {
  addOrderLineRequestSchema,
  approveQrLinesRequestSchema,
  buildPromptPayPayload,
  clearDiscountRequestSchema,
  createOrderRequestSchema,
  discountRequestSchema,
  fireOrderRequestSchema,
  mergeBillsRequestSchema,
  moveTableRequestSchema,
  payOrderRequestSchema,
  Permission,
  splitBillRequestSchema,
  rejectQrLinesRequestSchema,
  updateOrderLineRequestSchema,
  voidLineRequestSchema,
} from '@pos/shared';
import { z } from 'zod';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { badRequest } from '../../http-error.js';
import { liveHub } from '../../realtime/hub.js';
import { requireAuth, requirePermission } from '../auth/guards.js';
import { PrintService } from '../print/print.service.js';
import { OrderService, type Actor } from './order.service.js';

const orderIdParams = z.object({ id: z.string().uuid() });
const lineParams = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });
const printOptionsSchema = z.object({
  width: z.number().int().min(24).max(96).optional(),
  station: z.string().min(1).max(64).optional(),
});

export function registerOrderRoutes(app: FastifyInstance): void {
  const service = new OrderService(prisma, new PrintService(prisma));

  const takeOrder = requirePermission(Permission.TAKE_ORDER, 'รับออร์เดอร์');
  const takePayment = requirePermission(Permission.TAKE_PAYMENT, 'รับชำระเงิน');
  // Requesting a void is a STAFF permission on purpose. The gate is the
  // APPROVER's PIN, checked inside the service — a cashier who could not even
  // ask would just fetch the manager to do the whole thing, and the record
  // would then say the manager rang it up.
  const requestVoid = requirePermission(Permission.REQUEST_VOID, 'ขอยกเลิกรายการ');
  const approveQr = requirePermission(Permission.APPROVE_QR_ORDER, 'ยืนยันออร์เดอร์จาก QR');

  /* ---------------- floor plan ---------------- */

  app.get('/tables', { preHandler: requireAuth }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send({ tables: await service.listTables(branch) });
  });

  /* ---------------- bills ---------------- */

  app.get('/orders/open', { preHandler: requireAuth }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send({ orders: await service.listOpen(branch, actorOf(request.user)) });
  });

  app.get('/orders/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send({ order: await service.getOrder(branch, id, actorOf(request.user)) });
  });

  app.post('/orders', { preHandler: takeOrder }, async (request, reply) => {
    const body = createOrderRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.createOrder(branch, actorOf(request.user), body);
    return reply.status(201).send({ order });
  });

  app.post('/orders/:id/lines', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = addOrderLineRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.addLine(branch, actorOf(request.user), id, body);
    return reply.status(201).send({ order });
  });

  app.patch('/orders/:id/lines/:lineId', { preHandler: takeOrder }, async (request, reply) => {
    const { id, lineId } = lineParams.parse(request.params);
    const body = updateOrderLineRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.updateLine(branch, actorOf(request.user), id, lineId, {
      qty: body.qty,
      note: body.note ?? null,
      ...(body.modifierIds ? { modifierIds: body.modifierIds } : {}),
    });
    return reply.send({ order });
  });

  app.delete('/orders/:id/lines/:lineId', { preHandler: takeOrder }, async (request, reply) => {
    const { id, lineId } = lineParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.removeLine(branch, actorOf(request.user), id, lineId);
    return reply.send({ order });
  });

  app.post('/orders/:id/cancel', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.cancelOrder(branch, actorOf(request.user), id);
    return reply.send({ order });
  });

  /* ---------------- ย้ายโต๊ะ / รวมบิล / แยกบิล ---------------- */

  /**
   * All three sit behind TAKE_ORDER, not behind an approver's PIN.
   *
   * The PIN on a void or a discount is there because money leaves the bill.
   * Nothing here changes a total: every line keeps the price and cost it was
   * rung up at (rule #7) and keeps its own id (rule #6) — the rows just end up
   * under a different bill. What protects the shop is the audit row, which
   * names who did it and what it looked like before (rule #8).
   *
   * Making a cashier fetch a manager to move a table would mean tables get
   * moved on paper and not in the system, which is the failure this feature
   * exists to prevent.
   *
   * Each broadcasts 'tables' as well as 'order': the floor plan on every other
   * tablet is now wrong, and it is the screen the shop stands in front of.
   */
  app.post('/orders/:id/move-table', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = moveTableRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.moveTable(branch, actorOf(request.user), id, body);

    // The kitchen too: a ticket being cooked now names a different table, and
    // the runner is about to read it.
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    liveHub.broadcast(branch.id, { type: 'tables' });
    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.send({ order });
  });

  app.post('/orders/:id/merge', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = mergeBillsRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.mergeBills(branch, actorOf(request.user), id, body);

    liveHub.broadcast(branch.id, { type: 'kitchen' });
    liveHub.broadcast(branch.id, { type: 'tables' });
    liveHub.broadcast(branch.id, { type: 'order', orderId: id });
    // Whoever has the absorbed bill open on another tablet is looking at a
    // cancelled bill and does not know it yet.
    liveHub.broadcast(branch.id, { type: 'order', orderId: body.fromOrderId });

    return reply.send({ order });
  });

  app.post('/orders/:id/split', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = splitBillRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const result = await service.splitBill(branch, actorOf(request.user), id, body);

    liveHub.broadcast(branch.id, { type: 'tables' });
    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.status(201).send(result);
  });

  /* ---------------- QR orders waiting for a human (Step 7) ---------------- */

  app.get('/orders/pending-approval', { preHandler: approveQr }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send({ orders: await service.listPendingApproval(branch) });
  });

  app.post('/orders/:id/approve', { preHandler: approveQr }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = approveQrLinesRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const result = await service.approveLines(branch, actorOf(request.user), id, body);

    // 'qr' clears the badge on every other tablet's floor plan; 'kitchen' is
    // for the board that just got a ticket; 'order' is for whoever has this
    // bill open. All three after the write, for the reason on /fire below.
    liveHub.broadcast(branch.id, { type: 'qr' });
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.send(result);
  });

  app.post('/orders/:id/reject', { preHandler: approveQr }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = rejectQrLinesRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.rejectLines(branch, actorOf(request.user), id, body);

    liveHub.broadcast(branch.id, { type: 'qr' });
    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.send({ order });
  });

  /* ---------------- kitchen ---------------- */

  app.post('/orders/:id/fire', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = fireOrderRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const result = await service.fireLines(branch, actorOf(request.user), id, body);

    // Told AFTER the transaction committed. Announcing a ticket that then fails
    // to save would put food on the kitchen screen that nobody ordered.
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.send(result);
  });

  app.post(
    '/orders/:id/lines/:lineId/void',
    { preHandler: requestVoid },
    async (request, reply) => {
      const { id, lineId } = lineParams.parse(request.params);
      const body = voidLineRequestSchema.parse(request.body ?? {});
      const branch = await requireSessionBranch(prisma, request.user.branchId);
      const order = await service.voidLine(branch, actorOf(request.user), id, lineId, body);

      // The kitchen may be cooking this right now — telling them is the urgent
      // half of a void, and the reason it goes out on the socket rather than
      // waiting for the board's next poll.
      liveHub.broadcast(branch.id, { type: 'kitchen' });
      liveHub.broadcast(branch.id, { type: 'order', orderId: id });

      return reply.send({ order });
    },
  );

  /* ---------------- discount ---------------- */

  /**
   * Behind REQUEST_VOID rather than a discount permission of its own, for the
   * same reason the void route is: the gate is the APPROVER's PIN, checked in
   * the service. A cashier who could not even ask would fetch the manager to
   * work the tablet, and the record would then say the manager rang it up.
   *
   * Both routes broadcast 'order' and nothing else — the kitchen does not care
   * what a bowl was charged, and a discount changes no ticket.
   */
  app.post('/orders/:id/discount', { preHandler: requestVoid }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = discountRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.setDiscount(branch, actorOf(request.user), id, body);

    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.send({ order });
  });

  app.delete('/orders/:id/discount', { preHandler: requestVoid }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = clearDiscountRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.clearDiscount(branch, actorOf(request.user), id, body);

    liveHub.broadcast(branch.id, { type: 'order', orderId: id });

    return reply.send({ order });
  });

  /* ---------------- print & pay ---------------- */

  app.post('/orders/:id/print-check', { preHandler: takeOrder }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const options = printOptionsSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const job = await service.printCheck(branch, actorOf(request.user), id, options);
    return reply.status(202).send(job);
  });

  /**
   * The string to draw as a PromptPay QR for this bill.
   *
   * The payload is built on the SERVER so the shop's PromptPay id never has to
   * be shipped to a tablet — the till gets a QR for exactly this amount and
   * nothing it could reuse. The amount comes from the stored total, not from
   * the request, so a tampered client cannot ask a customer for more.
   */
  app.get('/orders/:id/promptpay', { preHandler: takePayment }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const order = await service.getOrder(branch, id, actorOf(request.user));

    if (!branch.promptPayId) {
      throw badRequest('PROMPTPAY_NOT_CONFIGURED', 'สาขานี้ยังไม่ได้ตั้งค่าพร้อมเพย์');
    }
    if (order.totalSatang <= 0) {
      throw badRequest('ORDER_EMPTY', 'บิลยังไม่มียอด');
    }

    return reply.send({
      payload: buildPromptPayPayload({
        promptPayId: branch.promptPayId,
        amountSatang: order.totalSatang,
      }),
      amountSatang: order.totalSatang,
    });
  });

  app.post('/orders/:id/pay', { preHandler: takePayment }, async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = payOrderRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await service.pay(branch, actorOf(request.user), id, body));
  });
}

/** The session, narrowed to what the service needs to attribute an action. */
function actorOf(user: { staffId: string; role: Actor['role']; fullName: string }): Actor {
  return { staffId: user.staffId, role: user.role, fullName: user.fullName };
}
