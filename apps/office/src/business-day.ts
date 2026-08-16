/**
 * Today, as the shop counts it — bound to this app's session.
 *
 * Same rule as the till: the business date turns over at the branch's cutoff
 * hour, not at midnight, so a report opened at 01:00 still says yesterday.
 */

import { createUseBusinessToday } from '@pos/web-kit';
import { useSession } from './session.js';

export const useBusinessToday = createUseBusinessToday(useSession);
