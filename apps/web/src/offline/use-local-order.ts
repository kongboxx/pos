/**
 * React's view of a bill that lives in IndexedDB.
 *
 * Two different refresh paths on purpose:
 *
 *  - `reload()` is the one that may talk to the server. It runs on mount and
 *    when the caller asks, and it is where the bill number and any changes made
 *    on another tablet arrive.
 *  - the change subscription never touches the network. It fires after every
 *    local write and after every background sync, and it must stay cheap —
 *    routing it through the server would turn one tap into one request while
 *    the outbox is already doing exactly that job.
 */

import { useCallback, useEffect, useState } from 'react';
import { getOrder, onOrdersChanged, type StoredOrder } from './db.js';
import { readOrder } from './repository.js';

export interface LocalOrderView {
  order: StoredOrder | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useLocalOrder(orderId: string): LocalOrderView {
  const [order, setOrder] = useState<StoredOrder | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const next = await readOrder(orderId);
    setOrder(next);
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const next = await readOrder(orderId);
      if (!cancelled) {
        setOrder(next);
        setLoading(false);
      }
    })();

    const unsubscribe = onOrdersChanged((change) => {
      if (cancelled) return;
      // A `put` already carries the new bill, so the screen updates in the same
      // turn as the tap that caused it. Anything else means "look again".
      if (change.kind === 'put') {
        if (change.order.id === orderId) setOrder(change.order);
        return;
      }
      void getOrder(orderId).then((next) => {
        if (!cancelled) setOrder(next ?? null);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [orderId]);

  return { order, loading, reload };
}
