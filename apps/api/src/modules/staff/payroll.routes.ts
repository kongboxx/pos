/**
 * `/api/payroll` — the monthly run.
 *
 * Every response is the whole month, for the reason the expense screen has the
 * same habit: typing one person's days changes the run total, the double-count
 * warning and whether the pay button is usable at all. Sending back one line
 * would leave the rest of the screen showing the state from before it.
 *
 * Reads need VIEW_PAYROLL and writes need MANAGE_STAFF — both owner-only. A
 * payroll screen is a list of what everybody in the shop earns.
 */

import type { FastifyInstance } from 'fastify';
import {
  payrollLineUpdateSchema,
  payrollPayRequestSchema,
  payrollQuerySchema,
  Permission,
  yearMonthSchema,
} from '@pos/shared';
import { z } from 'zod';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { requirePermission } from '../auth/guards.js';
import { PayrollService } from './payroll.service.js';

const monthParams = z.object({ yearMonth: yearMonthSchema });
const lineParams = z.object({ id: z.string().uuid() });

export function registerPayrollRoutes(app: FastifyInstance): void {
  const service = new PayrollService(prisma);
  const readPayroll = requirePermission(Permission.VIEW_PAYROLL, 'ดูเงินเดือน');
  const writePayroll = requirePermission(Permission.MANAGE_STAFF, 'จัดการเงินเดือน');

  app.get('/payroll', { preHandler: readPayroll }, async (request, reply) => {
    const { month } = payrollQuerySchema.parse(request.query);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await service.snapshot(branch, month));
  });

  app.post('/payroll/:yearMonth/generate', { preHandler: writePayroll }, async (request, reply) => {
    const { yearMonth } = monthParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    await service.generate(branch, yearMonth, request.user.staffId);
    return reply.status(201).send(await service.snapshot(branch, yearMonth));
  });

  app.put('/payroll/lines/:id', { preHandler: writePayroll }, async (request, reply) => {
    const { id } = lineParams.parse(request.params);
    const body = payrollLineUpdateSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const yearMonth = await service.updateLine(branch, id, body);
    return reply.send(await service.snapshot(branch, yearMonth));
  });

  app.post('/payroll/:yearMonth/pay', { preHandler: writePayroll }, async (request, reply) => {
    const { yearMonth } = monthParams.parse(request.params);
    const body = payrollPayRequestSchema.parse(request.body);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    await service.pay(branch, yearMonth, body, request.user.staffId);
    return reply.send(await service.snapshot(branch, yearMonth));
  });

  app.post('/payroll/:yearMonth/unpay', { preHandler: writePayroll }, async (request, reply) => {
    const { yearMonth } = monthParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    await service.unpay(branch, yearMonth, request.user.staffId);
    return reply.send(await service.snapshot(branch, yearMonth));
  });

  app.delete('/payroll/:yearMonth', { preHandler: writePayroll }, async (request, reply) => {
    const { yearMonth } = monthParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    await service.discard(branch, yearMonth, request.user.staffId);
    return reply.send(await service.snapshot(branch, yearMonth));
  });
}
