/**
 * Print job contract between the API and the print agent.
 *
 * The agent is a separate process on a Raspberry Pi in the shop. It may be
 * rebooting, unplugged, or out of paper at the exact moment a cashier presses
 * "print", so a job is a durable database row, not a fire-and-forget socket
 * message: queue it, let the agent claim it, record what happened.
 */

import { z } from 'zod';
import { uuidSchema } from './schemas.js';

export const PrintJobType = {
  /** Step 1: the printer proving slip. */
  TEST_RECEIPT: 'TEST_RECEIPT',
  /** Step 2+: a real customer receipt. */
  RECEIPT: 'RECEIPT',
  /** Step 5: a kitchen ticket. */
  KITCHEN_TICKET: 'KITCHEN_TICKET',
  /** Open the drawer with nothing to print (e.g. giving change from a till). */
  DRAWER_KICK: 'DRAWER_KICK',
} as const;
export type PrintJobType = (typeof PrintJobType)[keyof typeof PrintJobType];

export const PrintJobStatus = {
  QUEUED: 'QUEUED',
  /** An agent has taken it and is printing. */
  CLAIMED: 'CLAIMED',
  PRINTED: 'PRINTED',
  /** Out of attempts. Needs a human. */
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type PrintJobStatus = (typeof PrintJobStatus)[keyof typeof PrintJobStatus];

/** A job in CLAIMED for longer than this is assumed dead and is requeued. */
export const CLAIM_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/* ---------- receipt document (kept loose: it is validated by shape) ---------- */

const blockAlignSchema = z.enum(['left', 'center', 'right']);
const textSizeSchema = z.enum(['normal', 'wide', 'tall', 'large']);

export const receiptBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    align: blockAlignSchema.optional(),
    bold: z.boolean().optional(),
    size: textSizeSchema.optional(),
  }),
  z.object({
    type: z.literal('row'),
    left: z.string(),
    right: z.string(),
    bold: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('item'),
    qty: z.number().int().min(0),
    name: z.string(),
    amountSatang: z.number().int(),
    modifiers: z.array(z.string()).optional(),
    note: z.string().optional(),
  }),
  z.object({ type: z.literal('divider'), char: z.string().optional() }),
  z.object({ type: z.literal('blank'), lines: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('qr'), data: z.string(), caption: z.string().optional() }),
  z.object({ type: z.literal('openDrawer') }),
  z.object({ type: z.literal('cut') }),
]);

export const receiptDocSchema = z.object({
  width: z.number().int().min(24).max(96),
  blocks: z.array(receiptBlockSchema),
});

/* ---------- API <-> agent messages ---------- */

export const printJobSchema = z.object({
  id: uuidSchema,
  branchId: uuidSchema,
  station: z.string().min(1),
  type: z.nativeEnum(PrintJobType),
  document: receiptDocSchema,
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
});
export type PrintJob = z.infer<typeof printJobSchema>;

export const claimRequestSchema = z.object({
  /** Which printer this agent drives. One agent per station. */
  station: z.string().min(1).default('counter'),
  /** Stable id of this agent process, for the "who has it" column. */
  agentId: z.string().min(1),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimResponseSchema = z.object({
  job: printJobSchema.nullable(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const jobResultSchema = z.object({
  ok: z.boolean(),
  /** Present when ok is false. Shown to the cashier, so keep it readable. */
  error: z.string().max(500).optional(),
  /** How long the print took, for spotting a printer that is going slow. */
  durationMs: z.number().int().min(0).optional(),
});
export type JobResult = z.infer<typeof jobResultSchema>;

export const printJobStatusResponseSchema = z.object({
  id: uuidSchema,
  status: z.nativeEnum(PrintJobStatus),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  lastError: z.string().nullable(),
  claimedAt: z.string().nullable(),
  printedAt: z.string().nullable(),
});
export type PrintJobStatusResponse = z.infer<typeof printJobStatusResponseSchema>;

/** Terminal states: polling can stop once a job reaches one of these. */
export function isTerminalStatus(status: PrintJobStatus): boolean {
  return (
    status === PrintJobStatus.PRINTED ||
    status === PrintJobStatus.FAILED ||
    status === PrintJobStatus.CANCELLED
  );
}

/**
 * Whether a failed attempt should go back in the queue.
 * `attempts` is the count AFTER the failure that just happened.
 */
export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

/**
 * Backoff before the next attempt: 1s, 2s, 4s, capped at 30s.
 * Paper jams and "printer is off" clear on a human timescale, so backing off
 * beats hammering the socket.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}
