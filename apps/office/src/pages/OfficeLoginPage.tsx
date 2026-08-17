/**
 * The back office door.
 *
 * An email typed from memory, not a name picked off a list. That difference is
 * the whole point of the screen: the till's login shows the roster because it
 * runs on a tablet already inside the shop, and this one is on the open
 * internet, where the same list would hand a stranger every name, every role,
 * and the id they need before they start guessing PINs.
 *
 * No keypad either. The till has one because a thumb on a tablet needs big
 * targets; the back office is opened on a machine with a keyboard.
 *
 * The error text comes from the API verbatim. It is the only side that knows
 * how many minutes are left on a lockout, and paraphrasing it here would throw
 * that number away.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { path } from '@pos/web-kit';
import { useSession } from '../session.js';

export function OfficeLoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const login = useSession((state) => state.login);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    // bcrypt at cost 12 takes about a second, which is long enough for an
    // impatient second click to become a second session row.
    if (busy) return;

    setBusy(true);
    setError(null);
    const result = await login({ email, password });
    setBusy(false);

    if (result.ok) {
      navigate(path.menu, { replace: true });
      return;
    }

    setError(result.error);
    // The password goes, the email stays. Retyping the address after every
    // slip is how someone ends up pasting their password into the email box.
    setPassword('');
  };

  const ready = email.trim() !== '' && password !== '';

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-80 space-y-4">
      <h1 className="text-xl font-medium">หลังร้าน</h1>

      <label className="block">
        <span className="text-sm text-slate-600">อีเมล</span>
        <input
          aria-label="อีเมล"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-11 w-full rounded-xl border border-slate-300 px-2"
        />
      </label>

      <label className="block">
        <span className="text-sm text-slate-600">รหัสผ่าน</span>
        <input
          aria-label="รหัสผ่าน"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-11 w-full rounded-xl border border-slate-300 px-2"
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!ready || busy}
        className="h-11 w-full rounded-xl bg-slate-900 text-white disabled:bg-slate-300"
      >
        {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </button>
    </form>
  );
}
