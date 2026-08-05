/**
 * `/api/bills` and the two tax documents (Step 10).
 *
 * Permissions, and why they differ:
 *
 *  - reading the day's closed bills needs TAKE_PAYMENT. The cashier who took
 *    the money is the person a customer walks back to.
 *  - issuing a full tax invoice needs ISSUE_TAX_INVOICE (manager and up). It
 *    names a buyer and lets them reclaim tax; it is not a receipt reprint.
 *  - issuing a credit note ALSO needs ISSUE_TAX_INVOICE to ask, plus a
 *    supervisor PIN inside the service to actually do it. Same shape as a void
 *    (rule #8): the person asking and the person approving are two people.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  creditNoteRequestSchema,
  paidBillQuerySchema,
  Permission,
  taxInvoiceRequestSchema,
  uuidSchema,
} from '@pos/shared';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { requirePermission } from '../auth/guards.js';
import { branchBusinessDate } from '../orders/order.mapper.js';
import type { Actor } from '../orders/order.service.js';
import { PrintService } from '../print/print.service.js';
import { TaxDocService } from './tax-doc.service.js';

const orderParams = z.object({ id: uuidSchema });

export function registerTaxDocRoutes(app: FastifyInstance): void {
  const service = new TaxDocService(prisma, new PrintService(prisma));
  const takePayment = requirePermission(Permission.TAKE_PAYMENT, 'ดูบิลที่ปิดแล้ว');
  const issueTaxDoc = requirePermission(Permission.ISSUE_TAX_INVOICE, 'ออกใบกำกับภาษี');

  app.get('/bills', { preHandler: takePayment }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    // Defaults to the branch's own trading day rather than the server's date,
    // so a bill rung up at 00:30 is still on "today" until the cutoff (rule #4).
    const query = paidBillQuerySchema.partial().parse(request.query ?? {});
    const businessDate = query.date ?? branchBusinessDate(branch);

    return reply.send(await service.listPaidBills(branch, businessDate));
  });

  app.post('/bills/:id/tax-invoice', { preHandler: issueTaxDoc }, async (request, reply) => {
    const { id } = orderParams.parse(request.params);
    const body = taxInvoiceRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const result = await service.issueTaxInvoice(branch, actorOf(request.user), id, body);
    return reply.status(201).send(result);
  });

  app.post('/bills/:id/credit-note', { preHandler: issueTaxDoc }, async (request, reply) => {
    const { id } = orderParams.parse(request.params);
    const body = creditNoteRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const result = await service.issueCreditNote(branch, actorOf(request.user), id, body);
    return reply.status(201).send(result);
  });
}

function actorOf(user: { staffId: string; role: Actor['role']; fullName: string }): Actor {
  return { staffId: user.staffId, role: user.role, fullName: user.fullName };
}
