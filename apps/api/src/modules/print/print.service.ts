/**
 * Print job queue.
 *
 * The only subtle part is claiming. Two agents (or one agent that restarted
 * and left a stale claim behind) must never print the same slip twice — a
 * duplicated receipt is a duplicated record of money changing hands.
 *
 * The claim is therefore a compare-and-swap: `updateMany` narrowed to the row
 * AND its expected status. Postgres serialises the two writers; exactly one
 * gets `count === 1` and the loser goes back to look for another job.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CLAIM_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  PrintJobStatus,
  receiptDocSchema,
  retryDelayMs,
  shouldRetry,
  type PrintJob,
  type PrintJobType,
  type ReceiptDoc,
} from '@pos/shared';

export interface EnqueueInput {
  branchId: string;
  station?: string;
  type: PrintJobType;
  document: ReceiptDoc;
  orderId?: string | null;
  maxAttempts?: number;
}

export class PrintService {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(input: EnqueueInput): Promise<{ id: string }> {
    // Validate before storing: a malformed document that only fails at print
    // time would sit in the queue burning retries against a real printer.
    const document = receiptDocSchema.parse(input.document);

    const job = await this.db.printJob.create({
      data: {
        branchId: input.branchId,
        station: input.station ?? 'counter',
        type: input.type,
        payload: document as unknown as Prisma.InputJsonValue,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        orderId: input.orderId ?? null,
      },
      select: { id: true },
    });
    return job;
  }

  /**
   * Hands the oldest available job for a station to one agent, or null.
   *
   * "Available" means QUEUED and past its retry backoff, OR CLAIMED so long
   * ago that the agent holding it is presumed dead.
   */
  async claimNext(branchId: string, station: string, agentId: string): Promise<PrintJob | null> {
    const now = new Date();
    const staleClaimBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS);

    // Look at a few candidates: another agent may win the race for the first.
    const candidates = await this.db.printJob.findMany({
      where: {
        branchId,
        station,
        OR: [
          { status: PrintJobStatus.QUEUED, availableAt: { lte: now } },
          { status: PrintJobStatus.CLAIMED, claimedAt: { lt: staleClaimBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
      select: { id: true, status: true },
    });

    for (const candidate of candidates) {
      // Compare-and-swap on (id, status). Only one writer can win.
      const claimed = await this.db.printJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: PrintJobStatus.CLAIMED,
          claimedAt: now,
          claimedBy: agentId,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue; // lost the race, try the next one

      const job = await this.db.printJob.findUniqueOrThrow({
        where: { id: candidate.id },
        select: {
          id: true,
          branchId: true,
          station: true,
          type: true,
          payload: true,
          attempts: true,
          maxAttempts: true,
        },
      });

      return {
        id: job.id,
        branchId: job.branchId,
        station: job.station,
        type: job.type,
        document: receiptDocSchema.parse(job.payload),
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      };
    }

    return null;
  }

  /** Marks a claimed job printed. Only the agent holding the claim may do so. */
  async reportSuccess(jobId: string, agentId: string): Promise<boolean> {
    const updated = await this.db.printJob.updateMany({
      where: { id: jobId, status: PrintJobStatus.CLAIMED, claimedBy: agentId },
      data: { status: PrintJobStatus.PRINTED, printedAt: new Date(), lastError: null },
    });
    return updated.count === 1;
  }

  /**
   * Records a failure. Requeues with backoff while attempts remain, otherwise
   * parks the job in FAILED so a human can look at the printer.
   */
  async reportFailure(jobId: string, agentId: string, error: string): Promise<boolean> {
    const job = await this.db.printJob.findUnique({
      where: { id: jobId },
      select: { attempts: true, maxAttempts: true, status: true, claimedBy: true },
    });
    if (!job || job.status !== PrintJobStatus.CLAIMED || job.claimedBy !== agentId) return false;

    const retry = shouldRetry(job.attempts, job.maxAttempts);
    const updated = await this.db.printJob.updateMany({
      where: { id: jobId, status: PrintJobStatus.CLAIMED, claimedBy: agentId },
      data: retry
        ? {
            status: PrintJobStatus.QUEUED,
            claimedAt: null,
            claimedBy: null,
            availableAt: new Date(Date.now() + retryDelayMs(job.attempts)),
            lastError: error.slice(0, 500),
          }
        : {
            status: PrintJobStatus.FAILED,
            claimedAt: null,
            claimedBy: null,
            lastError: error.slice(0, 500),
          },
    });
    return updated.count === 1;
  }

  async getStatus(branchId: string, jobId: string) {
    return this.db.printJob.findFirst({
      where: { id: jobId, branchId },
      select: {
        id: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        claimedAt: true,
        printedAt: true,
      },
    });
  }

  /** Recent jobs for the on-screen queue view. */
  async listRecent(branchId: string, limit = 20) {
    return this.db.printJob.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        station: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        createdAt: true,
        printedAt: true,
      },
    });
  }
}
