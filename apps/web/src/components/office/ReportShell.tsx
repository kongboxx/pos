/**
 * The frame around the four money screens (Step 8).
 *
 * Separate from ManageShell rather than a fifth tab on it, because these are
 * two different jobs done at two different times: the menu is priced once a
 * week from a chair, the takings are read every night after close. Putting
 * "ยกเลิกรายการ" next to "ลบเมนู" would also mean one careless tap away from
 * the destructive screen while holding the day's cash.
 *
 * `useBusinessToday` used to live here. It moved to business-day.ts once the
 * paid-bills screen went to the till side: a till screen must not import a
 * back-office layout just to learn what day it is.
 */

import { Link, useLocation, useNavigate } from 'react-router-dom';
import { path } from '../../routes.js';

const TABS = [
  { to: path.reportDaily, label: 'สรุปวัน' },
  { to: path.reportExpenses, label: 'รายจ่าย' },
  { to: path.reportPnl, label: 'กำไรขาดทุน' },
  { to: path.reportVoids, label: 'ของที่ยกเลิก' },
] as const;

interface ReportShellProps {
  children: React.ReactNode;
  /** Rendered on the right of the header — a date or month picker. */
  controls?: React.ReactNode;
  error?: string | null;
  loading?: boolean;
}

export function ReportShell({
  children,
  controls,
  error,
  loading = false,
}: ReportShellProps): React.ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">เงินเข้า–เงินออก</h1>
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
        <p role="alert" className="mx-6 mt-4 rounded-xl bg-red-50 p-4 text-red-900">
          {error}
        </p>
      ) : null}

      <main className="p-6">
        {loading ? <p className="mb-4 text-slate-400">กำลังโหลด…</p> : null}
        {children}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shared bits of layout                                               */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-2xl bg-white p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * One line of a statement.
 *
 * `tone` carries the only colour on these screens and it means one thing:
 * whether the number is good or bad for the shop. Nothing else here is red or
 * green, so a red figure is never something to be scanned past.
 */
export function Row({
  label,
  value,
  hint,
  tone = 'plain',
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad' | 'muted';
  strong?: boolean;
}): React.ReactElement {
  const valueTone =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-red-700'
        : tone === 'muted'
          ? 'text-slate-400'
          : 'text-slate-900';

  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1.5 ${
        strong ? 'border-t border-slate-200 pt-3 font-bold' : ''
      }`}
    >
      <span className={strong ? 'text-lg' : 'text-slate-600'}>
        {label}
        {hint ? <span className="ml-2 text-sm text-slate-400">{hint}</span> : null}
      </span>
      <span className={`tnum whitespace-nowrap ${strong ? 'text-xl' : 'text-lg'} ${valueTone}`}>
        {value}
      </span>
    </div>
  );
}

/** Renders basis points as a percentage: 3512 -> "35.1%". */
export function formatBp(bp: number | null): string {
  if (bp === null) return '—';
  return `${(bp / 100).toFixed(1)}%`;
}
