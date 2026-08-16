/**
 * The P&L screen.
 *
 * What is tested here is not layout — it is the three things that would make
 * somebody close a shop that is fine, or keep open one that is not:
 *
 *  1. The warning that ค่าวัตถุดิบ and ต้นทุนตามสูตร are the same money counted
 *     two ways must be on screen whenever both are. Without it the reader does
 *     the subtraction themselves.
 *  2. "ขายเท่าไหร่ก็ไม่คุ้ม" must be said in words when the margin is negative,
 *     not shown as a blank or a zero.
 *  3. A month with no expenses recorded must not present its sales as profit.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PnlResponse } from '@pos/shared';
import { officeApi } from '../api-office.js';
import { PnlPage } from './PnlPage.js';

vi.mock('../api-office.js', () => ({ officeApi: { pnl: vi.fn() } }));

vi.mock('../session.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({ branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 }, can: () => true }),
}));

function pnl(overrides: Partial<PnlResponse> = {}): PnlResponse {
  return {
    yearMonth: '2026-07',
    paidOrderCount: 120,
    grossSalesSatang: 4_520_000,
    discountSatang: 0,
    vatSatang: 0,
    netSalesSatang: 4_520_000,
    expenseTotalSatang: 3_420_000,
    byCategory: [
      { category: 'INGREDIENT', amountSatang: 1_420_000, kind: 'VARIABLE' },
      { category: 'RENT', amountSatang: 2_000_000, kind: 'FIXED' },
    ],
    netProfitSatang: 1_100_000,
    recipeCostSatang: 1_310_000,
    recipeCostPercentBp: 2898,
    contributionSatang: 3_210_000,
    coverage: { soldLineCount: 240, linesWithoutRecipeCount: 0 },
    breakEven: {
      fixedCostSatang: 2_000_000,
      fixedByCategory: [{ category: 'RENT', amountSatang: 2_000_000 }],
      rentFromSettings: false,
      contributionMarginBp: 7102,
      breakEvenSalesSatang: 2_815_827,
      breakEvenPerDaySatang: 90_833,
      daysInMonth: 31,
      surplusSatang: 1_704_173,
    },
    ...overrides,
  };
}

async function show(data: PnlResponse = pnl()): Promise<void> {
  vi.mocked(officeApi.pnl).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <PnlPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('กำไรขาดทุน')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the two cost bases', () => {
  it('warns not to subtract the recipe cost a second time', async () => {
    await show();
    // The single most damaging thing this screen could invite.
    expect(screen.getByText(/คือเงินก้อนเดียวกัน/)).toBeInTheDocument();
  });

  it('shows the cash profit and the recipe contribution as different figures', async () => {
    await show();
    expect(screen.getByText('11,000.00')).toBeInTheDocument(); // กำไรสุทธิ, cash basis
    expect(screen.getByText('32,100.00')).toBeInTheDocument(); // เหลือหลังหักของในชาม
  });

  it('flags dishes with no recipe, because a 0 cost reads as free', async () => {
    await show(pnl({ coverage: { soldLineCount: 240, linesWithoutRecipeCount: 31 } }));
    expect(screen.getByText(/31 รายการที่ยังไม่ได้ใส่สูตร/)).toBeInTheDocument();
  });
});

describe('break-even', () => {
  it('shows the target and how far past it the month is', async () => {
    await show();
    expect(screen.getByText('28,158.27')).toBeInTheDocument();
    expect(screen.getByText('เกินจุดคุ้มทุนแล้ว')).toBeInTheDocument();
  });

  it('says so in words when no amount of selling would break even', async () => {
    // A dish priced below its ingredients. Printing a huge number here, or a
    // blank, would both be read as a glitch rather than as the answer.
    await show(
      pnl({
        breakEven: {
          ...pnl().breakEven,
          contributionMarginBp: -1200,
          breakEvenSalesSatang: null,
          breakEvenPerDaySatang: null,
          surplusSatang: null,
        },
      }),
    );
    expect(screen.getByText(/ขายเท่าไหร่ก็ไม่คุ้ม/)).toBeInTheDocument();
  });

  it('admits when the rent came from settings rather than from a recorded expense', async () => {
    await show(
      pnl({
        breakEven: { ...pnl().breakEven, rentFromSettings: true },
      }),
    );
    expect(screen.getByText(/ใช้ค่าเช่าที่ตั้งไว้ในสาขาแทน/)).toBeInTheDocument();
  });
});

describe('a month with nothing recorded', () => {
  it('does not let sales masquerade as profit', async () => {
    await show(
      pnl({
        byCategory: [],
        expenseTotalSatang: 0,
        netProfitSatang: 4_520_000,
        breakEven: { ...pnl().breakEven, fixedCostSatang: 0, fixedByCategory: [] },
      }),
    );
    expect(screen.getByText(/ยังไม่มีรายจ่ายเลยสักรายการ/)).toBeInTheDocument();
    expect(screen.getByText(/ยังไม่มีต้นทุนคงที่เลย/)).toBeInTheDocument();
  });
});
