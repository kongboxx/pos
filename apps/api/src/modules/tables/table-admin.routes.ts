/**
 * `/api/manage/tables` — the floor plan, the stickers and the off switch.
 *
 * Step 7 built the last two. The layout itself came from the seed, which was
 * fine right up until a real shop had to arrange its own room — so this is now
 * the screen that owns the floor plan as well.
 *
 * THE THREE REFUSALS, in order of what they cost when missing:
 *
 *  1. A TABLE WITH AN OPEN BILL CANNOT BE RETIRED OR DELETED. Retiring takes
 *     it off the floor plan, and a bill on a table nobody can see is food that
 *     was served and can never be charged for.
 *
 *  2. A TABLE THAT HAS EVER HELD A BILL CANNOT BE DELETED. `Order.tableId` is
 *     an optional relation, so Postgres would quietly set it null rather than
 *     refuse — every past bill and every daily report would lose the table
 *     name, and the sittings that tie several bills into one visit would
 *     cascade away with it. "ปิดใช้" is the exit; DELETE is only for a row
 *     typed by mistake five minutes ago. Same rule, same reason, as staff.
 *
 *  3. TWO TABLES CANNOT SHARE A NAME. The database already refuses
 *     (`@@unique([branchId, name])`); what this adds is a Thai sentence
 *     instead of a 500, because "A1" being taken is the single most likely
 *     thing to happen while somebody types in a room full of tables.
 *
 * A RENAME DOES NOT TOUCH THE QR TOKEN. The sticker is printed and stuck to
 * furniture; correcting "A1" to "A01" must not send anyone round the room with
 * a scraper. Rotating a token stays its own deliberate, confirmed button.
 *
 * The printable URL is built by the BROWSER, not here. This process knows it is
 * running on localhost:3001, which is precisely the address a customer's phone
 * cannot reach; whoever is looking at the management screen is already at an
 * address that works from inside the shop. See qrOrderUrl in @pos/shared.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  OrderStatus,
  Permission,
  qrOrderingRequestSchema,
  tableMoveRequestSchema,
  tableRequestSchema,
  type TableQrResponse,
} from '@pos/shared';
import { z } from 'zod';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { conflict, notFound } from '../../http-error.js';
import { requirePermission } from '../auth/guards.js';
import { newQrToken } from '../qr/qr-token.js';

const tableIdParams = z.object({ id: z.string().uuid() });

export function registerTableAdminRoutes(app: FastifyInstance): void {
  const manageTables = requirePermission(Permission.MANAGE_TABLES, 'จัดการโต๊ะ');

  /**
   * The whole floor plan on every response, like the expense and payroll
   * screens: adding a table changes the zone it lands in, moving one changes
   * its neighbour, and retiring one changes which stickers are printable.
   * Sending back a single row would leave the rest of the screen showing the
   * state from before it.
   */
  const snapshot = async (branchId: string): Promise<TableQrResponse> => {
    const [branch, tables, openByTable, historyByTable] = await Promise.all([
      prisma.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { qrOrderingEnabled: true },
      }),
      prisma.diningTable.findMany({
        where: { branchId },
        orderBy: [{ zone: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          zone: true,
          seats: true,
          sortOrder: true,
          isActive: true,
          qrToken: true,
        },
      }),
      prisma.order.groupBy({
        by: ['tableId'],
        where: { branchId, status: OrderStatus.OPEN, tableId: { not: null } },
        _count: { _all: true },
      }),
      // Every table that has EVER held a bill, in one pass. Per-table counts
      // would be one query per table, and this list is the whole room.
      prisma.order.findMany({
        where: { branchId, tableId: { not: null } },
        select: { tableId: true },
        distinct: ['tableId'],
      }),
    ]);

    const open = new Set(openByTable.map((row) => row.tableId));
    const used = new Set(historyByTable.map((row) => row.tableId));

    return {
      orderingEnabled: branch.qrOrderingEnabled,
      tables: tables.map((table) => ({
        ...table,
        hasOpenBill: open.has(table.id),
        hasHistory: used.has(table.id),
      })),
    };
  };

  const audit = (
    branchId: string,
    staffId: string,
    action: string,
    entityId: string,
    change?: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue },
  ) =>
    prisma.auditLog.create({
      data: {
        branchId,
        staffId,
        action,
        entityType: 'DiningTable',
        entityId,
        before: change?.before ?? Prisma.JsonNull,
        after: change?.after ?? Prisma.JsonNull,
      },
    });

  app.get('/manage/tables', { preHandler: manageTables }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    return reply.send(await snapshot(branch.id));
  });

  /**
   * Adds a table to the end of its zone.
   *
   * The QR token is issued here rather than left for later: the column is
   * NOT NULL and unique, and a table with no sticker is a table whose QR
   * management screen has a hole in it that nobody would notice until a
   * customer scanned nothing.
   */
  app.post('/manage/tables', { preHandler: manageTables }, async (request, reply) => {
    const body = tableRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const last = await prisma.diningTable.findFirst({
      where: { branchId: branch.id, zone: body.zone },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    let created;
    try {
      created = await prisma.diningTable.create({
        data: {
          branchId: branch.id,
          name: body.name,
          zone: body.zone,
          seats: body.seats,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          isActive: body.isActive,
          qrToken: newQrToken(),
        },
      });
    } catch (error) {
      throw asNameClash(error, body.name);
    }

    await audit(branch.id, request.user.staffId, 'CREATE_TABLE', created.id, {
      after: { name: created.name, zone: created.zone, seats: created.seats },
    });

    return reply.status(201).send(await snapshot(branch.id));
  });

  app.put('/manage/tables/:id', { preHandler: manageTables }, async (request, reply) => {
    const { id } = tableIdParams.parse(request.params);
    const body = tableRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const before = await prisma.diningTable.findFirst({ where: { id, branchId: branch.id } });
    if (!before) throw notFound('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้');

    // Retiring hides it from the floor plan. A bill on a hidden table is food
    // that was served and can never be charged for.
    if (before.isActive && !body.isActive) {
      await assertNoOpenBill(branch.id, id, 'ปิดใช้');
    }

    let updated;
    try {
      updated = await prisma.diningTable.update({
        where: { id },
        // The zone can change, so the table moves to the end of its NEW zone
        // rather than keeping a sortOrder that means nothing there.
        data: {
          name: body.name,
          zone: body.zone,
          seats: body.seats,
          isActive: body.isActive,
          ...(before.zone === body.zone
            ? {}
            : { sortOrder: await nextSortOrder(branch.id, body.zone) }),
        },
      });
    } catch (error) {
      throw asNameClash(error, body.name);
    }

    await audit(branch.id, request.user.staffId, 'UPDATE_TABLE', id, {
      before: {
        name: before.name,
        zone: before.zone,
        seats: before.seats,
        isActive: before.isActive,
      },
      after: {
        name: updated.name,
        zone: updated.zone,
        seats: updated.seats,
        isActive: updated.isActive,
      },
    });

    return reply.send(await snapshot(branch.id));
  });

  app.delete('/manage/tables/:id', { preHandler: manageTables }, async (request, reply) => {
    const { id } = tableIdParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const table = await prisma.diningTable.findFirst({ where: { id, branchId: branch.id } });
    if (!table) throw notFound('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้');

    await assertNoOpenBill(branch.id, id, 'ลบ');

    const everUsed = await prisma.order.count({ where: { branchId: branch.id, tableId: id } });
    if (everUsed > 0) {
      throw conflict(
        'TABLE_HAS_HISTORY',
        `โต๊ะ ${table.name} เคยมีบิล ${everUsed} ใบ — ลบไม่ได้เพราะชื่อโต๊ะจะหายจากบิลเก่าทั้งหมด ใช้ "ปิดใช้" แทน`,
      );
    }

    await prisma.diningTable.delete({ where: { id } });
    await audit(branch.id, request.user.staffId, 'DELETE_TABLE', id, {
      before: { name: table.name, zone: table.zone, seats: table.seats },
    });

    return reply.send(await snapshot(branch.id));
  });

  /**
   * Swaps a table with its neighbour in the same zone.
   *
   * Server-side rather than "the form posts a sortOrder", because two tables
   * with the same number fall back to sorting by name — so the buttons would
   * sometimes move a table nowhere visible. The whole zone is renumbered
   * 0..n-1 on every move, which also cleans up whatever the seed left behind.
   */
  app.post('/manage/tables/:id/move', { preHandler: manageTables }, async (request, reply) => {
    const { id } = tableIdParams.parse(request.params);
    const { direction } = tableMoveRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const table = await prisma.diningTable.findFirst({ where: { id, branchId: branch.id } });
    if (!table) throw notFound('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้');

    const zone = await prisma.diningTable.findMany({
      where: { branchId: branch.id, zone: table.zone },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true },
    });

    const from = zone.findIndex((row) => row.id === id);
    const to = direction === 'UP' ? from - 1 : from + 1;
    // Already at the end: answer with the floor plan unchanged rather than an
    // error. The button is disabled on screen, and a 409 for pressing an edge
    // is noise, not information.
    if (from >= 0 && to >= 0 && to < zone.length) {
      const reordered = [...zone];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved as { id: string });

      await prisma.$transaction(
        reordered.map((row, index) =>
          prisma.diningTable.update({ where: { id: row.id }, data: { sortOrder: index } }),
        ),
      );
    }

    return reply.send(await snapshot(branch.id));
  });

  /**
   * Issues a new token for one table, which kills the sticker currently on it.
   *
   * The reason this button exists: the token is printed and public, so the
   * answer to "someone photographed our sticker and is sending junk" has to be
   * something a manager can do in ten seconds without a developer. It is
   * destructive by design — anyone whose phone still has the old page open gets
   * a "คิวอาร์นี้ใช้ไม่ได้แล้ว" the next time they touch it, which is exactly
   * what was asked for.
   */
  app.post('/manage/tables/:id/rotate-qr', { preHandler: manageTables }, async (request, reply) => {
    const { id } = tableIdParams.parse(request.params);
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    const updated = await prisma.diningTable.updateMany({
      where: { id, branchId: branch.id },
      data: { qrToken: newQrToken() },
    });
    if (updated.count === 0) throw notFound('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้');

    await audit(branch.id, request.user.staffId, 'ROTATE_TABLE_QR', id);

    return reply.send(await snapshot(branch.id));
  });

  /** The branch-wide switch. Off closes /api/qr/* for every table at once. */
  app.patch('/manage/qr-ordering', { preHandler: manageTables }, async (request, reply) => {
    const body = qrOrderingRequestSchema.parse(request.body ?? {});
    const branch = await requireSessionBranch(prisma, request.user.branchId);

    await prisma.branch.update({
      where: { id: branch.id },
      data: { qrOrderingEnabled: body.enabled },
    });
    await prisma.auditLog.create({
      data: {
        branchId: branch.id,
        staffId: request.user.staffId,
        action: 'SET_QR_ORDERING',
        entityType: 'Branch',
        entityId: branch.id,
        before: { qrOrderingEnabled: branch.qrOrderingEnabled },
        after: { qrOrderingEnabled: body.enabled },
      },
    });

    return reply.send(await snapshot(branch.id));
  });
}

/* ------------------------------------------------------------------ */

async function assertNoOpenBill(branchId: string, tableId: string, what: string): Promise<void> {
  const open = await prisma.order.count({
    where: { branchId, tableId, status: OrderStatus.OPEN },
  });
  if (open > 0) {
    throw conflict(
      'TABLE_HAS_OPEN_BILL',
      `โต๊ะนี้ยังมีบิลเปิดค้างอยู่ — เก็บเงินหรือยกเลิกบิลก่อนแล้วค่อย${what}`,
    );
  }
}

async function nextSortOrder(branchId: string, zone: string | null): Promise<number> {
  const last = await prisma.diningTable.findFirst({
    where: { branchId, zone },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

/**
 * Turns the unique-name violation into a sentence, and leaves anything else
 * alone.
 *
 * Narrow on purpose: swallowing every P2002 here would hide a duplicate
 * qrToken, which is a different and much stranger problem.
 */
function asNameClash(error: unknown, name: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = error.meta?.['target'];
    const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    if (fields.some((field) => field.includes('name'))) {
      return conflict('TABLE_NAME_TAKEN', `มีโต๊ะชื่อ "${name}" อยู่แล้ว ใช้ชื่ออื่น`);
    }
  }
  return error;
}
