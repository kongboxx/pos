/**
 * Recording money that will come off somebody's pay.
 *
 * The two behaviours worth pinning down are the ones that decide whether this
 * screen is a ledger or a rumour: a settled row must be visibly settled and
 * beyond editing, and the form must keep the person and the date after a save —
 * recording a shift's worth of lateness is the same three fields over and over.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DeductionDto, DeductionListResponse, StaffListResponse } from '@pos/shared';
import { officeApi } from '../api-office.js';
import { DeductionsPage } from './DeductionsPage.js';

vi.mock('../api-office.js', () => ({
  officeApi: {
    deductions: vi.fn(),
    createDeduction: vi.fn(),
    deleteDeduction: vi.fn(),
    staff: vi.fn(),
  },
}));

let allowed = true;
vi.mock('../session.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({
      branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 },
      can: () => allowed,
    }),
}));

const STAFF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function row(over: Partial<DeductionDto> = {}): DeductionDto {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    staffId: STAFF_ID,
    staffName: 'อ่อง',
    date: '2026-07-15',
    type: 'LATE',
    amountSatang: 30_000,
    note: 'สาย 30 นาที',
    isSettled: false,
    ...over,
  };
}

function list(over: Partial<DeductionListResponse> = {}): DeductionListResponse {
  const deductions = over.deductions ?? [row()];
  return {
    yearMonth: '2026-07',
    deductions,
    totalSatang: deductions.reduce((sum, item) => sum + item.amountSatang, 0),
    unsettledSatang: deductions
      .filter((item) => !item.isSettled)
      .reduce((sum, item) => sum + item.amountSatang, 0),
    ...over,
  };
}

const roster: StaffListResponse = {
  today: '2026-07-30',
  staff: [
    {
      id: STAFF_ID,
      fullName: 'Aung Min',
      nickname: 'อ่อง',
      position: null,
      role: 'STAFF',
      phone: null,
      email: null,
      hasOfficeAccess: false,
      isLoginLocked: false,
      startDate: '2026-07-01',
      endDate: null,
      status: 'ACTIVE',
      nationality: 'FOREIGN',
      passportNo: null,
      passportExpiry: null,
      workPermitNo: null,
      workPermitExpiry: null,
      wageType: 'DAILY',
      wageRateSatang: 45_000,
      note: null,
      lastLoginAt: null,
      isPinLocked: false,
      hasHistory: true,
    },
  ],
};

async function show(data: DeductionListResponse = list()): Promise<void> {
  vi.mocked(officeApi.deductions).mockResolvedValue({ ok: true, data });
  vi.mocked(officeApi.staff).mockResolvedValue({ ok: true, data: roster });
  render(
    <MemoryRouter>
      <DeductionsPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('สาย 30 นาที')).toBeInTheDocument());
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  allowed = true;
  vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
});

describe('recording one', () => {
  it('sends satang with the reason as a key, not as Thai text', async () => {
    // "มาสาย", "สาย" and "เข้างานสาย" typed freehand are three things nothing
    // can add together at the end of the month.
    vi.mocked(officeApi.createDeduction).mockResolvedValue({ ok: true, data: list() });
    await show();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('พนักงาน'), { target: { value: STAFF_ID } });
      fireEvent.change(screen.getByLabelText('จำนวนเงิน (บาท)'), { target: { value: '300' } });
    });
    await tap(screen.getByRole('button', { name: 'บันทึก' }));

    expect(officeApi.createDeduction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: STAFF_ID, amountSatang: 30_000, type: 'LATE' }),
    );
  });

  it('keeps the person, the date and the reason for the next row', async () => {
    vi.mocked(officeApi.createDeduction).mockResolvedValue({ ok: true, data: list() });
    await show();

    await tap(screen.getByRole('button', { name: /ขาดงาน/ }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('พนักงาน'), { target: { value: STAFF_ID } });
      fireEvent.change(screen.getByLabelText('จำนวนเงิน (บาท)'), { target: { value: '450' } });
    });
    await tap(screen.getByRole('button', { name: 'บันทึก' }));

    expect(screen.getByLabelText('จำนวนเงิน (บาท)')).toHaveValue('');
    expect(screen.getByLabelText('พนักงาน')).toHaveValue(STAFF_ID);
    expect(screen.getByRole('button', { name: /ขาดงาน/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('refuses to send without a person picked', async () => {
    await show();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('จำนวนเงิน (บาท)'), { target: { value: '300' } });
    });
    await tap(screen.getByRole('button', { name: 'บันทึก' }));

    expect(officeApi.createDeduction).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('เลือกพนักงานก่อน');
  });
});

describe('a row a payslip already took', () => {
  it('is marked settled and offers no delete', async () => {
    // Removing it would not give the money back. It would only make the slip in
    // somebody's hand and the database disagree.
    await show(list({ deductions: [row({ isSettled: true })] }));

    const item = screen.getByText('สาย 30 นาที').closest('li') as HTMLElement;
    expect(within(item).getByText('ตัดจากสลิปแล้ว')).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: 'ลบ' })).not.toBeInTheDocument();
  });
});

describe('the month summary', () => {
  it('separates what has been settled from what the next run will take', async () => {
    await show(
      list({
        deductions: [
          row({ isSettled: true }),
          row({ id: 'x', amountSatang: 12_000, note: 'สาย 10 นาที' }),
        ],
      }),
    );
    // Scoped to the summary card: 120.00 also appears as one of the rows, and
    // the point of this test is the two TOTALS being different numbers.
    const summary = screen.getByText('รวมทั้งเดือน').closest('section') as HTMLElement;
    expect(within(summary).getByText('420.00')).toBeInTheDocument();
    expect(within(summary).getByText('120.00')).toBeInTheDocument();
  });
});

describe('a role that may read but not write', () => {
  it('hides the form rather than showing a button that will 403', async () => {
    allowed = false;
    await show();
    expect(screen.queryByLabelText('จำนวนเงิน (บาท)')).not.toBeInTheDocument();
    expect(screen.getByText('สาย 30 นาที')).toBeInTheDocument();
  });
});
