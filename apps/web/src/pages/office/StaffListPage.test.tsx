/**
 * The staff list.
 *
 * Three things here are load-bearing and none of them are the form fields:
 *
 *  - the PIN must not travel in an edit. Changing a phone number and reissuing
 *    somebody's credential are different acts, and merging them means every
 *    edit is a chance to silently change who can sign in.
 *  - a work permit about to lapse has to be visible without anyone going
 *    looking. It is the shop that carries that risk, not the employee.
 *  - someone with history offers no delete button at all, because the refusal
 *    is a fact about their records rather than a permission the owner lacks.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { toBusinessDate, type StaffDto, type StaffListResponse } from '@pos/shared';
import { api } from '../../api-client.js';
import { StaffListPage } from './StaffListPage.js';

const TODAY = toBusinessDate(new Date(), { timezone: 'Asia/Bangkok', dayCutoffHour: 4 });

vi.mock('../../api-client.js', () => ({
  api: {
    staff: vi.fn(),
    createStaff: vi.fn(),
    updateStaff: vi.fn(),
    setStaffPin: vi.fn(),
    deleteStaff: vi.fn(),
  },
}));

let allowed = true;
vi.mock('../../session-store.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({
      branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 },
      can: () => allowed,
    }),
}));

function person(over: Partial<StaffDto> = {}): StaffDto {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fullName: 'Aung Min',
    nickname: 'อ่อง',
    position: 'ผู้ช่วยครัว',
    role: 'STAFF',
    phone: null,
    startDate: '2026-07-01',
    endDate: null,
    status: 'ACTIVE',
    nationality: 'FOREIGN',
    passportNo: 'MM1234567',
    passportExpiry: '2029-05-31',
    workPermitNo: 'WP-2026-00891',
    workPermitExpiry: '2027-03-15',
    wageType: 'DAILY',
    wageRateSatang: 45_000,
    note: null,
    lastLoginAt: null,
    isPinLocked: false,
    hasHistory: false,
    ...over,
  };
}

function roster(staff: StaffDto[] = [person()], today = TODAY): StaffListResponse {
  return { today, staff };
}

async function show(data: StaffListResponse = roster()): Promise<void> {
  vi.mocked(api.staff).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <StaffListPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Aung Min')).toBeInTheDocument());
}

async function tap(element: HTMLElement): Promise<void> {
  await act(async () => {
    await userEvent.setup().click(element);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  allowed = true;
});

describe('the list', () => {
  it('shows the wage with the unit it is paid in', async () => {
    // "450.00" alone is a daily rate and a monthly one at the same time, and
    // the difference is a factor of about twenty-six.
    await show();
    expect(screen.getByText('450.00')).toBeInTheDocument();
    expect(screen.getByText('/วัน')).toBeInTheDocument();
  });

  it('keeps people who left on the list rather than hiding them', async () => {
    // Their names are on old payslips and approved voids. Hiding them makes
    // those records unexplainable a year later.
    await show(roster([person({ status: 'LEFT', endDate: '2026-06-30' })]));
    expect(screen.getByText('Aung Min')).toBeInTheDocument();
    expect(screen.getByText(/ลาออกแล้ว/)).toBeInTheDocument();
  });

  it('flags a locked PIN so the owner knows a reset is what is needed', async () => {
    await show(roster([person({ isPinLocked: true })]));
    expect(screen.getByText('PIN ถูกล็อก')).toBeInTheDocument();
  });
});

describe('document expiry', () => {
  it('says nothing about a permit that is years away', async () => {
    await show(roster([person({ workPermitExpiry: '2030-01-01', passportExpiry: '2030-01-01' })]));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('warns 90 days out and shouts once it has lapsed', async () => {
    await show(
      roster(
        [
          person({ workPermitExpiry: '2026-09-15', passportExpiry: null }),
          person({
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            fullName: 'Thet Naing',
            nickname: 'เท็ด',
            workPermitExpiry: '2026-01-01',
            passportExpiry: null,
          }),
        ],
        '2026-07-30',
      ),
    );

    expect(screen.getByRole('status')).toHaveTextContent('2 รายการ');
    expect(screen.getByText(/ใบอนุญาตทำงานจะหมดอายุ 2026-09-15/)).toBeInTheDocument();
    expect(screen.getByText(/ใบอนุญาตทำงานหมดอายุแล้ว/)).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('has no PIN field on the edit form at all', async () => {
    await show();
    await tap(screen.getByRole('button', { name: 'แก้ไข' }));

    const form = screen.getByRole('form', { name: 'แก้ไขพนักงาน' });
    expect(within(form).queryByLabelText('PIN เข้าใช้งาน')).not.toBeInTheDocument();
    // …and the create form does have one, so this is a difference, not an
    // omission that happens to pass.
    await tap(screen.getByRole('button', { name: 'ยกเลิก' }));
    await tap(screen.getByRole('button', { name: '+ เพิ่มพนักงาน' }));
    expect(screen.getByLabelText('PIN เข้าใช้งาน')).toBeInTheDocument();
  });

  it('sends the wage as satang, not baht', async () => {
    vi.mocked(api.updateStaff).mockResolvedValue({ ok: true, data: roster() });
    await show();
    await tap(screen.getByRole('button', { name: 'แก้ไข' }));

    await act(async () => {
      const wage = screen.getByLabelText('ค่าแรง');
      await userEvent.setup().clear(wage);
      await userEvent.setup().type(wage, '500');
    });
    await tap(screen.getByRole('button', { name: 'บันทึกการแก้ไข' }));

    expect(api.updateStaff).toHaveBeenCalledWith(
      person().id,
      expect.objectContaining({ wageRateSatang: 50_000 }),
    );
  });

  it('only asks for passport and permit when the person is not Thai', async () => {
    await show(
      roster([person({ nationality: 'TH', passportExpiry: null, workPermitExpiry: null })]),
    );
    await tap(screen.getByRole('button', { name: 'แก้ไข' }));
    expect(screen.queryByLabelText('เลขใบอนุญาตทำงาน')).not.toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('offers no delete button once anything points at them', async () => {
    await show(roster([person({ hasHistory: true })]));
    expect(screen.queryByRole('button', { name: 'ลบ' })).not.toBeInTheDocument();
    // An explanation, not a disabled control: the answer is "ลาออก", and a
    // greyed button says "ask someone with more rights", which is wrong.
    expect(screen.getByText('มีประวัติแล้ว ลบไม่ได้')).toBeInTheDocument();
  });

  it('offers it for a row that has touched nothing', async () => {
    await show();
    expect(screen.getByRole('button', { name: 'ลบ' })).toBeInTheDocument();
  });
});

describe('a role that may read but not write', () => {
  it('hides every action rather than showing buttons that will 403', async () => {
    allowed = false;
    await show();
    expect(screen.queryByRole('button', { name: '+ เพิ่มพนักงาน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'แก้ไข' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ตั้ง PIN ใหม่' })).not.toBeInTheDocument();
    expect(screen.getByText('Aung Min')).toBeInTheDocument();
  });
});
