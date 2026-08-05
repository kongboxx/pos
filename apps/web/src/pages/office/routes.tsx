/**
 * The whole back office, in one lazy chunk.
 *
 * This file exists so there is exactly ONE dynamic import boundary for
 * everything behind /office. Thirteen separate `lazy()` calls would work too,
 * but then the precache exclusion in vite.config.ts would have to name
 * thirteen moving chunk names instead of one — and the day somebody adds a
 * fourteenth screen and forgets, a payroll page quietly lands back on the
 * till's disk. One door is one thing to keep shut.
 *
 * Every path here is relative: this subtree is mounted at "/office/*", so
 * "reports/daily" resolves to /office/reports/daily. The absolute forms live
 * in routes.ts and are what the rest of the app links to.
 *
 * The permissions are the same ones these screens have always had. They are
 * repeated per group rather than hoisted to the top of the file because they
 * are NOT the same permission — a manager who may price the menu may not read
 * a wage, and flattening them into one gate would be a real widening.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { Permission } from '@pos/shared';
import { RequirePermission } from '../../route-guards.js';
import { AllBranchesPage } from './AllBranchesPage.js';
import { BranchesPage } from './BranchesPage.js';
import { DailyReportPage } from './DailyReportPage.js';
import { DeductionsPage } from './DeductionsPage.js';
import { ExpensesPage } from './ExpensesPage.js';
import { ManageIngredientsPage } from './ManageIngredientsPage.js';
import { ManageMenuPage } from './ManageMenuPage.js';
import { ManageOptionsPage } from './ManageOptionsPage.js';
import { ManageTablesPage } from './ManageTablesPage.js';
import { PayrollPage } from './PayrollPage.js';
import { PnlPage } from './PnlPage.js';
import { StaffListPage } from './StaffListPage.js';
import { VoidReportPage } from './VoidReportPage.js';

export function OfficeRoutes(): React.ReactElement {
  return (
    <Routes>
      <Route index element={<Navigate to="menu" replace />} />

      {/* Pricing the menu (Step 6). */}
      <Route element={<RequirePermission permission={Permission.MANAGE_MENU} />}>
        <Route path="menu" element={<ManageMenuPage />} />
        <Route path="options" element={<ManageOptionsPage />} />
        <Route path="ingredients" element={<ManageIngredientsPage />} />
      </Route>

      {/* Its own permission, because printing the QR stickers and laying out
          the room is a different job from pricing a bowl. */}
      <Route element={<RequirePermission permission={Permission.MANAGE_TABLES} />}>
        <Route path="tables" element={<ManageTablesPage />} />
      </Route>

      {/* The money screens (Step 8). VIEW_REPORTS, which STAFF does not have —
          a cashier who can read the daily report knows the margin on every
          bowl, and that is the same boundary that keeps cost off the till. */}
      <Route element={<RequirePermission permission={Permission.VIEW_REPORTS} />}>
        <Route path="reports" element={<Navigate to="daily" replace />} />
        <Route path="reports/daily" element={<DailyReportPage />} />
        <Route path="reports/expenses" element={<ExpensesPage />} />
        <Route path="reports/pnl" element={<PnlPage />} />
        <Route path="reports/voids" element={<VoidReportPage />} />
      </Route>

      {/* People and wages (Step 9). VIEW_PAYROLL, which only OWNER has — not
          even a manager. A wage rate is the most sensitive number in a small
          shop, so unlike the reports there is no "may look but not touch". */}
      <Route element={<RequirePermission permission={Permission.VIEW_PAYROLL} />}>
        <Route path="staff" element={<Navigate to="people" replace />} />
        <Route path="staff/people" element={<StaffListPage />} />
        <Route path="staff/deductions" element={<DeductionsPage />} />
        <Route path="staff/payroll" element={<PayrollPage />} />
      </Route>

      {/* Branch settings and every branch's takings (Step 10). Two
          permissions, both owner-only: one of these screens can turn VAT on
          for a whole shop, the other is a list of what every shop took. */}
      <Route element={<RequirePermission permission={Permission.MANAGE_BRANCH} />}>
        <Route path="settings" element={<Navigate to="branches" replace />} />
        <Route path="settings/branches" element={<BranchesPage />} />
      </Route>
      <Route element={<RequirePermission permission={Permission.VIEW_ALL_BRANCHES} />}>
        <Route path="settings/all-branches" element={<AllBranchesPage />} />
      </Route>

      {/* A typo under /office goes to the menu, not to the floor plan: the
          person here came to do back-office work. */}
      <Route path="*" element={<Navigate to="menu" replace />} />
    </Routes>
  );
}
