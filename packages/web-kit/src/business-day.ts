/**
 * "วันนี้คือวันไหน" in the shop's terms.
 *
 * NOT the browser's calendar day. At 00:30 the shop is still trading yesterday
 * (rule #4), so the answer comes from the branch's timezone and cutoff hour
 * cached in the session. Getting this wrong opens the daily report on an empty
 * tomorrow every night after midnight, and files a late bill under the wrong
 * day's takings.
 *
 * A factory, because each app owns its own session store now.
 */

import type { StoreApi, UseBoundStore } from 'zustand';
import { toBusinessDate } from '@pos/shared';
import type { SessionState } from './session-store.js';

export function createUseBusinessToday(
  useSession: UseBoundStore<StoreApi<SessionState>>,
): () => string {
  return function useBusinessToday(): string {
    const branch = useSession((state) => state.branch);
    return toBusinessDate(new Date(), {
      timezone: branch?.timezone ?? 'Asia/Bangkok',
      dayCutoffHour: branch?.dayCutoffHour ?? 4,
    });
  };
}
