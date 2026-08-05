/**
 * Menu management endpoints — everything behind MANAGE_MENU.
 *
 * One guard for the whole file, because there is no such thing as a half-safe
 * menu edit: the price a cashier can change is the price on the receipt.
 *
 * EVERY MUTATION ANSWERS WITH THE WHOLE MENU and broadcasts `menu` on the live
 * socket. The first is because a single ingredient edit moves the cost of
 * several dishes (see menu-admin.ts); the second is because "หมดแล้ว" pressed
 * here has to reach the tills that are taking orders right now, not the next
 * time somebody walks back to the floor plan.
 */

import type { FastifyInstance } from 'fastify';
import {
  availabilityRequestSchema,
  ingredientRequestSchema,
  menuCategoryRequestSchema,
  menuItemRequestSchema,
  modifierGroupRequestSchema,
  modifierRequestSchema,
  moveRequestSchema,
  Permission,
  saveRecipeRequestSchema,
  type MenuAdminMutationResponse,
} from '@pos/shared';
import { z } from 'zod';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { liveHub } from '../../realtime/hub.js';
import { requirePermission } from '../auth/guards.js';
import { MenuAdminService, type AdminActor } from './menu-admin.service.js';
import type { RecalculationSummary } from './recipe.service.js';

const idParams = z.object({ id: z.string().uuid() });
const groupParams = z.object({ groupId: z.string().uuid() });

export function registerMenuAdminRoutes(app: FastifyInstance): void {
  const service = new MenuAdminService(prisma);
  const manageMenu = requirePermission(Permission.MANAGE_MENU, 'จัดการเมนู');

  /**
   * Runs one edit, then answers with the menu as it now stands.
   *
   * The reload happens AFTER the write has committed, so what comes back is
   * what the next tablet to ask will also get — a snapshot built inside the
   * transaction could show the owner numbers nobody else can see yet.
   */
  const apply = async (
    branchId: string,
    work: () => Promise<RecalculationSummary>,
  ): Promise<MenuAdminMutationResponse> => {
    const recalculated = await work();
    liveHub.broadcast(branchId, { type: 'menu' });
    return { menu: await service.snapshot(branchId), recalculated };
  };

  app.get('/manage/menu', { preHandler: manageMenu }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await service.snapshot(branch.id));
  });

  /* ---------------- categories ---------------- */

  app.post('/manage/categories', { preHandler: manageMenu }, async (request, reply) => {
    const body = menuCategoryRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply
      .status(201)
      .send(await apply(branch.id, () => service.createCategory(branch.id, body)));
  });

  app.put('/manage/categories/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = menuCategoryRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.updateCategory(branch.id, id, body)));
  });

  app.delete('/manage/categories/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.deleteCategory(branch.id, id)));
  });

  /**
   * The order categories appear in on the till, which is not cosmetic: the
   * first tab is the one already open when a cashier reaches the screen, and
   * for a noodle shop that had better be the noodles.
   */
  app.post('/manage/categories/:id/move', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { direction } = moveRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.moveCategory(branch.id, id, direction)));
  });

  /* ---------------- menu items ---------------- */

  app.post('/manage/menu-items', { preHandler: manageMenu }, async (request, reply) => {
    const body = menuItemRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply
      .status(201)
      .send(await apply(branch.id, () => service.createMenuItem(branch.id, body)));
  });

  app.put('/manage/menu-items/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = menuItemRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(
      await apply(branch.id, () =>
        service.updateMenuItem(branch.id, actorOf(request.user), id, body),
      ),
    );
  });

  /** Where a dish sits in its category's grid — the best sellers go top left. */
  app.post('/manage/menu-items/:id/move', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { direction } = moveRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.moveMenuItem(branch.id, id, direction)));
  });

  app.patch(
    '/manage/menu-items/:id/availability',
    { preHandler: manageMenu },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = availabilityRequestSchema.parse(request.body ?? {});
      const branch = await requireSessionBranch(prisma, request.user.branchId);
      return reply.send(
        await apply(branch.id, () => service.setAvailability(branch.id, id, body.isAvailable)),
      );
    },
  );

  app.delete('/manage/menu-items/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.deleteMenuItem(branch.id, id)));
  });

  app.put('/manage/menu-items/:id/recipe', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = saveRecipeRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(
      await apply(branch.id, () => service.saveMenuItemRecipe(branch.id, id, body)),
    );
  });

  /* ---------------- ingredients ---------------- */

  app.post('/manage/ingredients', { preHandler: manageMenu }, async (request, reply) => {
    const body = ingredientRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply
      .status(201)
      .send(await apply(branch.id, () => service.createIngredient(branch.id, body)));
  });

  app.put('/manage/ingredients/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = ingredientRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(
      await apply(branch.id, () =>
        service.updateIngredient(branch.id, actorOf(request.user), id, body),
      ),
    );
  });

  app.delete('/manage/ingredients/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.deleteIngredient(branch.id, id)));
  });

  /* ---------------- option groups ---------------- */

  app.post('/manage/modifier-groups', { preHandler: manageMenu }, async (request, reply) => {
    const body = modifierGroupRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply
      .status(201)
      .send(await apply(branch.id, () => service.createModifierGroup(branch.id, body)));
  });

  app.put('/manage/modifier-groups/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = modifierGroupRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(
      await apply(branch.id, () => service.updateModifierGroup(branch.id, id, body)),
    );
  });

  app.delete('/manage/modifier-groups/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.deleteModifierGroup(branch.id, id)));
  });

  app.post(
    '/manage/modifier-groups/:groupId/modifiers',
    { preHandler: manageMenu },
    async (request, reply) => {
      const { groupId } = groupParams.parse(request.params);
      const body = modifierRequestSchema.parse(request.body ?? {});
      const branch = await requireSessionBranch(prisma, request.user.branchId);
      return reply
        .status(201)
        .send(await apply(branch.id, () => service.createModifier(branch.id, groupId, body)));
    },
  );

  app.put('/manage/modifiers/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = modifierRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.updateModifier(branch.id, id, body)));
  });

  app.delete('/manage/modifiers/:id', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await apply(branch.id, () => service.deleteModifier(branch.id, id)));
  });

  app.put('/manage/modifiers/:id/recipe', { preHandler: manageMenu }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = saveRecipeRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(
      await apply(branch.id, () => service.saveModifierRecipe(branch.id, id, body)),
    );
  });
}

function actorOf(user: { staffId: string; fullName: string }): AdminActor {
  return { staffId: user.staffId, fullName: user.fullName };
}
