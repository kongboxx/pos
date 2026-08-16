/**
 * The till's route guards — the shared ones bound to this app's session store
 * and this app's destinations.
 *
 * Kept as named wrappers rather than used directly at the call sites so the
 * fallback stays decided in ONE place. Both destinations are till URLs; the
 * office picks its own, because after the split a redirect from one app to the
 * other crosses an origin.
 */

import {
  RequireAuth as SharedRequireAuth,
  RequirePermission as SharedRequirePermission,
  path,
} from '@pos/web-kit';
import type { Permission } from '@pos/shared';
import { useSession } from './session.js';

export function RequireAuth(): React.ReactElement {
  return <SharedRequireAuth useSession={useSession} loginPath={path.login} />;
}

export function RequirePermission({ permission }: { permission: Permission }): React.ReactElement {
  return (
    <SharedRequirePermission
      useSession={useSession}
      permission={permission}
      fallback={path.tables}
    />
  );
}
