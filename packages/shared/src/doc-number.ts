/**
 * Document numbering.
 *
 * PROJECT RULE #9: document numbers come from the `DocSequence` table, scoped
 * by branch + docType + year. They are NEVER derived from an order id, because
 * order ids are UUIDs generated offline on the tablet and carry no ordering.
 *
 * Tax invoice numbers are ONLINE ONLY. An offline device may print a short
 * receipt but must never allocate a tax invoice number, or two tablets will
 * hand out the same number to two different customers.
 *
 * The allocation itself (SELECT ... FOR UPDATE / atomic increment) lives in the
 * API. This file only owns the format, so the receipt template and the API
 * cannot drift apart.
 */

import { DocType, isOnlineOnlyDocType } from './enums.js';

export const DOC_TYPE_PREFIX: Readonly<Record<DocType, string>> = {
  [DocType.RECEIPT]: 'RC',
  [DocType.TAX_INVOICE]: 'TX',
  [DocType.CREDIT_NOTE]: 'CN',
};

export interface DocNumberParts {
  /** Short branch code, e.g. "HQ", "BR02". Uppercased in the output. */
  branchCode: string;
  docType: DocType;
  /** Christian era year, e.g. 2026. */
  year: number;
  /** Running number within (branch, docType, year), starting at 1. */
  sequence: number;
}

/** Formats as `RC-HQ-2026-000123`. */
export function formatDocNumber(parts: DocNumberParts): string {
  const { branchCode, docType, year, sequence } = parts;
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`sequence must be a positive integer, got ${sequence}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`year must be a 4-digit CE year, got ${year}`);
  }
  const code = branchCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(code)) {
    throw new RangeError(`branchCode must be 1-8 alphanumeric chars, got "${branchCode}"`);
  }
  return `${DOC_TYPE_PREFIX[docType]}-${code}-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Guard to call before allocating a number. Throws when an offline device
 * tries to issue a document that legally requires a server round-trip.
 */
export function assertCanIssueOffline(docType: DocType, isOnline: boolean): void {
  if (!isOnline && isOnlineOnlyDocType(docType)) {
    throw new Error(
      `${docType} cannot be issued while offline. Print a short receipt now and issue the tax invoice once the connection is back.`,
    );
  }
}
