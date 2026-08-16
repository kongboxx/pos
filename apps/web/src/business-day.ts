/**
 * "วันนี้คือวันไหน" in the shop's terms.
 *
 * NOT the browser's calendar day. At 00:30 the shop is still trading yesterday
 * (rule #4), so the answer comes from the branch's timezone and cutoff hour
 * cached in the session. Getting this wrong opens the daily report on an empty
 * tomorrow every night after midnight, and files a late bill under the wrong
 * day's takings.
 *
 * This lives at the top level rather than inside the report shell because the
 * paid-bills screen needs it too, and that screen belongs to the till: a
 * customer walks back and asks for a tax invoice while the shop is open. A
 * till screen must not have to import a back-office layout to learn what day
 * it is — that import is exactly the kind of thread that pulls the whole back
 * office onto the tablet.
 */

import { toBusinessDate } from '@pos/shared';
import { useSession } from './session.js';

/** Today in the branch's terms: its timezone, its cutoff hour. */
export function useBusinessToday(): string {
  const branch = useSession((state) => state.branch);
  return toBusinessDate(new Date(), {
    timezone: branch?.timezone ?? 'Asia/Bangkok',
    dayCutoffHour: branch?.dayCutoffHour ?? 4,
  });
}
