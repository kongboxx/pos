/**
 * The PIN screen.
 *
 * Two things are worth a test: the PIN submits on the fourth digit (the whole
 * reason there is no OK button), and it is cleared after a failure so the next
 * person does not inherit a half-typed guess.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api-client.js';
import { LoginPage } from './LoginPage.js';

vi.mock('../api-client.js', () => ({
  api: {
    loginBranches: vi.fn(),
    staffList: vi.fn(),
    login: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
  },
}));

const STAFF = {
  id: '11111111-1111-4111-8111-111111111111',
  fullName: 'สมหญิง พนักงาน',
  nickname: 'หญิง',
  role: 'STAFF' as const,
};

const BRANCH = { id: 'b', name: 'ร้านทดสอบ', branchCode: 'HQ' };

beforeEach(() => {
  // One branch, which must mean NO picker: a single-shop till never grows a
  // screen asking which of its one branch you meant.
  vi.mocked(api.loginBranches).mockResolvedValue({ ok: true, data: { branches: [BRANCH] } });
  vi.mocked(api.staffList).mockResolvedValue({
    ok: true,
    data: { branch: { id: 'b', name: 'ร้านทดสอบ', branchCode: 'HQ' }, staff: [STAFF] },
  });
  vi.mocked(api.me).mockResolvedValue({ ok: false, error: 'no session', offline: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

async function pickStaff(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByText('หญิง'));
}

function filledDots(): number {
  return screen.getAllByTestId('pin-dot').filter((dot) => dot.dataset['filled'] === 'true').length;
}

describe('LoginPage', () => {
  it('asks for a name before a PIN', async () => {
    renderLogin();
    expect(await screen.findByText('เลือกชื่อของคุณ')).toBeInTheDocument();
    expect(screen.queryByText('ใส่ PIN 4 หลัก')).not.toBeInTheDocument();
  });

  it('fills one dot per digit and does not submit early', async () => {
    const user = userEvent.setup();
    renderLogin();
    await pickStaff();

    await user.click(screen.getByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '3' }));

    expect(filledDots()).toBe(3);
    expect(api.login).not.toHaveBeenCalled();
  });

  it('submits automatically on the fourth digit', async () => {
    const user = userEvent.setup();
    vi.mocked(api.login).mockResolvedValue({ ok: true, data: { user: {} as never } });
    renderLogin();
    await pickStaff();

    for (const digit of ['1', '2', '3', '4']) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    await waitFor(() => {
      // No branch id: with one shop there is nothing to pick, and the server
      // resolves it exactly as it did before there was more than one branch.
      expect(api.login).toHaveBeenCalledWith(STAFF.id, '1234', undefined);
    });
  });

  it('asks which shop first when there is more than one, and sends it with the PIN', async () => {
    const user = userEvent.setup();
    const second = { id: 'b2', name: 'สาขาสอง', branchCode: 'BR02' };
    vi.mocked(api.loginBranches).mockResolvedValue({
      ok: true,
      data: { branches: [BRANCH, second] },
    });
    vi.mocked(api.staffList).mockResolvedValue({
      ok: true,
      data: { branch: second, staff: [STAFF] },
    });
    vi.mocked(api.login).mockResolvedValue({ ok: true, data: { user: {} as never } });
    renderLogin();

    await user.click(await screen.findByText('สาขาสอง'));
    await pickStaff();
    for (const digit of ['1', '2', '3', '4']) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    await waitFor(() => {
      expect(api.login).toHaveBeenCalledWith(STAFF.id, '1234', 'b2');
    });
    // The staff list must be the CHOSEN shop's, not the default branch's —
    // otherwise the picker is decoration and branch 2 gets branch 1's names.
    expect(api.staffList).toHaveBeenCalledWith('b2');
  });

  it('shows the server message and clears the PIN after a wrong one', async () => {
    const user = userEvent.setup();
    vi.mocked(api.login).mockResolvedValue({
      ok: false,
      error: 'PIN ไม่ถูกต้อง',
      offline: false,
    });
    renderLogin();
    await pickStaff();

    for (const digit of ['9', '9', '9', '9']) {
      await user.click(screen.getByRole('button', { name: digit }));
    }

    expect(await screen.findByRole('alert')).toHaveTextContent('PIN ไม่ถูกต้อง');
    // Leaving the digits on screen would hand the next person a free guess.
    await waitFor(() => expect(filledDots()).toBe(0));
  });

  it('clears the PIN when going back to the name list', async () => {
    const user = userEvent.setup();
    renderLogin();
    await pickStaff();

    await user.click(screen.getByRole('button', { name: '7' }));
    expect(filledDots()).toBe(1);

    await user.click(screen.getByRole('button', { name: '← เปลี่ยนชื่อ' }));
    await pickStaff();
    expect(filledDots()).toBe(0);
  });
});
