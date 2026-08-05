/**
 * The menu the till draws its buttons from.
 *
 * Returned as categories with their items nested, in one request, because the
 * order screen needs all of it at once and a tablet on shop wifi should pay
 * for one round trip rather than one per category.
 *
 * Option groups (เส้น / น้ำซุป / พิเศษ) ride along in the SAME response, once
 * at the top level, with each item carrying only the ids it offers. The five
 * noodle groups are shared by every bowl; embedding them per item would repeat
 * the same ~25 options six times over for no gain.
 *
 * The query itself lives in menu.query.ts, shared with the customer QR page so
 * the two cannot end up showing different menus.
 */

import type { FastifyInstance } from 'fastify';
import { can, Permission } from '@pos/shared';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { requireAuth } from '../auth/guards.js';
import { loadMenuResponse } from './menu.query.js';

export function registerMenuRoutes(app: FastifyInstance): void {
  app.get('/menu', { preHandler: requireAuth }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    // Cost is a management figure. A cashier's tablet never receives it, so it
    // cannot be read out of the network tab.
    const includeCost = can(request.user.role, Permission.VIEW_COST);

    return reply.send(await loadMenuResponse(prisma, branch.id, includeCost));
  });
}
