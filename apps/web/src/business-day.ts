/**
 * The till's "what day is it in shop terms" hook — the shared factory bound to
 * this app's session store. The rule it implements lives in @pos/web-kit.
 *
 * This lives at the top level rather than inside the report shell because the
 * paid-bills screen needs it too, and that screen belongs to the till: a
 * customer walks back and asks for a tax invoice while the shop is open. A
 * till screen must not have to import a back-office layout to learn what day
 * it is — that import is exactly the kind of thread that pulls the whole back
 * office onto the tablet.
 */

import { createUseBusinessToday } from '@pos/web-kit';
import { useSession } from './session.js';

/** Today in the branch's terms: its timezone, its cutoff hour. */
export const useBusinessToday = createUseBusinessToday(useSession);
