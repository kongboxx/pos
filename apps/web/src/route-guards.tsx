/**
 * The two route guards, pulled out of App.tsx so the lazy office subtree can
 * use them without importing the app shell (which would drag the whole till
 * back into the office chunk and defeat the split).
 *
 * These are a COURTESY, not the boundary. They stop a cashier who types a URL
 * from landing on a payroll screen; the boundary is the permission check on
 * every endpoint behind it, which runs whatever the browser believes.
 */

import { Navigate, Outlet } from 'react-router-dom';
import type { Permission } from '@pos/shared';
import { path } from '@pos/web-kit';
import { useSession } from './session.js';

export function RequireAuth(): React.ReactElement {
  const status = useSession((state) => state.status);
  return status === 'authenticated' ? <Outlet /> : <Navigate to={path.login} replace />;
}

export function RequirePermission({ permission }: { permission: Permission }): React.ReactElement {
  const allowed = useSession((state) => state.can(permission));
  return allowed ? <Outlet /> : <Navigate to={path.tables} replace />;
}
