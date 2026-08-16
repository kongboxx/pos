/**
 * The back office app shell.
 *
 * ONE WORLD, unlike the till's three: there is no customer route, no sync loop
 * and no live socket, because there is nothing on this device to sync and
 * nothing here changes second by second. A screen full of last month's numbers
 * does not need to be pushed.
 *
 * The session is checked once on boot and a failure means the login screen —
 * there is no cached identity to fall back to, on purpose. See session.ts.
 *
 * The route table below is lifted from what used to be pages/office/routes.tsx,
 * with two differences: the paths are absolute now (this app IS the office, so
 * there is no subtree to mount) and there is a login route, because the two
 * sites no longer share a cookie.
 *
 * The permissions are the ones these screens have always had. They are repeated
 * per group rather than hoisted because they are NOT the same permission — a
 * manager who may price the menu may not read a wage, and flattening them into
 * one gate would be a real widening.
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Permission } from '@pos/shared';
import { path } from '@pos/web-kit';
import { RequireAuth, RequirePermission } from './route-guards.js';
import { useSession } from './session.js';
import { LoginPage } from './pages/LoginPage.js';
import { AllBranchesPage } from './pages/AllBranchesPage.js';
import { BranchesPage } from './pages/BranchesPage.js';
import { DailyReportPage } from './pages/DailyReportPage.js';
import { DeductionsPage } from './pages/DeductionsPage.js';
import { ExpensesPage } from './pages/ExpensesPage.js';
import { ManageIngredientsPage } from './pages/ManageIngredientsPage.js';
import { ManageMenuPage } from './pages/ManageMenuPage.js';
import { ManageOptionsPage } from './pages/ManageOptionsPage.js';
import { ManageTablesPage } from './pages/ManageTablesPage.js';
import { PayrollPage } from './pages/PayrollPage.js';
import { PnlPage } from './pages/PnlPage.js';
import { StaffListPage } from './pages/StaffListPage.js';
import { VoidReportPage } from './pages/VoidReportPage.js';

export function App(): React.ReactElement {
  const status = useSession((state) => state.status);
  const refresh = useSession((state) => state.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-slate-400">กำลังตรวจสอบสิทธิ์…</p>
      </div>
    );
  }

  return (
    <Routes>
      {/* Outside the guard, or logging in would redirect to itself forever. */}
      <Route
        path={path.login}
        element={status === 'authenticated' ? <Navigate to={path.menu} replace /> : <LoginPage />}
      />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<Navigate to={path.menu} replace />} />

        {/* Pricing the menu (Step 6). */}
        <Route element={<RequirePermission permission={Permission.MANAGE_MENU} />}>
          <Route path={path.menu} element={<ManageMenuPage />} />
          <Route path={path.options} element={<ManageOptionsPage />} />
          <Route path={path.ingredients} element={<ManageIngredientsPage />} />
        </Route>

        {/* Its own permission, because printing the QR stickers and laying out
            the room is a different job from pricing a bowl. */}
        <Route element={<RequirePermission permission={Permission.MANAGE_TABLES} />}>
          <Route path={path.manageTables} element={<ManageTablesPage />} />
        </Route>

        {/* The money screens (Step 8). VIEW_REPORTS, which STAFF does not have —
            a cashier who can read the daily report knows the margin on every
            bowl, and that is the same boundary that keeps cost off the till. */}
        <Route element={<RequirePermission permission={Permission.VIEW_REPORTS} />}>
          <Route path="/office/reports" element={<Navigate to={path.reportDaily} replace />} />
          <Route path={path.reportDaily} element={<DailyReportPage />} />
          <Route path={path.reportExpenses} element={<ExpensesPage />} />
          <Route path={path.reportPnl} element={<PnlPage />} />
          <Route path={path.reportVoids} element={<VoidReportPage />} />
        </Route>

        {/* People and wages (Step 9). VIEW_PAYROLL, which only OWNER has — not
            even a manager. A wage rate is the most sensitive number in a small
            shop, so unlike the reports there is no "may look but not touch". */}
        <Route element={<RequirePermission permission={Permission.VIEW_PAYROLL} />}>
          <Route path="/office/staff" element={<Navigate to={path.staffPeople} replace />} />
          <Route path={path.staffPeople} element={<StaffListPage />} />
          <Route path={path.staffDeductions} element={<DeductionsPage />} />
          <Route path={path.staffPayroll} element={<PayrollPage />} />
        </Route>

        {/* Branch settings and every branch's takings (Step 10). Two
            permissions, both owner-only: one of these screens can turn VAT on
            for a whole shop, the other is a list of what every shop took. */}
        <Route element={<RequirePermission permission={Permission.MANAGE_BRANCH} />}>
          <Route
            path="/office/settings"
            element={<Navigate to={path.settingsBranches} replace />}
          />
          <Route path={path.settingsBranches} element={<BranchesPage />} />
        </Route>
        <Route element={<RequirePermission permission={Permission.VIEW_ALL_BRANCHES} />}>
          <Route path={path.settingsAllBranches} element={<AllBranchesPage />} />
        </Route>
      </Route>

      {/* A typo goes to the menu, not to the till's floor plan: the person here
          came to do back-office work, and the floor plan is another site. */}
      <Route path="*" element={<Navigate to={path.menu} replace />} />
    </Routes>
  );
}
