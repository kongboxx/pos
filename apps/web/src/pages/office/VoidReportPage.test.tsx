/**
 * ของที่ยกเลิก.
 *
 * The one thing this screen must never do is let the two money columns be read
 * as the same kind of number. "ยอดขายที่หายไป" is revenue that never happened;
 * "ต้นทุนที่ทิ้ง" is food in the bin. A customer who changes their mind before
 * the cook starts costs nothing, and showing an ingredient cost against that
 * row would make the column impossible to add up by eye.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { VoidReportResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { VoidReportPage } from './VoidReportPage.js';

vi.mock('../../api-client.js', () => ({ api: { voidReport: vi.fn() } }));

vi.mock('../../session.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({ branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 }, can: () => true }),
}));

function row(overrides: Partial<VoidReportResponse['rows'][number]> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-07-30T10:00:00.000Z',
    businessDate: '2026-07-30',
    orderNo: '260730-009',
    nameSnapshot: 'ก๋วยเตี๋ยวหมู',
    qty: 1,
    salesValueSatang: 5_000,
    costSatang: 1_800,
    reason: 'ทำผิดเมนู',
    note: null,
    wasFired: true,
    requestedByName: 'อ่อง',
    approvedByName: 'พี่หญิง',
    ...overrides,
  };
}

function report(overrides: Partial<VoidReportResponse> = {}): VoidReportResponse {
  return {
    from: '2026-07-01',
    to: '2026-07-30',
    totalCount: 2,
    totalQty: 2,
    salesValueSatang: 10_000,
    costSatang: 3_600,
    firedCount: 1,
    firedCostSatang: 1_800,
    byReason: [
      {
        reason: 'ทำผิดเมนู',
        count: 1,
        qty: 1,
        salesValueSatang: 5_000,
        costSatang: 1_800,
        firedCount: 1,
      },
      {
        reason: 'ลูกค้าเปลี่ยนใจ',
        count: 1,
        qty: 1,
        salesValueSatang: 5_000,
        costSatang: 1_800,
        firedCount: 0,
      },
    ],
    rows: [
      row(),
      row({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        reason: 'ลูกค้าเปลี่ยนใจ',
        wasFired: false,
      }),
    ],
    ...overrides,
  };
}

async function show(data: VoidReportResponse = report()): Promise<void> {
  vi.mocked(api.voidReport).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <VoidReportPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('รวมทั้งช่วง')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the two money columns', () => {
  it('shows a cost only against lines the kitchen had already started', async () => {
    await show();

    const rows = screen.getAllByRole('row').slice(1); // drop the header
    const fired = rows.find((element) => within(element).queryByText('ทำผิดเมนู'));
    const changedMind = rows.find((element) => within(element).queryByText('ลูกค้าเปลี่ยนใจ'));

    expect(within(fired as HTMLElement).getByText('18.00')).toBeInTheDocument();
    // Nothing was cooked, so nothing was lost — and printing 18.00 here would
    // make the column add up to money the shop never spent.
    expect(within(changedMind as HTMLElement).queryByText('18.00')).not.toBeInTheDocument();
  });

  it('leads with the food actually thrown away, not with the lost revenue', async () => {
    await show();
    expect(screen.getByText('ทำแล้วต้องทิ้งจริง')).toBeInTheDocument();
    expect(screen.getByText(/ตัวที่เป็นเงินจริงคือบรรทัดล่าง/)).toBeInTheDocument();
  });

  it('records who asked and who signed it off', async () => {
    // The entire point of the approver PIN in Step 5.
    await show();
    expect(screen.getAllByText('อ่อง / พี่หญิง').length).toBeGreaterThan(0);
  });
});

describe('an empty range', () => {
  it('says nothing was thrown away rather than showing an empty table', async () => {
    await show(report({ totalCount: 0, totalQty: 0, byReason: [], rows: [], firedCount: 0 }));
    expect(screen.getByText('ไม่มีรายการที่ถูกยกเลิกในช่วงนี้')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('a range that runs backwards', () => {
  it('is refused on the screen without asking the server', async () => {
    await show();
    vi.mocked(api.voidReport).mockClear();

    const from = screen.getByLabelText('ตั้งแต่');
    // The input's own max would normally stop this; a typed date can still get
    // through, and the server refuses too.
    from.setAttribute('max', '2026-12-31');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(from, { target: { value: '2026-12-01' } });

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('วันเริ่มต้องไม่เกินวันสิ้นสุด');
    expect(api.voidReport).not.toHaveBeenCalled();
  });
});
