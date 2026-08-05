import { describe, expect, it } from 'vitest';
import { DocType } from './enums.js';
import { assertCanIssueOffline, formatDocNumber } from './doc-number.js';

describe('formatDocNumber', () => {
  it('formats a receipt number', () => {
    expect(
      formatDocNumber({ branchCode: 'HQ', docType: DocType.RECEIPT, year: 2026, sequence: 123 }),
    ).toBe('RC-HQ-2026-000123');
  });

  it('uses a distinct prefix per document type', () => {
    const base = { branchCode: 'HQ', year: 2026, sequence: 1 };
    expect(formatDocNumber({ ...base, docType: DocType.TAX_INVOICE })).toBe('TX-HQ-2026-000001');
    expect(formatDocNumber({ ...base, docType: DocType.CREDIT_NOTE })).toBe('CN-HQ-2026-000001');
  });

  it('uppercases the branch code', () => {
    expect(
      formatDocNumber({ branchCode: 'br02', docType: DocType.RECEIPT, year: 2026, sequence: 7 }),
    ).toBe('RC-BR02-2026-000007');
  });

  it('rejects invalid inputs rather than emitting a broken document number', () => {
    const base = { branchCode: 'HQ', docType: DocType.RECEIPT, year: 2026, sequence: 1 };
    expect(() => formatDocNumber({ ...base, sequence: 0 })).toThrow(RangeError);
    expect(() => formatDocNumber({ ...base, sequence: 1.5 })).toThrow(RangeError);
    expect(() => formatDocNumber({ ...base, year: 26 })).toThrow(RangeError);
    expect(() => formatDocNumber({ ...base, branchCode: 'สาขา 1' })).toThrow(RangeError);
  });
});

describe('assertCanIssueOffline — project rule #9', () => {
  it('allows a short receipt while offline', () => {
    expect(() => assertCanIssueOffline(DocType.RECEIPT, false)).not.toThrow();
  });

  it('blocks a tax invoice while offline', () => {
    expect(() => assertCanIssueOffline(DocType.TAX_INVOICE, false)).toThrow(/offline/i);
  });

  it('blocks a credit note while offline', () => {
    expect(() => assertCanIssueOffline(DocType.CREDIT_NOTE, false)).toThrow(/offline/i);
  });

  it('allows everything while online', () => {
    for (const docType of Object.values(DocType)) {
      expect(() => assertCanIssueOffline(docType, true)).not.toThrow();
    }
  });
});
