/**
 * Kitchen display and voiding (Step 5).
 *
 * Two things join up here, and they join up because of one fact: FIRING IS THE
 * POINT OF NO RETURN. Before a line is fired it is a note on a tablet and can
 * be edited or deleted freely. The moment it reaches the kitchen someone starts
 * cooking, so taking it off the bill is no longer an edit — it is a loss that
 * has to be recorded, with a reason and a supervisor's PIN (rule #8).
 *
 * `firedAt` on the order line is what separates the two worlds, and it already
 * existed from Step 2. This file is the contract for crossing that line and for
 * what the kitchen screen shows once it has been crossed.
 */

import { z } from 'zod';
import { TicketStatus } from './enums.js';
import { pinSchema, ticketStatusSchema, uuidSchema } from './schemas.js';

/** Where a line goes when no menu item says otherwise. */
export const DEFAULT_STATION = 'ครัว';

/* ------------------------------------------------------------------ */
/* How long has this been waiting                                      */
/* ------------------------------------------------------------------ */

/**
 * The thresholds the kitchen screen colours by.
 *
 * A bowl of noodles is a two-to-three minute job, so six minutes on the board
 * means something is stuck and twelve means it was forgotten. These are not
 * decoration: the whole reason for a screen over a spike of paper slips is that
 * a spike cannot tell you which ticket is drowning.
 */
export const TICKET_WARN_MINUTES = 6;
export const TICKET_LATE_MINUTES = 12;

export type TicketUrgency = 'fresh' | 'warn' | 'late';

export function minutesWaiting(firedAt: Date | string, now: Date = new Date()): number {
  const fired = firedAt instanceof Date ? firedAt : new Date(firedAt);
  return Math.max(0, Math.floor((now.getTime() - fired.getTime()) / 60_000));
}

export function ticketUrgency(firedAt: Date | string, now: Date = new Date()): TicketUrgency {
  const minutes = minutesWaiting(firedAt, now);
  if (minutes >= TICKET_LATE_MINUTES) return 'late';
  if (minutes >= TICKET_WARN_MINUTES) return 'warn';
  return 'fresh';
}

/* ------------------------------------------------------------------ */
/* Firing                                                              */
/* ------------------------------------------------------------------ */

export const fireOrderRequestSchema = z.object({
  /**
   * Which lines to send. OMITTED means "everything not yet fired", which is
   * what the button does. The explicit list exists so a half-order can be sent
   * ("ส่งน้ำก่อน") without inventing a second endpoint.
   */
  lineIds: z.array(uuidSchema).max(200).optional(),
});
export type FireOrderRequest = z.infer<typeof fireOrderRequestSchema>;

/* ------------------------------------------------------------------ */
/* Voiding                                                             */
/* ------------------------------------------------------------------ */

/**
 * A fixed list, not free text.
 *
 * The owner's question at the end of the month is "how much did we throw away
 * and why", and that question cannot be answered by grouping typed sentences.
 * "อื่นๆ" is the escape hatch and it forces a note.
 */
export const VOID_REASONS = [
  'ลูกค้าเปลี่ยนใจ',
  'ทำผิดเมนู',
  'ของหมด',
  'ทำหล่น/เสียหาย',
  'อื่นๆ',
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export const voidReasonSchema = z.enum(VOID_REASONS);

export const voidLineRequestSchema = z
  .object({
    reason: voidReasonSchema,
    note: z.string().max(200).nullish(),
    /**
     * The supervisor standing at the terminal, and their PIN.
     *
     * Sent per void rather than held as a second session: an approval is a
     * signature on ONE event, and a manager who walks away must not leave an
     * "approved" state behind them on the tablet.
     */
    approverStaffId: uuidSchema,
    approverPin: pinSchema,
  })
  .refine((value) => value.reason !== 'อื่นๆ' || (value.note?.trim().length ?? 0) > 0, {
    message: 'เลือก "อื่นๆ" ต้องเขียนเหตุผลด้วย',
    path: ['note'],
  });
export type VoidLineRequest = z.infer<typeof voidLineRequestSchema>;

/* ------------------------------------------------------------------ */
/* What the kitchen screen reads                                       */
/* ------------------------------------------------------------------ */

export const kitchenTicketLineDtoSchema = z.object({
  id: uuidSchema,
  orderLineId: uuidSchema,
  nameSnapshot: z.string(),
  qty: z.number().int(),
  /** Already joined into "เส้นเล็ก · น้ำใส · พิเศษ" — the screen does no work. */
  modifiersSummary: z.string().nullable(),
  note: z.string().nullable(),
  doneAt: z.string().nullable(),
  /**
   * Set when the bill line was voided AFTER the ticket was printed to the
   * screen. The row stays visible and crossed out rather than vanishing: a cook
   * halfway through the bowl needs to be told to stop, and a row that silently
   * disappears is a row nobody noticed.
   */
  voidedAt: z.string().nullable(),
});
export type KitchenTicketLineDto = z.infer<typeof kitchenTicketLineDtoSchema>;

export const kitchenTicketDtoSchema = z.object({
  id: uuidSchema,
  orderId: uuidSchema,
  orderNo: z.string().nullable(),
  /** Snapshot: the ticket still reads "A1" after the bill moves table. */
  tableName: z.string().nullable(),
  channelLabel: z.string(),
  station: z.string(),
  status: ticketStatusSchema,
  firedAt: z.string(),
  doneAt: z.string().nullable(),
  lines: z.array(kitchenTicketLineDtoSchema),
});
export type KitchenTicketDto = z.infer<typeof kitchenTicketDtoSchema>;

export const kitchenBoardResponseSchema = z.object({
  /** Every station this branch actually fires to, for the filter buttons. */
  stations: z.array(z.string()),
  tickets: z.array(kitchenTicketDtoSchema),
});
export type KitchenBoardResponse = z.infer<typeof kitchenBoardResponseSchema>;

/** A ticket is gone from the board once every line is done or voided. */
export function isTicketSettled(ticket: KitchenTicketDto): boolean {
  return (
    ticket.status === TicketStatus.DONE ||
    ticket.status === TicketStatus.CANCELLED ||
    ticket.lines.every((line) => line.doneAt !== null || line.voidedAt !== null)
  );
}

/* ------------------------------------------------------------------ */
/* Live updates                                                        */
/* ------------------------------------------------------------------ */

/**
 * What comes down the WebSocket.
 *
 * The events are SIGNALS, not data: "the kitchen board changed", not "here is
 * the new board". The client then refetches.
 *
 * That looks wasteful and is deliberate. A payload-carrying stream has to be
 * applied in order and cannot tolerate a dropped message, so every reconnect
 * needs a resync path anyway — and shop wifi drops messages. Refetching means
 * one code path for "we just connected", "we missed something" and "something
 * changed", and the cost on a LAN is a few milliseconds against a query that
 * returns at most a screenful of tickets.
 *
 * There is no branchId in here on purpose: the socket is already scoped to the
 * session's branch by the server, so a branch in the payload would be either
 * redundant or a lie worth trusting.
 */
export const liveEventSchema = z.discriminatedUnion('type', [
  /** Sent once on connect so the client knows the socket really works. */
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('kitchen') }),
  z.object({ type: z.literal('order'), orderId: uuidSchema }),
  /**
   * The menu changed (Step 6).
   *
   * Mostly this is "ลูกชิ้นทอดหมดแล้ว" pressed on the management screen in the
   * middle of service. Without it every till keeps offering the dish until
   * someone happens to navigate away and back, and the kitchen gets an order
   * for something the shop ran out of an hour ago.
   */
  z.object({ type: z.literal('menu') }),
  /**
   * A customer's phone put something on a bill and is waiting (Step 7).
   *
   * This one has to be a push rather than a poll. The customer is sitting there
   * watching their screen say "รอพนักงานยืนยัน", and the gap between them
   * pressing send and a member of staff seeing it is the whole quality of the
   * feature. A five-second poll would be five seconds of a person deciding the
   * QR code does not work and waving instead.
   */
  z.object({ type: z.literal('qr') }),
  /**
   * The floor plan changed underneath everyone (Step: ย้ายโต๊ะ / รวมบิล / แยกบิล).
   *
   * A bill moving between tables, two bills becoming one, or one becoming two
   * all rearrange which table is busy — and unlike a line being added, the
   * change lands on a table the tablet that made it may not even be looking at.
   * Without this the other tablets keep showing A1 as occupied until someone
   * navigates away and back, and the next customer is seated at a table the
   * screen says is taken.
   */
  z.object({ type: z.literal('tables') }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

/** Parses an incoming frame, returning null for anything unrecognised. */
export function parseLiveEvent(raw: string): LiveEvent | null {
  try {
    const parsed = liveEventSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
