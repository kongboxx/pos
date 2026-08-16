/**
 * Every URL in the app, in one place.
 *
 * TWO NAMESPACES, AND THE LINE BETWEEN THEM IS THE POINT:
 *
 *   /pos/*     the till. Screens that are open while customers are in the
 *              room. Statically imported and precached, so the tablet can
 *              still take an order when the wifi drops.
 *
 *   /office/*  the back office. Menu pricing, reports, wages, branch
 *              settings. Lazy-loaded in one chunk that is deliberately kept
 *              OUT of the service worker precache — see vite.config.ts.
 *
 * The rule for anything added later is one question: "when the wifi is down
 * and there is a queue, does the cashier need this screen?" Yes -> /pos.
 * No -> /office. It is a question about the shop, not about the code, so it
 * still has an answer when the feature is stock control or accounting.
 *
 * Note this is a split by SCREEN, not by person. Permissions still guard each
 * route and every endpoint behind it. In a shop this size one person wears
 * three hats — the owner IS the cashier at 12:30 — so a permission can never
 * be the boundary. Permission is the lock; this file is the map.
 *
 * Deliberately NOT split: /login and /t/:token. The customer's phone was
 * already its own world (see App.tsx) and the PIN screen belongs to neither.
 */

export const path = {
  login: '/login',
  /** The customer's phone. No session, no sync loop, no socket. */
  qrTable: (token: string) => `/t/${token}`,

  /* --- the till: works with the server unreachable ------------------ */
  tables: '/pos/tables',
  order: (orderId: string) => `/pos/order/${orderId}`,
  kitchen: '/pos/kitchen',
  approvals: '/pos/approvals',
  shift: '/pos/shift',
  bills: '/pos/bills',

  /* --- the back office: online only -------------------------------- */
  menu: '/office/menu',
  options: '/office/options',
  ingredients: '/office/ingredients',
  /** The floor-plan EDITOR, not the floor plan cashiers tap. */
  manageTables: '/office/tables',
  reportDaily: '/office/reports/daily',
  reportExpenses: '/office/reports/expenses',
  reportPnl: '/office/reports/pnl',
  reportVoids: '/office/reports/voids',
  staffPeople: '/office/staff/people',
  staffDeductions: '/office/staff/deductions',
  staffPayroll: '/office/staff/payroll',
  settingsBranches: '/office/settings/branches',
  settingsAllBranches: '/office/settings/all-branches',
} as const;

/**
 * Where the office subtree mounts. Kept next to the paths above because the
 * precache exclusion in vite.config.ts is written against the same word, and
 * the two drifting apart is how the payroll screen quietly ends up cached on
 * a till again.
 */
export const OFFICE_PREFIX = '/office';
