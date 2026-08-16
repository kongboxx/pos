/**
 * The payroll screen.
 *
 * What is worth testing here is what the screen REFUSES to let happen and what
 * it says out loud before money moves:
 *
 *  - a draft and a paid run must not look alike, and a paid one must expose no
 *    editable field at all;
 *  - the pay button has to be unusable when somebody's net is negative, because
 *    the server will refuse and the owner should find that out before pressing;
 *  - wages already typed into the expense screen by hand have to be on screen
 *    BEFORE the button, or the month ends up wrong by a full payroll.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PayrollLineDto, PayrollResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { PayrollPage } from './PayrollPage.js';

vi.mock('../../api-client.js', () => ({
  api: {
    payroll: vi.fn(),
    generatePayroll: vi.fn(),
    updatePayrollLine: vi.fn(),
    payPayroll: vi.fn(),
    unpayPayroll: vi.fn(),
    discardPayroll: vi.fn(),
  },
}));

let allowed = true;
vi.mock('../../session.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({
      branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4, name: 'ร้านก๋วยเตี๋ยว สาขาหลัก' },
      can: () => allowed,
    }),
}));

function line(over: Partial<PayrollLineDto> = {}): PayrollLineDto {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    staffId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    fullName: 'Aung Min',
    nickname: 'อ่อง',
    position: 'ผู้ช่วยครัว',
    wageTypeSnapshot: 'DAILY',
    wageRateSnapshot: 45_000,
    daysWorked: 24,
    grossSatang: 1_080_000,
    bonusSatang: 0,
    deductSatang: 30_000,
    netSatang: 1_050_000,
    deductions: [{ date: '2026-07-15', type: 'LATE', amountSatang: 30_000, note: 'สาย 30 นาที' }],
    note: null,
    ...over,
  };
}

function run(over: Partial<PayrollResponse> = {}): PayrollResponse {
  return {
    yearMonth: '2026-07',
    payroll: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      paidAt: null,
      totalSatang: 1_050_000,
      expenseId: null,
      lines: [line()],
      ...(over.payroll ?? {}),
    },
    manualWageSatang: 0,
    staffWithoutWageCount: 0,
    ...over,
  };
}

async function show(data: PayrollResponse = run()): Promise<void> {
  vi.mocked(api.payroll).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <PayrollPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

/**
 * The clock is pinned because this screen opens on whatever month "today"
 * falls in, and every assertion below is written about July 2026.
 *
 * Without this the file passes all through July and starts failing on the 1st
 * of August — the morning somebody is actually running a payroll.
 *
 * Only `Date` is faked, and it is FROZEN. setTimeout stays real so userEvent
 * and waitFor behave normally, and a clock that does not tick means the
 * assertions cannot depend on how loaded the machine was when they ran —
 * letting it advance with real time made this file flake under a full suite.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-20T05:00:00Z'));
  vi.clearAllMocks();
  allowed = true;
  vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a month with no run yet', () => {
  it('offers to build one instead of showing an empty table', async () => {
    vi.mocked(api.payroll).mockResolvedValue({ ok: true, data: run({ payroll: null }) });
    render(
      <MemoryRouter>
        <PayrollPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /สร้างรอบเงินเดือน/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('a draft', () => {
  it('shows the live figures with the deduction taken off', async () => {
    await show();
    const row = screen.getByRole('row', { name: /อ่อง/ });
    expect(within(row).getByText('10,800.00')).toBeInTheDocument();
    expect(within(row).getByText('-300.00')).toBeInTheDocument();
    expect(within(row).getByText('10,500.00')).toBeInTheDocument();
  });

  it('commits a day count on blur, not on every keystroke', async () => {
    // Each save re-totals the whole run on the server. Firing that per digit
    // would make "24" briefly mean two days' pay on screen.
    vi.mocked(api.updatePayrollLine).mockResolvedValue({ ok: true, data: run() });
    await show();

    const days = screen.getByLabelText('วันทำงานของ อ่อง');
    await act(async () => {
      fireEvent.change(days, { target: { value: '26' } });
    });
    expect(api.updatePayrollLine).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.blur(days);
    });
    // waitFor, not a bare expect: the blur handler saves and then the effect
    // re-syncs the field from the server's answer. Under a loaded full-suite
    // run that round trip lands after the assertion would have read the mock,
    // which made this the one test in the file that failed only in company.
    await waitFor(() =>
      expect(api.updatePayrollLine).toHaveBeenCalledWith(
        line().id,
        expect.objectContaining({ daysWorked: 26 }),
      ),
    );
  });

  it('does not call the server when the number did not actually change', async () => {
    await show();
    await act(async () => {
      fireEvent.blur(screen.getByLabelText('วันทำงานของ อ่อง'));
    });
    expect(api.updatePayrollLine).not.toHaveBeenCalled();
  });

  it('warns about wages already typed in by hand, before the pay button', async () => {
    // The wage version of the double-count rule. Not blocked: usually a genuine
    // advance to one person, occasionally the whole payroll entered twice.
    await show(run({ manualWageSatang: 500_000 }));
    expect(screen.getByRole('status')).toHaveTextContent('5,000.00');
    expect(screen.getByRole('status')).toHaveTextContent('พิมพ์เองไว้แล้ว');
  });

  it('refuses to pay when somebody is deducted more than they earned', async () => {
    await show(
      run({
        payroll: {
          ...run().payroll!,
          lines: [line({ deductSatang: 1_200_000, netSatang: -120_000 })],
        },
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent('ถูกหักมากกว่าค่าแรงที่ได้');
    expect(screen.getByRole('button', { name: /จ่ายเงินเดือน/ })).toBeDisabled();
  });

  it('sends the date the money actually leaves the till', async () => {
    // The P&L is cash basis: a July payroll paid on 3 August is an August cost.
    vi.mocked(api.payPayroll).mockResolvedValue({ ok: true, data: run() });
    await show();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('วันที่จ่ายจริง'), {
        target: { value: '2026-08-03' },
      });
    });
    await tap(screen.getByRole('button', { name: /จ่ายเงินเดือน/ }));

    expect(api.payPayroll).toHaveBeenCalledWith(
      '2026-07',
      expect.objectContaining({ paidDate: '2026-08-03' }),
    );
  });
});

describe('a paid run', () => {
  const paid = () =>
    run({
      payroll: {
        ...run().payroll!,
        paidAt: '2026-08-03T04:00:00.000Z',
        expenseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    });

  it('exposes no editable field at all', async () => {
    await show(paid());
    expect(screen.queryByLabelText('วันทำงานของ อ่อง')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('โบนัสของ อ่อง')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^จ่ายเงินเดือน/ })).not.toBeInTheDocument();
    expect(screen.getByText(/จ่ายแล้ว/)).toBeInTheDocument();
  });

  it('offers an explicit undo rather than leaving the database as the only fix', async () => {
    vi.mocked(api.unpayPayroll).mockResolvedValue({ ok: true, data: run() });
    await show(paid());

    await tap(screen.getByRole('button', { name: 'ยกเลิกการจ่าย' }));
    expect(api.unpayPayroll).toHaveBeenCalledWith('2026-07');
  });
});

describe('the payslip', () => {
  it('itemises every deduction with its date and reason', async () => {
    // A slip reading "หัก 300" starts an argument nobody can settle.
    await show();
    await tap(screen.getByRole('button', { name: 'สลิป' }));

    const slip = screen.getByRole('dialog');
    expect(within(slip).getByText(/2026-07-15/)).toBeInTheDocument();
    expect(within(slip).getByText(/มาสาย/)).toBeInTheDocument();
    expect(within(slip).getByText(/สาย 30 นาที/)).toBeInTheDocument();
    expect(within(slip).getByText('10,500.00')).toBeInTheDocument();
  });

  it('says on the paper when the run has not been paid', async () => {
    await show();
    await tap(screen.getByRole('button', { name: 'สลิป' }));
    expect(within(screen.getByRole('dialog')).getByText(/ยังไม่ได้จ่าย/)).toBeInTheDocument();
  });
});

describe('a role that may read but not write', () => {
  it('hides every action rather than showing buttons that will 403', async () => {
    allowed = false;
    await show();
    expect(screen.queryByRole('button', { name: /จ่ายเงินเดือน/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('วันทำงานของ อ่อง')).not.toBeInTheDocument();
    // The figures are still readable — this role got through the route guard.
    // Twice over: the run total in the header and this one person's net.
    expect(screen.getAllByText('10,500.00')).toHaveLength(2);
  });
});
