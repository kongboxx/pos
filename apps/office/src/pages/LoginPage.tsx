/**
 * The back office login — deliberately minimal and deliberately temporary.
 *
 * Still the till's PIN, because plan 1 changes nothing about how the API
 * authenticates. Plan 2 replaces this whole file with an email and password
 * form, so nothing here is worth polishing.
 *
 * It exists at all because the two sites no longer share a cookie: that is the
 * point of splitting them, and it means the office needs its own door.
 *
 * Not copied from the till's LoginPage — 277 lines with a Keypad sized for
 * fingers on a tablet. The office is opened on a computer that has a keyboard.
 *
 * NO TESTS, on purpose, against this project's habit. Plan 2 deletes the file;
 * the real login it replaces this with must be tested properly — wrong PIN
 * clears the field, a frozen account says so, success lands on the menu, and
 * above all it must NOT list the staff for anyone who opens the page.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { path } from '@pos/web-kit';
import type { StaffPublic } from '@pos/shared';
import { officeApi } from '../api-office.js';
import { useSession } from '../session.js';

export function LoginPage(): React.ReactElement {
  const [staff, setStaff] = useState<StaffPublic[]>([]);
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const login = useSession((state) => state.login);
  const navigate = useNavigate();

  useEffect(() => {
    void officeApi.staffList().then((result) => {
      if (result.ok) setStaff(result.data.staff);
      else setError(result.error);
    });
  }, []);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const result = await login(staffId, pin);
    if (result.ok) navigate(path.menu, { replace: true });
    else {
      setError(result.error);
      setPin('');
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-80 space-y-4">
      <h1 className="text-xl font-medium">หลังร้าน</h1>

      <label className="block">
        <span className="text-sm text-slate-600">ชื่อ</span>
        <select
          aria-label="ชื่อ"
          value={staffId}
          onChange={(event) => setStaffId(event.target.value)}
          className="h-11 w-full rounded-xl border border-slate-300 px-2"
        >
          <option value="">— เลือกชื่อ —</option>
          {staff.map((person) => (
            <option key={person.id} value={person.id}>
              {person.nickname ?? person.fullName}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm text-slate-600">PIN 4 หลัก</span>
        <input
          aria-label="PIN 4 หลัก"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
          className="tnum h-11 w-full rounded-xl border border-slate-300 px-2"
        />
      </label>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={staffId === '' || pin.length !== 4}
        className="h-11 w-full rounded-xl bg-slate-900 text-white disabled:bg-slate-300"
      >
        เข้าสู่ระบบ
      </button>
    </form>
  );
}
