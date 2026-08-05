/**
 * Turning a queued intent into an HTTP call, and the answer back into a verdict.
 *
 * The classification is the interesting part. Three different failures look
 * identical to a naive client and must not be treated the same way:
 *
 *  - fetch threw          → no connection. Stop; try the whole queue later.
 *  - the server answered 5xx → it is up but unhappy. Worth a few more goes.
 *  - the server answered 4xx → it understood and refused. Retrying forever
 *                              would hide a real problem from staff.
 *
 * And one deliberate lie: a DELETE for a line the server does not have comes
 * back 404, and we call that SUCCESS. The queue is describing a desired end
 * state — "this line should not exist" — and the end state is satisfied. The
 * alternative is a permanent rejection every time a line is added and removed
 * during the same outage, which is an ordinary thing to do.
 */

import type { OrderDto } from '@pos/shared';
import { api } from '../api-client.js';
import { toRequest, type Mutation } from './mutations.js';
import type { SendOutcome } from './outbox.js';

export async function sendMutation(mutation: Mutation): Promise<SendOutcome> {
  const { method, path, body } = toRequest(mutation);
  const result = await api.call<{ order: OrderDto }>(method, path, body);

  if (result.ok) return { kind: 'ok', order: result.data.order };
  if (result.offline) return { kind: 'offline' };

  const status = result.status ?? 0;

  if (status === 404 && (mutation.kind === 'removeLine' || mutation.kind === 'cancelOrder')) {
    return { kind: 'ok' };
  }
  if (status >= 500) return { kind: 'retry', message: result.error };

  return { kind: 'rejected', message: result.error };
}
