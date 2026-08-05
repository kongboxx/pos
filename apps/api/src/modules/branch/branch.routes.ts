/**
 * `/api/branches` — the settings screen behind MANAGE_BRANCH (owner only).
 *
 * Reads return EVERY branch, writes may target any of them, and neither takes
 * a branchId from anywhere except the URL. That is not a hole in rule #1: the
 * rule protects a branch's TRADING DATA — its bills, its staff, its takings —
 * from being read or written by another branch's session. Settings are the one
 * thing an owner of several shops has to be able to manage without logging out
 * of one shop and into the next, and MANAGE_BRANCH is owner-only.
 *
 * Every write is audited against the branch the owner was working from.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { branchCreateSchema, branchSettingsSchema, Permission, uuidSchema } from '@pos/shared';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { requirePermission } from '../auth/guards.js';
import { BranchService } from './branch.service.js';

const branchParams = z.object({ id: uuidSchema });

export function registerBranchRoutes(app: FastifyInstance): void {
  const service = new BranchService(prisma);
  const manageBranch = requirePermission(Permission.MANAGE_BRANCH, 'จัดการสาขา');

  app.get('/branches', { preHandler: manageBranch }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const { branches, today } = await service.list(branch);
    return reply.send({ currentBranchId: branch.id, today, branches });
  });

  app.post('/branches', { preHandler: manageBranch }, async (request, reply) => {
    const body = branchCreateSchema.parse(request.body);
    // Confirms the session's own branch still exists before creating another.
    await requireSessionBranch(prisma, request.user.branchId);

    const created = await service.create(body, request.user.staffId);
    return reply.status(201).send(created);
  });

  app.put('/branches/:id', { preHandler: manageBranch }, async (request, reply) => {
    const { id } = branchParams.parse(request.params);
    const body = branchSettingsSchema.parse(request.body);
    const actorBranch = await requireSessionBranch(prisma, request.user.branchId);

    const updated = await service.update(id, body, request.user.staffId, actorBranch.id);
    return reply.send(updated);
  });
}
