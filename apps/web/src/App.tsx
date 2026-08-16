/**
 * App shell and routing.
 *
 * THREE WORLDS IN ONE BUNDLE, and the splits in this file are the whole point.
 *
 * 1. `/t/:token` — the customer's phone (Step 7): no session, no sync loop, no
 *    live socket, no sync bar. Keeping the staff hooks inside StaffApp rather
 *    than up here is not tidiness. If they ran for the customer route, every
 *    phone that scanned a sticker would ask /auth/me, open a WebSocket it
 *    cannot authenticate, retry that socket every three seconds for as long as
 *    the page was open, and start the offline outbox — and the customer would
 *    wait for a session check that is only ever going to say no before seeing
 *    a menu.
 *
 * 2. `/pos/*` — the till. STATICALLY imported, every one of them. These are
 *    the screens that must open when the wifi is down, and a lazy chunk that
 *    is not in the precache cannot be fetched offline. Do not "optimise" these
 *    into `lazy()`: the bug that creates does not show up on a desk, it shows
 *    up at 12:30 when the bill will not open.
 *
 * 3. `/office/*` — the back office. Exactly the opposite: ONE `lazy()` chunk,
 *    excluded from the precache in vite.config.ts, because a tablet on the
 *    counter has no business carrying the payroll screen. If it cannot be
 *    fetched, OfficeGate says so in words instead of showing a white screen.
 *
 * The rule those two halves share: **lazy and precached are opposites.**
 * Precached means not lazy; lazy means not precached. Getting that pair the
 * wrong way round is the one mistake here that testing on a desk cannot catch,
 * which is why bundle-boundary.test.ts reads the built service worker.
 *
 * For the staff app the session is checked ONCE on boot by asking the server
 * (`/auth/me`). If that call cannot go out, the app falls back to the identity
 * cached on the device rather than showing a PIN screen nobody could get past
 * while offline — see session.ts, and the factory it wraps in @pos/web-kit,
 * for why that is not a weakening of the login.
 *
 * The sync loop is started above the routes, because it has to keep running
 * while the cashier moves between screens: a bill queued on the order page must
 * still be sent after they walk back to the floor plan.
 */

import { lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Permission } from '@pos/shared';
import { PrintTestPage } from './PrintTestPage.js';
import { StatusPage } from './StatusPage.js';
import { SyncBar } from './components/SyncBar.js';
import { useLive } from './live-store.js';
import { OfficeGate } from './office-gate.js';
import { useSync } from './offline/sync-store.js';
import { LoginPage } from './pages/LoginPage.js';
import { QrOrderPage } from './pages/QrOrderPage.js';
import { ApprovalsPage } from './pages/pos/ApprovalsPage.js';
import { FloorPlanPage } from './pages/pos/FloorPlanPage.js';
import { KitchenPage } from './pages/pos/KitchenPage.js';
import { OrderPage } from './pages/pos/OrderPage.js';
import { PaidBillsPage } from './pages/pos/PaidBillsPage.js';
import { ShiftPage } from './pages/pos/ShiftPage.js';
import { RequireAuth, RequirePermission } from './route-guards.js';
import { path } from '@pos/web-kit';
import { useSession } from './session.js';

/** The one door into the back office. See pages/office/routes.tsx. */
const OfficeRoutes = lazy(() =>
  import('./pages/office/routes.js').then((module) => ({ default: module.OfficeRoutes })),
);

export function App(): React.ReactElement {
  return (
    <Routes>
      {/* The customer's phone. Deliberately first and deliberately outside
          everything below it. */}
      <Route path="/t/:token" element={<QrOrderPage />} />
      <Route path="*" element={<StaffApp />} />
    </Routes>
  );
}

function StaffApp(): React.ReactElement {
  const status = useSession((state) => state.status);
  const refresh = useSession((state) => state.refresh);
  const startSync = useSync((state) => state.start);
  const startLive = useLive((state) => state.start);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => startSync(), [startSync]);

  // Only once there is a session: the socket is authenticated by the same
  // cookie as every other request, so dialling before login would just retry
  // a rejected upgrade every few seconds for as long as the app is open.
  useEffect(() => {
    if (status !== 'authenticated') return;
    return startLive();
  }, [status, startLive]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-slate-400">กำลังตรวจสอบสิทธิ์…</p>
      </div>
    );
  }

  return (
    // The bar takes its own row instead of floating over the screen: a fixed
    // overlay would sit on top of "รับเงิน" on a landscape tablet, and the one
    // control nobody may lose is the one that takes money.
    <div className="flex h-screen flex-col">
      <SyncBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Routes>
          <Route
            path={path.login}
            element={
              status === 'authenticated' ? <Navigate to={path.tables} replace /> : <LoginPage />
            }
          />

          <Route element={<RequireAuth />}>
            {/* --- the till: static imports, precached ---------------- */}
            <Route path="/pos/tables" element={<FloorPlanPage />} />
            <Route path="/pos/order/:orderId" element={<OrderPage />} />
            <Route path="/pos/kitchen" element={<KitchenPage />} />

            {/* Answering the customers' QR orders (Step 7). STAFF, on purpose:
                the person who can see the table is the person who knows whether
                anyone is sitting at it. */}
            <Route element={<RequirePermission permission={Permission.APPROVE_QR_ORDER} />}>
              <Route path="/pos/approvals" element={<ApprovalsPage />} />
            </Route>

            {/* TAKE_PAYMENT, which STAFF has. The paid-bill list sits on the
                till rather than in the back office because a customer walks
                back to the counter and asks for a tax invoice while the shop
                is open; and the cashier who works the drawer is the one who
                counts it. Issuing a tax document needs ISSUE_TAX_INVOICE on
                top, and the HISTORY inside the shift page is gated separately
                on VIEW_REPORTS. */}
            <Route element={<RequirePermission permission={Permission.TAKE_PAYMENT} />}>
              <Route path="/pos/bills" element={<PaidBillsPage />} />
              <Route path="/pos/shift" element={<ShiftPage />} />
            </Route>

            {/* --- the back office: one lazy chunk, not precached ----- */}
            <Route
              path="/office/*"
              element={
                <OfficeGate>
                  <OfficeRoutes />
                </OfficeGate>
              }
            />

            {/* Kept from Steps 0-1: hardware and connectivity diagnostics.
                Neither till nor office — they are for whoever is holding a
                screwdriver, and they have to work when nothing else does. */}
            <Route path="/dev/print" element={<PrintTestPage />} />
            <Route path="/dev/status" element={<StatusPage />} />
          </Route>

          {/* --- where the old URLs went ---------------------------------
              Not decoration. A tablet reloads onto whatever it was last
              showing, and right after this deploy that is an address from
              before the split — most often /order/<uuid>, the screen the
              cashier was on. Falling through to the catch-all would throw the
              bill id away and land them on the floor plan mid-order. */}
          <Route path="/tables" element={<Navigate to={path.tables} replace />} />
          <Route path="/kitchen" element={<Navigate to={path.kitchen} replace />} />
          <Route path="/approvals" element={<Navigate to={path.approvals} replace />} />
          <Route path="/bills" element={<Navigate to={path.bills} replace />} />
          <Route path="/shift" element={<Navigate to={path.shift} replace />} />
          <Route path="/order/*" element={<Moved to="/pos/order" />} />
          <Route path="/manage/*" element={<Moved to="/office" />} />
          <Route path="/reports/*" element={<Moved to="/office/reports" />} />
          <Route path="/staff/*" element={<Moved to="/office/staff" />} />
          <Route path="/settings/*" element={<Moved to="/office/settings" />} />

          <Route path="*" element={<Navigate to={path.tables} replace />} />
        </Routes>
      </div>
    </div>
  );
}

/** Re-hangs whatever followed an old prefix under the new one. */
function Moved({ to }: { to: string }): React.ReactElement {
  const rest = useParams()['*'];
  return <Navigate to={rest ? `${to}/${rest}` : to} replace />;
}
