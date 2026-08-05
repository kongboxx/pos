/**
 * The kitchen contract.
 *
 * What is worth testing here is not the shape of the DTOs — TypeScript already
 * says that — but the two rules a person could talk their way past: a void must
 * carry a real reason, and a ticket that has been waiting too long must say so.
 */

import { describe, expect, it } from 'vitest';
import {
  isTicketSettled,
  minutesWaiting,
  parseLiveEvent,
  ticketUrgency,
  TICKET_LATE_MINUTES,
  TICKET_WARN_MINUTES,
  voidLineRequestSchema,
  type KitchenTicketDto,
} from './kitchen.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

describe('how long a ticket has been waiting', () => {
  it('counts whole minutes and never goes negative', () => {
    expect(minutesWaiting(minutesAgo(3), NOW)).toBe(3);
    // Clock skew between the tablet and the server is normal on shop wifi; a
    // ticket that reads "-2 นาที" would just look broken.
    expect(minutesWaiting(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
  });

  it('escalates at the thresholds, not before', () => {
    expect(ticketUrgency(minutesAgo(TICKET_WARN_MINUTES - 1), NOW)).toBe('fresh');
    expect(ticketUrgency(minutesAgo(TICKET_WARN_MINUTES), NOW)).toBe('warn');
    expect(ticketUrgency(minutesAgo(TICKET_LATE_MINUTES - 1), NOW)).toBe('warn');
    expect(ticketUrgency(minutesAgo(TICKET_LATE_MINUTES), NOW)).toBe('late');
  });

  it('accepts the ISO string the API actually sends', () => {
    expect(ticketUrgency(minutesAgo(20).toISOString(), NOW)).toBe('late');
  });
});

describe('asking to void a line', () => {
  const base = {
    reason: 'ทำผิดเมนู' as const,
    approverStaffId: '11111111-1111-4111-8111-111111111111',
    approverPin: '1234',
  };

  it('accepts a listed reason with an approver', () => {
    expect(voidLineRequestSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a reason that is not on the list', () => {
    // Free text here would make "how much did we throw away and why"
    // unanswerable at the end of the month.
    expect(voidLineRequestSchema.safeParse({ ...base, reason: 'เพราะอยากลบ' }).success).toBe(false);
  });

  it('makes "อื่นๆ" carry its own explanation', () => {
    expect(voidLineRequestSchema.safeParse({ ...base, reason: 'อื่นๆ' }).success).toBe(false);
    expect(voidLineRequestSchema.safeParse({ ...base, reason: 'อื่นๆ', note: '   ' }).success).toBe(
      false,
    );
    expect(
      voidLineRequestSchema.safeParse({ ...base, reason: 'อื่นๆ', note: 'ลูกค้าแพ้ถั่ว' }).success,
    ).toBe(true);
  });

  it('refuses an approver PIN that is not four digits', () => {
    expect(voidLineRequestSchema.safeParse({ ...base, approverPin: '12' }).success).toBe(false);
  });
});

describe('when a ticket leaves the board', () => {
  const ticket = (overrides: Partial<KitchenTicketDto> = {}): KitchenTicketDto => ({
    id: '22222222-2222-4222-8222-222222222222',
    orderId: '33333333-3333-4333-8333-333333333333',
    orderNo: '260730-004',
    tableName: 'A1',
    channelLabel: 'ทานที่ร้าน',
    station: 'ครัวเส้น',
    status: 'PENDING',
    firedAt: NOW.toISOString(),
    doneAt: null,
    lines: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        orderLineId: '55555555-5555-4555-8555-555555555555',
        nameSnapshot: 'ก๋วยเตี๋ยวหมู',
        qty: 1,
        modifiersSummary: 'เส้นเล็ก · น้ำใส',
        note: null,
        doneAt: null,
        voidedAt: null,
      },
    ],
    ...overrides,
  });

  it('stays while a line is still cooking', () => {
    expect(isTicketSettled(ticket())).toBe(false);
  });

  it('clears once every line is done', () => {
    const lines = ticket().lines.map((line) => ({ ...line, doneAt: NOW.toISOString() }));
    expect(isTicketSettled(ticket({ lines }))).toBe(true);
  });

  it('clears when the last remaining line was voided instead of cooked', () => {
    // The cook was told to stop. Nothing is coming, so the card must not sit
    // there going red for the rest of the service.
    const lines = ticket().lines.map((line) => ({ ...line, voidedAt: NOW.toISOString() }));
    expect(isTicketSettled(ticket({ lines }))).toBe(true);
  });
});

describe('live events', () => {
  it('reads the signals the server sends', () => {
    expect(parseLiveEvent('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseLiveEvent('{"type":"kitchen"}')).toEqual({ type: 'kitchen' });
  });

  it('returns null rather than throwing on junk', () => {
    // A socket is an open pipe to anything on the shop wifi. A malformed frame
    // must be ignored, not crash the kitchen screen mid-service.
    expect(parseLiveEvent('not json')).toBeNull();
    expect(parseLiveEvent('{"type":"drop-database"}')).toBeNull();
    expect(parseLiveEvent('{"type":"order"}')).toBeNull();
  });
});
