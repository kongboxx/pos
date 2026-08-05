/**
 * Document numbers (rule #9).
 *
 * Numbers come from the DocSequence table, scoped by (branch, docType, year).
 * They are NOT derived from the order id — order ids are UUIDs made on a
 * tablet that may have been offline, so they carry no order and no meaning to
 * an auditor.
 *
 * The increment is a single `upsert ... lastNumber: { increment: 1 }`, which
 * Postgres compiles to an atomic UPDATE under the unique index. Two cashiers
 * pressing "รับเงิน" at the same instant therefore get different numbers even
 * though neither transaction saw the other. Gaps are legal; duplicates are not.
 */

import type { Prisma } from '@prisma/client';
import { assertCanIssueOffline, formatDocNumber, type DocType } from '@pos/shared';

export interface DocNumberTarget {
  id: string;
  branchCode: string;
}

/**
 * Allocates the next number for a document type.
 *
 * MUST be called inside the same transaction that writes the document, so a
 * rolled-back sale does not burn a number that an auditor will ask about.
 */
export async function allocateDocNumber(
  tx: Prisma.TransactionClient,
  branch: DocNumberTarget,
  docType: DocType,
  /** Calendar year of the BUSINESS date, not of the server clock. */
  year: number,
  isOnline = true,
): Promise<string> {
  // Throws for TAX_INVOICE / CREDIT_NOTE when offline. A short receipt is
  // allowed offline, which is why this guard is per docType and not blanket.
  assertCanIssueOffline(docType, isOnline);

  const sequence = await tx.docSequence.upsert({
    where: { branchId_docType_year: { branchId: branch.id, docType, year } },
    create: { branchId: branch.id, docType, year, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return formatDocNumber({
    branchCode: branch.branchCode,
    docType,
    year,
    sequence: sequence.lastNumber,
  });
}
