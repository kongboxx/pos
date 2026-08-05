import { describe, expect, it } from 'vitest';
import { Role } from './enums.js';
import { can, canApproveVoid, Permission, ROLE_PERMISSIONS } from './permissions.js';

describe('STAFF is walled off from money the owner does not want them to see', () => {
  const hidden = [
    Permission.VIEW_COST,
    Permission.VIEW_PROFIT,
    Permission.VIEW_REPORTS,
    Permission.VIEW_PAYROLL,
    Permission.MANAGE_STAFF,
    Permission.MANAGE_BRANCH,
  ];

  it.each(hidden)('denies %s to STAFF', (permission) => {
    expect(can(Role.STAFF, permission)).toBe(false);
  });

  it('lets STAFF do the job: take orders and take payment', () => {
    expect(can(Role.STAFF, Permission.TAKE_ORDER)).toBe(true);
    expect(can(Role.STAFF, Permission.TAKE_PAYMENT)).toBe(true);
  });
});

describe('voiding always needs a supervisor', () => {
  it('lets STAFF request a void but not approve it', () => {
    expect(can(Role.STAFF, Permission.REQUEST_VOID)).toBe(true);
    expect(can(Role.STAFF, Permission.APPROVE_VOID)).toBe(false);
    expect(canApproveVoid(Role.STAFF)).toBe(false);
  });

  it('lets MANAGER and OWNER approve', () => {
    expect(canApproveVoid(Role.MANAGER)).toBe(true);
    expect(canApproveVoid(Role.OWNER)).toBe(true);
  });

  it('applies the same rule to discounts', () => {
    expect(can(Role.STAFF, Permission.APPROVE_DISCOUNT)).toBe(false);
    expect(can(Role.MANAGER, Permission.APPROVE_DISCOUNT)).toBe(true);
  });
});

describe('payroll is owner-only', () => {
  it('hides payroll from MANAGER as well as STAFF', () => {
    expect(can(Role.MANAGER, Permission.VIEW_PAYROLL)).toBe(false);
    expect(can(Role.OWNER, Permission.VIEW_PAYROLL)).toBe(true);
  });
});

describe('role hierarchy', () => {
  it('gives MANAGER everything STAFF has', () => {
    for (const permission of ROLE_PERMISSIONS[Role.STAFF]) {
      expect(can(Role.MANAGER, permission)).toBe(true);
    }
  });

  it('gives OWNER everything MANAGER has', () => {
    for (const permission of ROLE_PERMISSIONS[Role.MANAGER]) {
      expect(can(Role.OWNER, permission)).toBe(true);
    }
  });
});
