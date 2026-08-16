/**
 * PIN login.
 *
 * Two steps: tap your name, then type four digits. Picking the name first is
 * not only faster on a tablet — it lets the server bcrypt-check exactly one
 * hash instead of every staff row (see auth.service.ts).
 *
 * The PIN is never echoed; only filled dots. It is held in component state and
 * cleared the moment it is submitted.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Role, type BranchChoice, type StaffPublic } from '@pos/shared';
import { api } from '../api-client.js';
import { Keypad } from '../components/Keypad.js';
import { useSession } from '../session.js';
import { path } from '@pos/web-kit';

const PIN_LENGTH = 4;

const ROLE_LABEL: Record<Role, string> = {
  [Role.OWNER]: 'เจ้าของร้าน',
  [Role.MANAGER]: 'ผู้จัดการ',
  [Role.STAFF]: 'พนักงาน',
};

export function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const login = useSession((state) => state.login);

  const [staff, setStaff] = useState<StaffPublic[] | null>(null);
  const [branchName, setBranchName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * The shops to choose from (Step 10).
   *
   * `null` while loading, and a list of ONE is treated as no choice at all —
   * a single-shop till must never grow a screen that asks which of its one
   * branch you meant. `branchId` stays undefined in that case and the server
   * resolves it, exactly as it did before there was more than one branch.
   */
  const [branches, setBranches] = useState<BranchChoice[] | null>(null);
  const [branchId, setBranchId] = useState<string | undefined>(undefined);

  const [selected, setSelected] = useState<StaffPublic | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.loginBranches();
      if (cancelled) return;
      // A failure here is not fatal: fall through to the single-branch path
      // and let the staff list report the real connection problem.
      setBranches(result.ok ? result.data.branches : []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const needsBranchChoice = !!branches && branches.length > 1 && !branchId;

  useEffect(() => {
    if (branches === null || needsBranchChoice) return;

    let cancelled = false;
    void (async () => {
      const result = await api.staffList(branchId);
      if (cancelled) return;
      if (result.ok) {
        setStaff(result.data.staff);
        setBranchName(result.data.branch.name);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branches, branchId, needsBranchChoice]);

  const submit = useCallback(
    async (staffId: string, candidate: string) => {
      setBusy(true);
      setError(null);
      const result = await login(staffId, candidate, branchId);
      setBusy(false);
      // Always clear: a wrong PIN left on screen is the next person's hint.
      setPin('');
      if (result.ok) {
        navigate(path.tables, { replace: true });
      } else {
        setError(result.error);
      }
    },
    [login, navigate, branchId],
  );

  /**
   * Submit on the fourth digit — no "OK" button to hunt for.
   *
   * The submit is deliberately NOT inside a setPin updater. React may call an
   * updater more than once, so doing the work in there sent two login attempts
   * for one entry, and a mistyped PIN burned two of the five tries before the
   * lockout. Found while testing the identical keypad in VoidDialog (Step 5).
   *
   * The error also survives until the next attempt rather than clearing on the
   * first digit: clearing it removes a line of text and slides the keypad up
   * under the finger that is already moving to the second digit.
   */
  const pressDigit = useCallback(
    (digit: string) => {
      if (!selected || busy || pin.length >= PIN_LENGTH) return;
      const next = pin + digit;
      setPin(next);
      if (next.length === PIN_LENGTH) void submit(selected.id, next);
    },
    [selected, busy, pin, submit],
  );

  if (needsBranchChoice) {
    return (
      <CenteredCard wide>
        <h1 className="text-3xl font-bold">เลือกสาขา</h1>
        <p className="mt-1 text-slate-500">เข้าใช้งานได้ทีละสาขา</p>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(branches ?? []).map((branch) => (
            <button
              key={branch.id}
              type="button"
              onClick={() => setBranchId(branch.id)}
              className="btn h-24 flex-col gap-1 bg-white shadow-sm ring-1 ring-slate-200
                hover:bg-brand-50"
            >
              <span className="text-lg font-semibold">{branch.name}</span>
              <span className="text-sm text-slate-500">{branch.branchCode}</span>
            </button>
          ))}
        </div>
      </CenteredCard>
    );
  }

  if (loadError) {
    return (
      <CenteredCard>
        <h1 className="text-2xl font-bold">เชื่อมต่อเซิร์ฟเวอร์ไม่ได้</h1>
        <p className="mt-2 text-slate-500">{loadError}</p>
        <p className="mt-4 text-sm text-slate-400">
          ตรวจว่า API ทำงานอยู่ (<code>pnpm dev:api</code>) และฐานข้อมูลถูก seed แล้ว
        </p>
      </CenteredCard>
    );
  }

  if (!staff) {
    return (
      <CenteredCard>
        <p className="text-slate-400">กำลังโหลด…</p>
      </CenteredCard>
    );
  }

  if (!selected) {
    return (
      <CenteredCard wide>
        <div className="flex items-baseline justify-between">
          <p className="text-slate-500">{branchName}</p>
          {branches && branches.length > 1 ? (
            <button
              type="button"
              onClick={() => {
                setBranchId(undefined);
                setStaff(null);
              }}
              className="btn h-11 px-0 text-slate-500 hover:text-slate-900"
            >
              เปลี่ยนสาขา
            </button>
          ) : null}
        </div>
        <h1 className="mt-1 text-3xl font-bold">เลือกชื่อของคุณ</h1>
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {staff.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => {
                setSelected(person);
                setPin('');
                setError(null);
              }}
              className="btn h-24 flex-col gap-1 bg-white shadow-sm ring-1 ring-slate-200
                hover:bg-brand-50"
            >
              <span className="text-lg font-semibold">{person.nickname ?? person.fullName}</span>
              <span className="text-sm text-slate-500">{ROLE_LABEL[person.role]}</span>
            </button>
          ))}
        </div>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <button
        type="button"
        onClick={() => {
          setSelected(null);
          setPin('');
          setError(null);
        }}
        className="btn h-11 self-start px-0 text-slate-500 hover:text-slate-900"
      >
        ← เปลี่ยนชื่อ
      </button>

      <h1 className="mt-2 text-2xl font-bold">{selected.nickname ?? selected.fullName}</h1>
      <p className="text-slate-500">ใส่ PIN 4 หลัก</p>

      <div className="mt-6 flex justify-center gap-4">
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <span
            key={index}
            data-testid="pin-dot"
            data-filled={index < pin.length}
            className={`h-5 w-5 rounded-full ${
              index < pin.length ? 'bg-brand-600' : 'bg-slate-200'
            }`}
          />
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-center text-red-900">
          {error}
        </p>
      ) : null}

      <div className="mt-6">
        <Keypad
          onDigit={pressDigit}
          onBackspace={() => setPin((current) => current.slice(0, -1))}
          onClear={() => setPin('')}
          disabled={busy}
        />
      </div>
    </CenteredCard>
  );
}

function CenteredCard({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}): React.ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div
        className={`flex w-full flex-col rounded-3xl bg-white p-8 shadow-lg ${
          wide ? 'max-w-3xl' : 'max-w-md'
        }`}
      >
        {children}
      </div>
    </div>
  );
}
