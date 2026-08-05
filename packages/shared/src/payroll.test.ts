import { describe, expect, it } from 'vitest';
import { WageType } from './enums.js';
import {
  DEDUCTION_TYPES,
  DOCUMENT_WARNING_DAYS,
  daysBetween,
  deductionExceedsPay,
  deductionRequestSchema,
  deductionTypeLabel,
  documentExpiryState,
  grossSatangFor,
  isOnPayrollForMonth,
  netSatangFor,
  payrollLineUpdateSchema,
  staffCreateRequestSchema,
  staffDtoSchema,
  staffRequestSchema,
} from './payroll.js';

describe('gross pay', () => {
  it('multiplies the rate by the days for a daily wage', () => {
    expect(grossSatangFor(WageType.DAILY, 45_000, 26)).toBe(1_170_000);
  });

  it('pays a monthly wage flat, whatever the days say', () => {
    // The days are recorded on the slip because they are worth knowing, but
    // pro-rating a salary silently would be indistinguishable from a bug.
    // An absence comes off as a deduction, where it is visible and arguable.
    expect(grossSatangFor(WageType.MONTHLY, 2_000_000, 20)).toBe(2_000_000);
    expect(grossSatangFor(WageType.MONTHLY, 2_000_000, 31)).toBe(2_000_000);
  });

  it('pays a daily worker nothing for a month they did not work', () => {
    expect(grossSatangFor(WageType.DAILY, 45_000, 0)).toBe(0);
  });

  it('refuses a fractional or negative day count', () => {
    expect(() => grossSatangFor(WageType.DAILY, 45_000, 26.5)).toThrow(RangeError);
    expect(() => grossSatangFor(WageType.DAILY, 45_000, -1)).toThrow(RangeError);
  });

  it('refuses a wage rate that is not whole satang (rule #2)', () => {
    expect(() => grossSatangFor(WageType.DAILY, 450.5, 26)).toThrow(TypeError);
  });
});

describe('net pay', () => {
  it('adds the bonus and takes the deductions off', () => {
    expect(netSatangFor(1_170_000, 50_000, 20_000)).toBe(1_200_000);
  });

  it('reports a negative net rather than clamping it to zero', () => {
    // A slip reading 0.00 with no explanation is worse than one that shows the
    // shop is trying to take off more than the person earned.
    expect(netSatangFor(45_000, 0, 100_000)).toBe(-55_000);
    expect(deductionExceedsPay(45_000, 0, 100_000)).toBe(true);
  });

  it('does not call an exactly-zero net an overdraw', () => {
    expect(deductionExceedsPay(45_000, 0, 45_000)).toBe(false);
  });

  it('lets a bonus cover a deduction bigger than the wage', () => {
    expect(deductionExceedsPay(45_000, 60_000, 100_000)).toBe(false);
  });
});

describe('deduction types', () => {
  it('keeps every reason as a key with a Thai label beside it', () => {
    for (const info of DEDUCTION_TYPES) {
      expect(info.key).toMatch(/^[A-Z_]+$/);
      expect(info.label).not.toBe(info.key);
    }
  });

  it('renders an unknown stored value as itself instead of blank', () => {
    expect(deductionTypeLabel('มาสาย')).toBe('มาสาย');
    expect(deductionTypeLabel('LATE')).toBe('มาสาย');
  });
});

describe('document expiry', () => {
  it('counts whole days across a month boundary', () => {
    expect(daysBetween('2026-07-30', '2026-08-02')).toBe(3);
    expect(daysBetween('2026-08-02', '2026-07-30')).toBe(-3);
  });

  it('is unaffected by daylight saving in other zones', () => {
    // Both ends are parsed as UTC midnight, so a 23- or 25-hour local day
    // cannot turn 90 days into 89.96 and round the wrong way.
    expect(daysBetween('2026-03-01', '2026-11-01')).toBe(245);
  });

  it('treats the expiry day itself as expired', () => {
    // A permit valid "ถึง 15 มีนาคม" has the 15th as its last usable day, and
    // one day early costs nothing while one day late is the entire risk.
    expect(documentExpiryState('2026-07-30', '2026-07-30')).toBe('EXPIRED');
    expect(documentExpiryState('2026-07-29', '2026-07-30')).toBe('EXPIRED');
  });

  it('warns from exactly 90 days out', () => {
    expect(documentExpiryState('2026-10-28', '2026-07-30')).toBe('EXPIRING');
    expect(daysBetween('2026-07-30', '2026-10-28')).toBe(DOCUMENT_WARNING_DAYS);
    expect(documentExpiryState('2026-10-29', '2026-07-30')).toBe('OK');
  });

  it('says NONE for a Thai employee with no permit rather than warning forever', () => {
    expect(documentExpiryState(null, '2026-07-30')).toBe('NONE');
    expect(documentExpiryState(undefined, '2026-07-30')).toBe('NONE');
  });
});

describe('who is on a payroll run', () => {
  const hired = (over: Partial<Parameters<typeof isOnPayrollForMonth>[0]> = {}) => ({
    status: 'ACTIVE' as const,
    startDate: '2026-01-15',
    endDate: null,
    ...over,
  });

  it('includes everyone working through the month', () => {
    expect(isOnPayrollForMonth(hired(), '2026-08')).toBe(true);
    expect(isOnPayrollForMonth(hired({ status: 'PROBATION' }), '2026-08')).toBe(true);
    // On unpaid leave still has to appear: a run that silently drops someone is
    // a run whose total looks right and is short a person.
    expect(isOnPayrollForMonth(hired({ status: 'LEAVE' }), '2026-08')).toBe(true);
  });

  it('still pays somebody who left part-way through the month', () => {
    // The bug this exists to prevent: marking a cook as having left on the 20th
    // dropping them from the run along with the twenty days they worked.
    const leaver = hired({ status: 'LEFT', endDate: '2026-08-20' });
    expect(isOnPayrollForMonth(leaver, '2026-08')).toBe(true);
    expect(isOnPayrollForMonth(leaver, '2026-09')).toBe(false);
  });

  it('pays somebody who left on the very first day of the month', () => {
    expect(isOnPayrollForMonth(hired({ status: 'LEFT', endDate: '2026-08-01' }), '2026-08')).toBe(
      true,
    );
    expect(isOnPayrollForMonth(hired({ status: 'LEFT', endDate: '2026-07-31' }), '2026-08')).toBe(
      false,
    );
  });

  it('does not pay a new hire for the month before they arrived', () => {
    const newHire = hired({ startDate: '2026-09-01' });
    expect(isOnPayrollForMonth(newHire, '2026-08')).toBe(false);
    expect(isOnPayrollForMonth(newHire, '2026-09')).toBe(true);
  });

  it('includes someone hired on the last day of the month', () => {
    expect(isOnPayrollForMonth(hired({ startDate: '2026-08-31' }), '2026-08')).toBe(true);
  });

  it('falls back to the status when nobody recorded a leaving date', () => {
    expect(isOnPayrollForMonth(hired({ status: 'LEFT' }), '2026-08')).toBe(false);
  });
});

describe('staff schemas', () => {
  const base = {
    fullName: 'สมชาย ทดสอบ',
    nickname: null,
    position: 'กุ๊ก',
    role: 'STAFF' as const,
    phone: null,
    startDate: '2026-07-01',
    endDate: null,
    status: 'ACTIVE' as const,
    nationality: 'TH' as const,
    passportNo: null,
    passportExpiry: null,
    workPermitNo: null,
    workPermitExpiry: null,
    wageType: 'DAILY' as const,
    wageRateSatang: 45_000,
    note: null,
  };

  it('accepts a plain record', () => {
    expect(staffRequestSchema.parse(base).fullName).toBe('สมชาย ทดสอบ');
  });

  it('refuses someone who left before they started', () => {
    expect(() => staffRequestSchema.parse({ ...base, endDate: '2026-06-30' })).toThrow();
  });

  it('refuses a wage rate with satang fractions (rule #2)', () => {
    expect(() => staffRequestSchema.parse({ ...base, wageRateSatang: 450.75 })).toThrow();
    expect(() => staffRequestSchema.parse({ ...base, wageRateSatang: -1 })).toThrow();
  });

  it('will not take a PIN through the edit schema', () => {
    // The edit form is built for phone numbers and wage rates. A PIN riding
    // along in that payload would be a password change nobody asked for.
    const parsed = staffRequestSchema.parse({ ...base, pin: '9999' }) as Record<string, unknown>;
    expect(parsed.pin).toBeUndefined();
  });

  it('requires a 4-digit PIN when creating someone', () => {
    expect(() => staffCreateRequestSchema.parse(base)).toThrow();
    expect(() => staffCreateRequestSchema.parse({ ...base, pin: '12345' })).toThrow();
    expect(staffCreateRequestSchema.parse({ ...base, pin: '0421' }).pin).toBe('0421');
  });

  it('has no field anywhere in the staff DTO that could carry the PIN hash', () => {
    // The one field worth stealing. A screen that never receives it cannot
    // leak it through a screenshot, a log line or a service worker cache.
    const keys = Object.keys(staffDtoSchema.shape);
    expect(keys).not.toContain('pinHash');
    expect(keys.some((key) => key.toLowerCase().includes('pin') && key !== 'isPinLocked')).toBe(
      false,
    );
  });
});

describe('deduction and payroll line schemas', () => {
  const deduction = {
    staffId: '11111111-1111-4111-8111-111111111111',
    date: '2026-07-15',
    type: 'LATE' as const,
    amountSatang: 10_000,
    note: null,
  };

  it('refuses a zero or negative deduction', () => {
    expect(() => deductionRequestSchema.parse({ ...deduction, amountSatang: 0 })).toThrow();
    expect(() => deductionRequestSchema.parse({ ...deduction, amountSatang: -100 })).toThrow();
  });

  it('refuses a free-text reason', () => {
    expect(() => deductionRequestSchema.parse({ ...deduction, type: 'มาสาย' })).toThrow();
  });

  it('refuses more days than a month can hold', () => {
    expect(() => payrollLineUpdateSchema.parse({ daysWorked: 32, bonusSatang: 0 })).toThrow();
    expect(() => payrollLineUpdateSchema.parse({ daysWorked: -1, bonusSatang: 0 })).toThrow();
    expect(payrollLineUpdateSchema.parse({ daysWorked: 31, bonusSatang: 0 }).daysWorked).toBe(31);
  });
});
