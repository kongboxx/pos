/**
 * Role capabilities.
 *
 * PROJECT RULE: a STAFF user must never see cost, profit, payroll or reports,
 * and must never void a line on their own. Voiding always needs a MANAGER or
 * OWNER PIN as approver.
 *
 * The matrix lives here (shared) so the PWA hides the button and the API
 * rejects the request using the exact same table — the UI is a convenience,
 * the server check is the real gate.
 */

import { Role } from './enums.js';

export const Permission = {
  VIEW_COST: 'VIEW_COST',
  VIEW_PROFIT: 'VIEW_PROFIT',
  VIEW_REPORTS: 'VIEW_REPORTS',
  VIEW_PAYROLL: 'VIEW_PAYROLL',
  MANAGE_STAFF: 'MANAGE_STAFF',
  MANAGE_MENU: 'MANAGE_MENU',
  MANAGE_TABLES: 'MANAGE_TABLES',
  MANAGE_BRANCH: 'MANAGE_BRANCH',
  MANAGE_EXPENSE: 'MANAGE_EXPENSE',
  TAKE_ORDER: 'TAKE_ORDER',
  TAKE_PAYMENT: 'TAKE_PAYMENT',
  /** Ask for a void. Staff may request; approval is a separate permission. */
  REQUEST_VOID: 'REQUEST_VOID',
  /** Approve a void / discount. Requires a supervisor PIN at the terminal. */
  APPROVE_VOID: 'APPROVE_VOID',
  /**
   * Let a customer's QR order through to the kitchen (Step 7).
   *
   * STAFF, deliberately, and NOT a supervisor permission: the person who can
   * see the table is the person who knows whether anyone is sitting at it. Ask
   * for a manager here and every approval waits for someone to walk over, which
   * is precisely the walk the QR code was supposed to save.
   */
  APPROVE_QR_ORDER: 'APPROVE_QR_ORDER',
  APPROVE_DISCOUNT: 'APPROVE_DISCOUNT',
  ISSUE_TAX_INVOICE: 'ISSUE_TAX_INVOICE',
  /**
   * Read another branch's takings (Step 10).
   *
   * OWNER only, and separate from VIEW_REPORTS on purpose. A branch manager
   * runs their own shop and is measured on it; handing them every other
   * branch's daily total turns one number into gossip and, when a manager
   * leaves for a competitor, into something worse. The owner is the only
   * person whose job actually spans the branches.
   */
  VIEW_ALL_BRANCHES: 'VIEW_ALL_BRANCHES',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const STAFF_PERMISSIONS: readonly Permission[] = [
  Permission.TAKE_ORDER,
  Permission.TAKE_PAYMENT,
  Permission.REQUEST_VOID,
  Permission.APPROVE_QR_ORDER,
];

const MANAGER_PERMISSIONS: readonly Permission[] = [
  ...STAFF_PERMISSIONS,
  Permission.VIEW_COST,
  Permission.VIEW_PROFIT,
  Permission.VIEW_REPORTS,
  Permission.MANAGE_MENU,
  Permission.MANAGE_TABLES,
  Permission.MANAGE_EXPENSE,
  Permission.APPROVE_VOID,
  Permission.APPROVE_DISCOUNT,
  Permission.ISSUE_TAX_INVOICE,
];

const OWNER_PERMISSIONS: readonly Permission[] = [
  ...MANAGER_PERMISSIONS,
  Permission.VIEW_PAYROLL,
  Permission.MANAGE_STAFF,
  Permission.MANAGE_BRANCH,
  Permission.VIEW_ALL_BRANCHES,
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [Role.OWNER]: OWNER_PERMISSIONS,
  [Role.MANAGER]: MANAGER_PERMISSIONS,
  [Role.STAFF]: STAFF_PERMISSIONS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles allowed to type the approval PIN on a void/discount dialog. */
export function canApproveVoid(role: Role): boolean {
  return can(role, Permission.APPROVE_VOID);
}
