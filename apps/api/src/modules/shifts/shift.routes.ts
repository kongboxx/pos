/**
 * `/api/shifts` — เปิดกะ / ปิดกะ / นับเงินลิ้นชัก.
 *
 * WHO MAY DO WHAT, and why it is split this way:
 *
 *  - OPENING AND CLOSING is TAKE_PAYMENT, so the cashier who works the drawer
 *    is the one who counts it. Requiring a manager to close would mean the
 *    count happens whenever the manager is free rather than at the moment the
 *    money stops moving, and a count taken an hour later counts a different
 *    drawer.
 *  - READING THE HISTORY is VIEW_REPORTS. The variance is the number that
 *    starts a conversation about a missing ฿500, and that conversation belongs
 *    to whoever is responsible for the shop, not to everyone who works a till.
 *
 * Deliberately NOT gated behind an approver PIN. A daily routine that needs a
 * supervisor is a routine that gets skipped, and skipping it costs more than
 * the honesty it was supposed to buy — the protection here is that the count is
 * written down with a name and a time on it, not that it was hard to write.
 */

import type { FastifyInstance } from 'fastify';
import { closeShiftRequestSchema, openShiftRequestSchema, Permission } from '@pos/shared';
import { z } from 'zod';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { requirePermission } from '../auth/guards.js';
import { ShiftService, type Actor } from './shift.service.js';

/** How many past shifts the history screen asks for. */
const shiftListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

export function registerShiftRoutes(app: FastifyInstance): void {
  const service = new ShiftService(prisma);

  const workDrawer = requirePermission(Permission.TAKE_PAYMENT, 'เปิด-ปิดกะ');
  const readShifts = requirePermission(Permission.VIEW_REPORTS, 'ดูรายงาน');

  app.get('/shifts/current', { preHandler: workDrawer }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send({ shift: await service.current(branch.id) });
  });

  app.post('/shifts/open', { preHandler: workDrawer }, async (request, reply) => {
    const body = openShiftRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const shift = await service.open(branch.id, actorOf(request.user), body);
    return reply.status(201).send({ shift });
  });

  /**
   * POST rather than PATCH on a shift id: the caller closes "the open shift",
   * and it never has to know which one that is. A tablet that had been asleep
   * cannot close yesterday's shift by holding a stale id.
   */
  app.post('/shifts/close', { preHandler: workDrawer }, async (request, reply) => {
    const body = closeShiftRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const shift = await service.close(branch.id, actorOf(request.user), body);
    return reply.send({ shift });
  });

  app.get('/shifts', { preHandler: readShifts }, async (request, reply) => {
    const { limit } = shiftListQuerySchema.parse(request.query);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send({ shifts: await service.list(branch.id, limit) });
  });
}

function actorOf(user: { staffId: string; fullName: string }): Actor {
  return { staffId: user.staffId, fullName: user.fullName };
}
