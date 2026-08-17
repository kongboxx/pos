/**
 * The back office door.
 *
 * The second test is the one that matters most and it is a negative: this page
 * must not list who works here. The till's login screen does, deliberately, on
 * a device already inside the shop. This one is on the open internet, where a
 * staff list is a directory of names, roles and the id needed to start
 * guessing a PIN.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type * as ReactRouter from 'react-router-dom';
import { OfficeLoginPage } from './OfficeLoginPage.js';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof ReactRouter>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const login = vi.fn();
vi.mock('../session.js', () => ({
  useSession: (selector: (state: { login: unknown }) => unknown) => selector({ login }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <OfficeLoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockReset();
  login.mockReset();
  login.mockResolvedValue({ ok: true });
});

describe('the back office login screen', () => {
  it('asks for an email and a password, and nothing else', () => {
    renderPage();
    expect(screen.getByLabelText('อีเมล')).toBeTruthy();
    expect(screen.getByLabelText('รหัสผ่าน')).toBeTruthy();
  });

  it('NEVER lists the staff', () => {
    renderPage();
    // No dropdown, no roster, no request that could produce one. The till's
    // screen has a picker; this one must not, on the internet.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('sends what was typed and lands on the menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'a-password-long-enough');
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        email: 'noi@example.com',
        password: 'a-password-long-enough',
      });
    });
    expect(navigate).toHaveBeenCalledWith('/office/menu', { replace: true });
  });

  it('clears the password but keeps the email when it is refused', async () => {
    // Retyping the address after every slip is how a real person ends up
    // pasting their password into the email box.
    login.mockResolvedValue({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));

    await screen.findByText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    expect((screen.getByLabelText('รหัสผ่าน') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('อีเมล') as HTMLInputElement).value).toBe('noi@example.com');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the API’s own words when the account is frozen', async () => {
    // The lockout message carries how many minutes are left, and only the
    // server knows that. Rewriting it here would drop the number.
    login.mockResolvedValue({
      ok: false,
      error: 'ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกล็อก กรุณารออีก 15 นาที',
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'a-password-long-enough');
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));

    await screen.findByText(/บัญชีถูกล็อก/);
  });

  it('keeps the password out of the DOM as text', async () => {
    const user = userEvent.setup();
    renderPage();
    const field = screen.getByLabelText('รหัสผ่าน') as HTMLInputElement;
    await user.type(field, 'a-password-long-enough');
    expect(field.type).toBe('password');
  });

  it('will not submit with an empty field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
    expect(login).not.toHaveBeenCalled();
  });

  it('does not fire twice when the button is double-clicked', async () => {
    // bcrypt cost 12 takes about a second. Without a busy flag an impatient
    // click is two logins and two session rows.
    let release: (value: { ok: true }) => void = () => {};
    login.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'a-password-long-enough');
    const button = screen.getByRole('button', { name: /เข้าสู่ระบบ|กำลัง/ });
    await user.click(button);
    await user.click(button);

    expect(login).toHaveBeenCalledTimes(1);
    release({ ok: true });
  });
});
