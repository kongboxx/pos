import { describe, expect, it } from 'vitest';
import { buildTestReceipt } from './receipt.js';
import {
  isTerminalStatus,
  PrintJobStatus,
  receiptDocSchema,
  retryDelayMs,
  shouldRetry,
} from './print-job.js';

describe('receiptDocSchema — the document must survive a round trip through JSON', () => {
  it('accepts a real generated test receipt after JSON serialisation', () => {
    const doc = buildTestReceipt({
      shop: { name: 'ร้านทดสอบ', branchCode: 'HQ' },
      printedAt: new Date('2026-07-29T16:45:00Z'),
    });

    // This is exactly what the API stores in PrintJob.payload and the agent reads back.
    const roundTripped: unknown = JSON.parse(JSON.stringify(doc));
    const parsed = receiptDocSchema.safeParse(roundTripped);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.blocks.length).toBe(doc.blocks.length);
    }
  });

  it('rejects an unknown block type instead of printing garbage', () => {
    const result = receiptDocSchema.safeParse({
      width: 48,
      blocks: [{ type: 'explode', text: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a float amount inside an item', () => {
    const result = receiptDocSchema.safeParse({
      width: 48,
      blocks: [{ type: 'item', qty: 1, name: 'x', amountSatang: 60.5 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an implausible paper width', () => {
    expect(receiptDocSchema.safeParse({ width: 4, blocks: [] }).success).toBe(false);
    expect(receiptDocSchema.safeParse({ width: 500, blocks: [] }).success).toBe(false);
  });
});

describe('retry policy', () => {
  it('retries until the attempt budget is spent', () => {
    expect(shouldRetry(1, 3)).toBe(true);
    expect(shouldRetry(2, 3)).toBe(true);
    expect(shouldRetry(3, 3)).toBe(false);
    expect(shouldRetry(4, 3)).toBe(false);
  });

  it('backs off exponentially and caps out', () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(3)).toBe(4_000);
    expect(retryDelayMs(10)).toBe(30_000);
  });
});

describe('isTerminalStatus', () => {
  it('lets the UI stop polling once a job is settled', () => {
    expect(isTerminalStatus(PrintJobStatus.PRINTED)).toBe(true);
    expect(isTerminalStatus(PrintJobStatus.FAILED)).toBe(true);
    expect(isTerminalStatus(PrintJobStatus.CANCELLED)).toBe(true);
  });

  it('keeps polling while the job is still in flight', () => {
    expect(isTerminalStatus(PrintJobStatus.QUEUED)).toBe(false);
    expect(isTerminalStatus(PrintJobStatus.CLAIMED)).toBe(false);
  });
});
