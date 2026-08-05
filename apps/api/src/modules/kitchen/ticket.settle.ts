/**
 * Taking a ticket off the board.
 *
 * A ticket is finished when there is nothing left to cook on it — every line is
 * either served or voided. That state can be reached from two directions: the
 * kitchen taps the last bowl done, or the counter voids the last bowl that was
 * still outstanding. Both call this.
 *
 * Deriving the answer at read time instead would leave a ticket whose lines
 * were all voided sitting on the board going red for the rest of service, and
 * the ONE thing a kitchen screen must not do is show work that does not exist.
 */

import type { Prisma } from '@prisma/client';
import { TicketStatus } from '@pos/shared';

/**
 * Closes every ticket that these order lines belong to, if nothing is left.
 *
 * DONE when at least one line was actually cooked; CANCELLED when the whole
 * ticket was voided away. The distinction is what lets the owner separate "we
 * served it" from "we made it and threw it out" later.
 */
export async function settleTicketsForLines(
  tx: Prisma.TransactionClient,
  branchId: string,
  orderLineIds: readonly string[],
): Promise<void> {
  if (orderLineIds.length === 0) return;

  const affected = await tx.ticketLine.findMany({
    where: { branchId, orderLineId: { in: [...orderLineIds] } },
    select: { ticketId: true },
    distinct: ['ticketId'],
  });

  for (const { ticketId } of affected) {
    const lines = await tx.ticketLine.findMany({
      where: { ticketId },
      select: { doneAt: true, orderLine: { select: { voidedAt: true } } },
    });

    const outstanding = lines.filter(
      (line) => line.doneAt === null && line.orderLine.voidedAt === null,
    );
    if (outstanding.length > 0) continue;

    const anyCooked = lines.some((line) => line.doneAt !== null);

    await tx.kitchenTicket.updateMany({
      // Narrowed to a ticket that is still open, so re-running this cannot
      // resurrect a doneAt or overwrite a cancellation.
      where: {
        id: ticketId,
        status: { in: [TicketStatus.PENDING, TicketStatus.IN_PROGRESS] },
      },
      data: anyCooked
        ? { status: TicketStatus.DONE, doneAt: new Date() }
        : { status: TicketStatus.CANCELLED },
    });
  }
}
