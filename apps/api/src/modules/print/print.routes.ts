/**
 * Print endpoints.
 *
 * Two audiences with different trust levels:
 *
 *   /api/print/*        — the PWA on the counter, behind the staff session
 *                         cookie since Step 2. A test slip costs paper and
 *                         bangs the drawer open, so it is not something an
 *                         unauthenticated device on the shop wifi may trigger.
 *   /api/print/agent/*  — the Raspberry Pi. Authenticated with a shared token
 *                         compared in constant time, because it is the one
 *                         caller allowed to mark money-adjacent documents as
 *                         printed.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  buildTestReceipt,
  claimRequestSchema,
  jobResultSchema,
  PrintJobType,
  WIDTH_80MM,
  type ReceiptDoc,
} from '@pos/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import type { Env } from '../../env.js';
import { requireAuth } from '../auth/guards.js';
import { PrintService } from './print.service.js';

const AGENT_TOKEN_HEADER = 'x-print-agent-token';

const testPrintBodySchema = z.object({
  /** Omit to use the only branch — convenient while there is exactly one. */
  branchId: z.string().uuid().optional(),
  station: z.string().min(1).max(64).default('counter'),
  /** 48 for 80mm, 32 for 58mm. */
  width: z.number().int().min(24).max(96).default(WIDTH_80MM),
  requestedBy: z.string().max(120).optional(),
  /** Set false when testing paper output without banging the drawer. */
  openDrawer: z.boolean().default(true),
});

export function registerPrintRoutes(app: FastifyInstance, options: { env: Env }): void {
  const service = new PrintService(prisma);
  const { env } = options;

  /* ---------------- counter-facing ---------------- */

  /** Queues the Step 1 proving slip and returns the job id to poll. */
  app.post('/print/test', { preHandler: requireAuth }, async (request, reply) => {
    const body = testPrintBodySchema.parse(request.body ?? {});

    const branch = body.branchId
      ? await prisma.branch.findUnique({ where: { id: body.branchId } })
      : await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });

    if (!branch) {
      return reply.status(404).send({
        error: 'BRANCH_NOT_FOUND',
        message: 'ยังไม่มีสาขาในระบบ — รัน pnpm db:seed ก่อน',
      });
    }

    const document = buildTestReceipt({
      shop: {
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        taxId: branch.taxId,
        branchCode: branch.branchCode,
      },
      printedAt: new Date(),
      requestedBy: body.requestedBy,
      width: body.width,
      openDrawer: body.openDrawer,
    });

    const job = await service.enqueue({
      branchId: branch.id,
      station: body.station,
      type: PrintJobType.TEST_RECEIPT,
      document,
    });

    return reply.status(202).send({ jobId: job.id, document });
  });

  /**
   * Renders the slip WITHOUT queueing it.
   * Lets the layout be checked on screen before any hardware exists.
   */
  app.post('/print/preview', { preHandler: requireAuth }, async (request, reply) => {
    const body = testPrintBodySchema.parse(request.body ?? {});
    const branch = await prisma.branch.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) {
      return reply.status(404).send({ error: 'BRANCH_NOT_FOUND', message: 'ยังไม่มีสาขาในระบบ' });
    }

    const document: ReceiptDoc = buildTestReceipt({
      shop: {
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        taxId: branch.taxId,
        branchCode: branch.branchCode,
      },
      printedAt: new Date(),
      requestedBy: body.requestedBy,
      width: body.width,
      openDrawer: body.openDrawer,
    });

    return reply.send({ document });
  });

  app.get('/print/jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const branch = await prisma.branch.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) return reply.status(404).send({ error: 'BRANCH_NOT_FOUND', message: 'ไม่พบสาขา' });

    const job = await service.getStatus(branch.id, id);
    if (!job) return reply.status(404).send({ error: 'JOB_NOT_FOUND', message: 'ไม่พบงานพิมพ์' });

    return reply.send({
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      claimedAt: job.claimedAt?.toISOString() ?? null,
      printedAt: job.printedAt?.toISOString() ?? null,
    });
  });

  app.get('/print/jobs', { preHandler: requireAuth }, async (_request, reply) => {
    const branch = await prisma.branch.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) return reply.status(404).send({ error: 'BRANCH_NOT_FOUND', message: 'ไม่พบสาขา' });
    return reply.send({ jobs: await service.listRecent(branch.id) });
  });

  /* ---------------- agent-facing ---------------- */

  const requireAgent = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const provided = request.headers[AGENT_TOKEN_HEADER];
    if (typeof provided !== 'string' || !constantTimeEquals(provided, env.PRINT_AGENT_TOKEN)) {
      await reply.status(401).send({ error: 'UNAUTHORIZED', message: 'print agent token invalid' });
    }
  };

  app.post('/print/agent/claim', { preHandler: requireAgent }, async (request, reply) => {
    const body = claimRequestSchema.parse(request.body ?? {});
    const branch = await prisma.branch.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) return reply.send({ job: null });

    const job = await service.claimNext(branch.id, body.station, body.agentId);
    return reply.send({ job });
  });

  app.post('/print/agent/jobs/:id/result', { preHandler: requireAgent }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const agentId = z.object({ agentId: z.string().min(1) }).parse(request.body).agentId;
    const result = jobResultSchema.parse(request.body);

    const accepted = result.ok
      ? await service.reportSuccess(id, agentId)
      : await service.reportFailure(id, agentId, result.error ?? 'unknown printer error');

    if (!accepted) {
      // The claim expired and someone else took the job, or it was cancelled.
      return reply.status(409).send({
        error: 'CLAIM_LOST',
        message: 'งานพิมพ์นี้ไม่ได้อยู่ในมือ agent นี้แล้ว',
      });
    }
    return reply.send({ ok: true });
  });
}

/** Compares two secrets without leaking their contents through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
