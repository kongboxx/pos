/**
 * ปิดวัน.
 *
 * The screen is read standing up with the drawer open, so the only things
 * worth a test are the ones that would make the figures disagree with the cash
 * in front of the person reading: bills still open, and the cash line standing
 * on its own rather than being inferred from the total.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DailyReportResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { DailyReportPage } from './DailyReportPage.js';

vi.mock('../../api-client.js', () => ({ api: { dailyReport: vi.fn() } }));

vi.mock('../../session-store.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({ branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 }, can: () => true }),
}));

function report(overrides: Partial<DailyReportResponse> = {}): DailyReportResponse {
  return {
    businessDate: '2026-07-30',
    paidOrderCount: 18,
    grossSalesSatang: 485_000,
    discountSatang: 0,
    vatSatang: 0,
    netSalesSatang: 485_000,
    averageBillSatang: 26_944,
    payments: [
      { method: 'CASH', count: 12, amountSatang: 310_000 },
      { method: 'PROMPTPAY', count: 6, amountSatang: 175_000 },
    ],
    recipeCostSatang: 142_000,
    recipeCostPercentBp: 2928,
    grossProfitSatang: 343_000,
    coverage: { soldLineCount: 40, linesWithoutRecipeCount: 0 },
    expenseTotalSatang: 95_000,
    byCategory: [{ category: 'INGREDIENT', amountSatang: 95_000 }],
    openOrderCount: 0,
    openOrderTotalSatang: 0,
    cancelledOrderCount: 0,
    creditNoteCount: 0,
    creditNoteSatang: 0,
    voidCount: 0,
    voidFiredCount: 0,
    voidSalesValueSatang: 0,
    voidCostSatang: 0,
    ...overrides,
  };
}

async function show(data: DailyReportResponse = report()): Promise<void> {
  vi.mocked(api.dailyReport).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <DailyReportPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('ขายได้')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bills still open', () => {
  it('says so above the totals and states they are not counted', async () => {
    // Read at 18:00 with four tables eating, "ขายได้ 4,850" is true and
    // useless. The warning is what stops it being quoted as the day's take.
    await show(report({ openOrderCount: 3, openOrderTotalSatang: 72_000 }));

    expect(screen.getByRole('status')).toHaveTextContent('ยังมีบิลเปิดค้างอยู่ 3 โต๊ะ');
    expect(screen.getByRole('status')).toHaveTextContent('ยังไม่นับเป็นยอดขาย');
  });

  it('stays silent when every table is settled', async () => {
    await show();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('the money', () => {
  it('gives cash its own line, because that is what the drawer is counted against', async () => {
    await show();
    expect(screen.getByText('เงินสด')).toBeInTheDocument();
    expect(screen.getByText('3,100.00')).toBeInTheDocument();
    expect(screen.getByText('พร้อมเพย์')).toBeInTheDocument();
    expect(screen.getByText('1,750.00')).toBeInTheDocument();
  });

  it('keeps the food thrown away apart from the sales that did not happen', async () => {
    await show(
      report({
        voidCount: 2,
        voidFiredCount: 1,
        voidSalesValueSatang: 11_000,
        voidCostSatang: 3_200,
      }),
    );
    expect(screen.getByText('ยอดขายที่หายไป')).toBeInTheDocument();
    expect(screen.getByText('ทำแล้วต้องทิ้งจริง')).toBeInTheDocument();
  });
});

describe('dishes with no recipe', () => {
  it('warns that the food cost above is lower than the truth', async () => {
    await show(report({ coverage: { soldLineCount: 40, linesWithoutRecipeCount: 7 } }));
    expect(screen.getByText(/7 รายการที่ยังไม่ได้ใส่สูตร/)).toBeInTheDocument();
  });
});

describe('when the server cannot be reached', () => {
  it('says the report needs a connection rather than showing nothing', async () => {
    vi.mocked(api.dailyReport).mockResolvedValue({
      ok: false,
      error: 'fetch failed',
      offline: true,
    });
    render(
      <MemoryRouter>
        <DailyReportPage />
      </MemoryRouter>,
    );
    // A report read off a stale tablet is a wrong number presented as a right
    // one, and nothing on the screen would show it was old.
    expect(await screen.findByRole('alert')).toHaveTextContent('รายงานต้องออนไลน์');
  });
});
