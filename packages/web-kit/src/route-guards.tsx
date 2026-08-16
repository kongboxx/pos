/**
 * The two route guards.
 *
 * These are a COURTESY, not the boundary. They stop someone who types a URL
 * from landing on a screen they cannot use; the boundary is the permission
 * check on every endpoint behind it, which runs whatever the browser believes.
 *
 * `fallback` is a prop rather than a constant because the two apps are now
 * different sites: sending an office visitor to the till's floor plan would be
 * a redirect to another origin.
 */

import { Navigate, Outlet } from 'react-router-dom';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Permission } from '@pos/shared';
import type { SessionState } from './session-store.js';

type SessionHook = UseBoundStore<StoreApi<SessionState>>;

export function RequireAuth({
  useSession,
  loginPath,
}: {
  useSession: SessionHook;
  loginPath: string;
}): React.ReactElement {
  const status = useSession((state) => state.status);
  return status === 'authenticated' ? <Outlet /> : <Navigate to={loginPath} replace />;
}

export function RequirePermission({
  useSession,
  permission,
  fallback,
}: {
  useSession: SessionHook;
  permission: Permission;
  fallback: string;
}): React.ReactElement {
  const allowed = useSession((state) => state.can(permission));
  return allowed ? <Outlet /> : <Navigate to={fallback} replace />;
}
