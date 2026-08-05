/**
 * The kitchen board.
 *
 * The screen this feeds hangs on a wall and is read from about 1.5 metres by
 * someone holding a ladle. That constraint drives every decision here:
 *
 *  - The board returns FEW rows. Only what is still being cooked, plus the last
 *    quarter hour of finished tickets so a mis-tap can be undone. A screen that
 *    scrolls is a screen where the oldest ticket is the one you cannot see.
 *  - Every field the screen needs is already on the ticket line. The names and
 *    options were denormalised at fire time, so re-reading the menu — or the
 *    bill — cannot change what a cook is looking at halfway through the bowl.
 *  - Nothing here computes money. The kitchen has no business knowing the
 *    price of anything, and the payload should not carry it past them.
 */

import type { Branch, Prisma, PrismaClient } from '@prisma/client';
import {
  CHANNEL_LABEL,
  DEFAULT_STATION,
  TicketStatus,
  type KitchenBoardResponse,
  type KitchenTicketDto,
} from '@pos/shared';
import { conflict, notFound } from '../../http-error.js';
import { settleTicketsForLines } from './ticket.settle.js';

/**
 * How long a finished ticket stays visible.
 *
 * Long enough to undo the tap that closed the wrong card, short enough that the
 * board is still only live work during a rush.
 */
export const RECENT_DONE_MINUTES = 15;

const TICKET_INCLUDE = {
  order: { select: { orderNo: true, channel: true } },
  lines: {
    // The bill line is joined for ONE field: whether it has been voided since
    // the ticket was fired. That is the difference between "cook this" and
    // "stop cooking this", and it lives on the bill, not on the ticket.
    include: { orderLine: { select: { voidedAt: true } } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.KitchenTicketInclude;

type TicketRow = Prisma.KitchenTicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

export class KitchenService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Everything the board shows, optionally narrowed to one station.
   *
   * The station list comes from the MENU rather than from today's tickets, so
   * the filter buttons are the same all day instead of appearing one by one as
   * the first order of each kind is fired.
   */
  async board(
    branch: Branch,
    station?: string,
    now: Date = new Date(),
  ): Promise<KitchenBoardResponse> {
    const doneSince = new Date(now.getTime() - RECENT_DONE_MINUTES * 60_000);

    const [tickets, menuStations] = await Promise.all([
      this.db.kitchenTicket.findMany({
        where: {
          branchId: branch.id,
          ...(station ? { station } : {}),
          OR: [
            { status: { in: [TicketStatus.PENDING, TicketStatus.IN_PROGRESS] } },
            { status: TicketStatus.DONE, doneAt: { gte: doneSince } },
          ],
        },
        include: TICKET_INCLUDE,
        // Oldest first: the ticket most at risk of being forgotten is the one
        // that must be nearest the cook's eye.
        orderBy: { firedAt: 'asc' },
      }),
      this.db.menuItem.findMany({
        where: { branchId: branch.id },
        select: { station: true },
        distinct: ['station'],
      }),
    ]);

    const stations = [...new Set(menuStations.map((item) => item.station ?? DEFAULT_STATION))].sort(
      (a, b) => a.localeCompare(b, 'th'),
    );

    return { stations, tickets: tickets.map(toKitchenTicketDto) };
  }

  /** "กำลังทำ" — someone has picked this ticket up. */
  async startTicket(branch: Branch, ticketId: string): Promise<KitchenTicketDto> {
    // Compare-and-swap on the status: two cooks tapping the same card at the
    // same moment must not both "start" it, and the loser must not be shown an
    // error for doing the obviously right thing.
    await this.db.kitchenTicket.updateMany({
      where: { id: ticketId, branchId: branch.id, status: TicketStatus.PENDING },
      data: { status: TicketStatus.IN_PROGRESS },
    });
    return this.load(branch, ticketId);
  }

  /** The whole ticket is served. */
  async completeTicket(branch: Branch, ticketId: string): Promise<KitchenTicketDto> {
    const ticket = await this.requireOpenTicket(branch, ticketId);
    const doneAt = new Date();

    await this.db.$transaction(async (tx) => {
      await tx.ticketLine.updateMany({
        where: { ticketId: ticket.id, doneAt: null },
        data: { doneAt },
      });
      await tx.kitchenTicket.updateMany({
        where: {
          id: ticket.id,
          status: { in: [TicketStatus.PENDING, TicketStatus.IN_PROGRESS] },
        },
        data: { status: TicketStatus.DONE, doneAt },
      });
    });

    return this.load(branch, ticketId);
  }

  /**
   * One bowl off a ticket, for the common case where the drink is ready long
   * before the noodles.
   */
  async completeLine(branch: Branch, ticketLineId: string): Promise<KitchenTicketDto> {
    const line = await this.db.ticketLine.findFirst({
      where: { id: ticketLineId, branchId: branch.id },
      select: { id: true, ticketId: true, orderLineId: true, doneAt: true },
    });
    if (!line) throw notFound('TICKET_LINE_NOT_FOUND', 'ไม่พบรายการนี้บนบัตรครัว');

    await this.db.$transaction(async (tx) => {
      if (line.doneAt === null) {
        await tx.ticketLine.updateMany({
          where: { id: line.id, doneAt: null },
          data: { doneAt: new Date() },
        });
      }
      // Finishing a line implicitly starts the ticket: nobody taps "เริ่มทำ"
      // and then a bowl in that order when the kitchen is busy.
      await tx.kitchenTicket.updateMany({
        where: { id: line.ticketId, status: TicketStatus.PENDING },
        data: { status: TicketStatus.IN_PROGRESS },
      });
      await settleTicketsForLines(tx, branch.id, [line.orderLineId]);
    });

    return this.load(branch, line.ticketId);
  }

  /**
   * Puts a finished ticket back on the board.
   *
   * A cook wiping a screen with a wet hand closes cards. Without an undo the
   * only recovery is asking the counter to read the bill back, in the middle of
   * service. Limited to the same window the board shows, because "undone" has
   * to mean the food is still in the kitchen.
   */
  async recallTicket(
    branch: Branch,
    ticketId: string,
    now: Date = new Date(),
  ): Promise<KitchenTicketDto> {
    const ticket = await this.load(branch, ticketId);
    if (ticket.status !== TicketStatus.DONE) {
      throw conflict('TICKET_NOT_DONE', 'บัตรนี้ยังไม่ได้ปิด');
    }
    const doneAt = ticket.doneAt ? new Date(ticket.doneAt) : null;
    if (!doneAt || now.getTime() - doneAt.getTime() > RECENT_DONE_MINUTES * 60_000) {
      throw conflict('TICKET_TOO_OLD', `เรียกคืนได้ภายใน ${RECENT_DONE_MINUTES} นาทีเท่านั้น`);
    }

    await this.db.$transaction(async (tx) => {
      await tx.ticketLine.updateMany({ where: { ticketId }, data: { doneAt: null } });
      await tx.kitchenTicket.updateMany({
        where: { id: ticketId, status: TicketStatus.DONE },
        data: { status: TicketStatus.IN_PROGRESS, doneAt: null },
      });
    });

    return this.load(branch, ticketId);
  }

  /* ------------------------------------------------------------------ */

  private async load(branch: Branch, ticketId: string): Promise<KitchenTicketDto> {
    const ticket = await this.db.kitchenTicket.findFirst({
      where: { id: ticketId, branchId: branch.id },
      include: TICKET_INCLUDE,
    });
    if (!ticket) throw notFound('TICKET_NOT_FOUND', 'ไม่พบบัตรครัวนี้');
    return toKitchenTicketDto(ticket);
  }

  private async requireOpenTicket(branch: Branch, ticketId: string): Promise<KitchenTicketDto> {
    const ticket = await this.load(branch, ticketId);
    if (ticket.status === TicketStatus.CANCELLED) {
      throw conflict('TICKET_CANCELLED', 'บัตรนี้ถูกยกเลิกไปแล้ว');
    }
    return ticket;
  }
}

export function toKitchenTicketDto(ticket: TicketRow): KitchenTicketDto {
  return {
    id: ticket.id,
    orderId: ticket.orderId,
    orderNo: ticket.order.orderNo,
    tableName: ticket.tableName,
    channelLabel: CHANNEL_LABEL[ticket.order.channel],
    station: ticket.station,
    status: ticket.status,
    firedAt: ticket.firedAt.toISOString(),
    doneAt: ticket.doneAt?.toISOString() ?? null,
    lines: ticket.lines.map((line) => ({
      id: line.id,
      orderLineId: line.orderLineId,
      nameSnapshot: line.nameSnapshot,
      qty: line.qty,
      modifiersSummary: line.modifiersSnapshot,
      note: line.note,
      doneAt: line.doneAt?.toISOString() ?? null,
      voidedAt: line.orderLine.voidedAt?.toISOString() ?? null,
    })),
  };
}
