/**
 * ตั้งค่าสาขา.
 *
 * The tests here are about the three things on this screen that can hurt, and
 * whether the screen says so BEFORE the save rather than after it:
 *
 *  - the branch code is frozen once a document carries it (rule #9), so the
 *    field must be disabled with the reason next to it;
 *  - VAT switched on with a future start date must read as "not charging yet",
 *    because the switch being on and the tills charging nothing is exactly the
 *    state that looks like a bug;
 *  - the rate goes out in basis points. 7% is 700, never 0.07 (rule #2).
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { BranchDto, BranchListResponse } from '@pos/shared';
import { officeApi } from '../api-office.js';
import { BranchesPage } from './BranchesPage.js';

vi.mock('../api-office.js', () => ({
  officeApi: { branches: vi.fn(), createBranch: vi.fn(), updateBranch: vi.fn() },
}));

vi.mock('../session.js', () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({ branch: { timezone: 'Asia/Bangkok', dayCutoffHour: 4 }, can: () => true }),
}));

const BRANCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function branch(over: Partial<BranchDto> = {}): BranchDto {
  return {
    id: BRANCH_ID,
    name: 'ร้านก๋วยเตี๋ยว สาขาหลัก',
    branchCode: 'HQ',
    businessType: 'RESTAURANT',
    address: null,
    phone: null,
    taxId: null,
    timezone: 'Asia/Bangkok',
    dayCutoffHour: 4,
    vatEnabled: false,
    vatRateBp: 0,
    priceIncludesVat: true,
    vatEffectiveDate: null,
    rentPerMonthSatang: 1_500_000,
    promptPayId: null,
    qrOrderingEnabled: true,
    isActive: true,
    activeStaffCount: 3,
    hasDocuments: true,
    ...over,
  };
}

function list(over: Partial<BranchDto> = {}, today = '2026-07-30'): BranchListResponse {
  return { currentBranchId: BRANCH_ID, today, branches: [branch(over)] };
}

async function show(data: BranchListResponse = list()): Promise<void> {
  vi.mocked(officeApi.branches).mockResolvedValue({ ok: true, data });
  render(
    <MemoryRouter>
      <BranchesPage />
    </MemoryRouter>,
  );
  await screen.findByText('ข้อมูลร้าน');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the settings form', () => {
  it('locks the branch code and says why', async () => {
    await show();

    const code = screen.getByLabelText(/รหัสสาขา/) as HTMLInputElement;
    expect(code).toBeDisabled();
    expect(code.value).toBe('HQ');
    expect(screen.getByText(/มีเลขเอกสารที่ออกด้วยรหัสนี้ไปแล้ว/)).toBeInTheDocument();
  });

  it('hides the VAT fields until the switch is on', async () => {
    const user = userEvent.setup();
    await show();

    expect(screen.queryByLabelText(/อัตรา/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('คิด VAT'));
    // Prefilled with 7, the only rate a Thai shop will ever type.
    expect((screen.getByLabelText(/อัตรา/) as HTMLInputElement).value).toBe('7');
  });

  it('reads a future start date as "not charging yet"', async () => {
    // The state that looks exactly like a bug — switch on, tills charging
    // nothing — so the screen has to say it in words.
    await show(list({ vatEnabled: true, vatRateBp: 700, vatEffectiveDate: '2099-01-01' }));

    expect(screen.getByText(/ยังไม่เริ่มคิด/)).toBeInTheDocument();
    expect(screen.getByText(/2099-01-01/)).toBeInTheDocument();
  });

  it('says it is charging when the start date has passed', async () => {
    await show(list({ vatEnabled: true, vatRateBp: 700, vatEffectiveDate: '2026-01-01' }));

    expect(screen.getByText(/คิด VAT อยู่ตอนนี้/)).toBeInTheDocument();
  });

  it('sends the rate in basis points and the rent in satang', async () => {
    const user = userEvent.setup();
    vi.mocked(officeApi.updateBranch).mockResolvedValue({ ok: true, data: branch() });
    await show();

    await user.click(screen.getByLabelText('คิด VAT'));
    await user.clear(screen.getByLabelText(/เลขประจำตัวผู้เสียภาษีของร้าน/));
    await user.type(screen.getByLabelText(/เลขประจำตัวผู้เสียภาษีของร้าน/), '0105558123451');
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));

    await waitFor(() => expect(officeApi.updateBranch).toHaveBeenCalled());
    const [, payload] = vi.mocked(officeApi.updateBranch).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // 7% is 700, never 0.07 — the rate is an Int all the way down (rule #2).
    expect(payload['vatRateBp']).toBe(700);
    expect(payload['rentPerMonthSatang']).toBe(1_500_000);
    expect(payload['taxId']).toBe('0105558123451');
  });

  it('refuses locally when VAT is on with no shop tax id, without calling the server', async () => {
    const user = userEvent.setup();
    await show();

    await user.click(screen.getByLabelText('คิด VAT'));
    await user.click(screen.getByRole('button', { name: 'บันทึก' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/เลขประจำตัวผู้เสียภาษี/);
    expect(officeApi.updateBranch).not.toHaveBeenCalled();
  });
});

describe('adding a shop', () => {
  it('asks for the first owner and a PIN in the same form', async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole('button', { name: '+ เพิ่มสาขา' }));

    // A branch with nobody who can log in is a branch nobody can open, so the
    // owner is not a separate step that can be skipped.
    const dialog = screen.getByRole('dialog', { name: 'เพิ่มสาขา' });
    expect(within(dialog).getByLabelText(/ชื่อเจ้าของสาขา/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/PIN 4 หลัก/)).toBeInTheDocument();
  });

  it('uppercases the branch code on the way out', async () => {
    const user = userEvent.setup();
    vi.mocked(officeApi.createBranch).mockResolvedValue({
      ok: true,
      data: branch({ id: 'other' }),
    });
    await show();
    await user.click(screen.getByRole('button', { name: '+ เพิ่มสาขา' }));

    const dialog = screen.getByRole('dialog', { name: 'เพิ่มสาขา' });
    await user.type(within(dialog).getByLabelText(/ชื่อสาขา/), 'สาขาสอง');
    await user.type(within(dialog).getByLabelText(/รหัสสาขา/), 'br02');
    await user.type(within(dialog).getByLabelText(/ชื่อเจ้าของสาขา/), 'สมชาย');
    await user.type(within(dialog).getByLabelText(/PIN 4 หลัก/), '2468');
    await user.click(within(dialog).getByRole('button', { name: 'เปิดสาขา' }));

    await waitFor(() => expect(officeApi.createBranch).toHaveBeenCalled());
    const [payload] = vi.mocked(officeApi.createBranch).mock.calls[0] as [Record<string, unknown>];
    expect(payload['branchCode']).toBe('BR02');
    expect(payload['ownerPin']).toBe('2468');
  });
});
