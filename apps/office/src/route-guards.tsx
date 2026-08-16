/**
 * The back office's route guards — the shared ones bound to this app's session
 * store and this app's destinations.
 *
 * Denied lands on the menu, not the till's floor plan: that is another site
 * now, and a redirect there would cross an origin.
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
    <SharedRequirePermission useSession={useSession} permission={permission} fallback={path.menu} />
  );
}
