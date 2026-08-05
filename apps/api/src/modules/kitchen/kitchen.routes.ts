/**
 * Kitchen display endpoints.
 *
 * Guarded by `requireAuth` and nothing stronger. Marking a bowl cooked is not a
 * money action, and the person doing it is a cook with a STAFF login and wet
 * hands — putting a permission wall in front of "this is ready" would only
 * teach the kitchen to work from the counter's shouting instead of the screen.
 *
 * Every write broadcasts, so the OTHER screens follow. That matters more than
 * it looks: with two stations, the noodle cook closing their half of an order
 * is how the drinks station learns the table is nearly served.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { liveHub } from '../../realtime/hub.js';
import { requireAuth } from '../auth/guards.js';
import { KitchenService } from './kitchen.service.js';

const ticketParams = z.object({ id: z.string().uuid() });
const lineParams = z.object({ lineId: z.string().uuid() });
const boardQuery = z.object({ station: z.string().min(1).max(64).optional() });

export function registerKitchenRoutes(app: FastifyInstance): void {
  const service = new KitchenService(prisma);

  app.get('/kitchen/board', { preHandler: requireAuth }, async (request, reply) => {
    const { station } = boardQuery.parse(request.query ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await service.board(branch, station));
  });

  app.post('/kitchen/tickets/:id/start', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = ticketParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const ticket = await service.startTicket(branch, id);
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    return reply.send({ ticket });
  });

  app.post('/kitchen/tickets/:id/done', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = ticketParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const ticket = await service.completeTicket(branch, id);
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    return reply.send({ ticket });
  });

  app.post('/kitchen/tickets/:id/recall', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = ticketParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const ticket = await service.recallTicket(branch, id);
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    return reply.send({ ticket });
  });

  app.post('/kitchen/lines/:lineId/done', { preHandler: requireAuth }, async (request, reply) => {
    const { lineId } = lineParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const ticket = await service.completeLine(branch, lineId);
    liveHub.broadcast(branch.id, { type: 'kitchen' });
    return reply.send({ ticket });
  });
}
