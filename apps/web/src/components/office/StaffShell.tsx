/**
 * The frame around the three people screens (Step 9).
 *
 * A third shell rather than more tabs on the money one, because this is the
 * only part of the app where every number on screen is somebody's private
 * business. Keeping it behind its own door means a manager reading the daily
 * report at the counter cannot wander one tab sideways into what the cook earns.
 */

import { Link, useLocation, useNavigate } from 'react-router-dom';
import { path } from '../../routes.js';
import {
  DOCUMENT_WARNING_DAYS,
  documentExpiryState,
  formatSatang,
  type DocumentExpiryState,
} from '@pos/shared';

const TABS = [
  { to: path.staffPeople, label: 'พนักงาน' },
  { to: path.staffDeductions, label: 'หักเงิน' },
  { to: path.staffPayroll, label: 'เงินเดือน' },
] as const;

interface StaffShellProps {
  children: React.ReactNode;
  controls?: React.ReactNode;
  error?: string | null;
  notice?: string | null;
  loading?: boolean;
}

export function StaffShell({
  children,
  controls,
  error,
  notice,
  loading = false,
}: StaffShellProps): React.ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white px-6 py-3 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">พนักงานและเงินเดือน</h1>
          <div className="flex items-center gap-3">
            {controls}
            <button
              type="button"
              onClick={() => navigate(path.tables)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              ← กลับไปหน้าโต๊ะ
            </button>
          </div>
        </div>
        <nav className="mt-3 flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={pathname === tab.to ? 'page' : undefined}
              className={`btn h-12 px-6 ${
                pathname === tab.to
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>

      {error ? (
        <p role="alert" className="mx-6 mt-4 rounded-xl bg-red-50 p-4 text-red-900 print:hidden">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="mx-6 mt-4 rounded-xl bg-emerald-50 p-4 text-emerald-900 print:hidden"
        >
          {notice}
        </p>
      ) : null}

      <main className="p-6">
        {loading ? <p className="mb-4 text-slate-400 print:hidden">กำลังโหลด…</p> : null}
        {children}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A work permit or passport that is about to become the shop's problem.
 *
 * Rendered as words rather than a colour alone: the person reading this may be
 * doing it on a tablet in daylight, and "หมดอายุแล้ว" has to survive a screen
 * nobody can see the tint of.
 */
export function ExpiryBadge({
  label,
  expiry,
  today,
}: {
  label: string;
  expiry: string | null;
  today: string;
}): React.ReactElement | null {
  const state = documentExpiryState(expiry, today);
  if (state === 'NONE' || state === 'OK') return null;

  const text: Record<Exclude<DocumentExpiryState, 'NONE' | 'OK'>, string> = {
    EXPIRED: `${label}หมดอายุแล้ว (${expiry})`,
    EXPIRING: `${label}จะหมดอายุ ${expiry}`,
  };

  return (
    <span
      className={`rounded-lg px-2 py-1 text-sm font-semibold ${
        state === 'EXPIRED' ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-900'
      }`}
    >
      {state === 'EXPIRED' ? '⚠ ' : ''}
      {text[state]}
    </span>
  );
}

/** Shown once above the list so the warning is not only per-row. */
export function expiryWarningText(count: number): string {
  return `มีเอกสารที่หมดอายุแล้วหรือจะหมดใน ${DOCUMENT_WARNING_DAYS} วัน ${count} รายการ — ต่ออายุก่อนถึงกำหนด`;
}

/** A money figure, right-aligned and tabular, used all over these screens. */
export function Money({ satang }: { satang: number }): React.ReactElement {
  return <span className="tnum">{formatSatang(satang)}</span>;
}
