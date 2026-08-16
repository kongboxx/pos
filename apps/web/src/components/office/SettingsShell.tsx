/**
 * The frame around the owner's two branch screens (Step 10).
 *
 * Separate from ReportShell because the audience is different, not because
 * the layout is. "เงินเข้า–เงินออก" is read every night by whoever is closing;
 * this is opened a handful of times a year by the person who owns the shops,
 * and one of its two screens can turn VAT on for a whole branch. Those do not
 * belong one mis-tap apart.
 */

import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Permission } from '@pos/shared';
import { useSession } from '../../session-store.js';
import { path } from '@pos/web-kit';

const TABS = [
  { to: path.settingsBranches, label: 'ตั้งค่าสาขา', permission: Permission.MANAGE_BRANCH },
  {
    to: path.settingsAllBranches,
    label: 'ยอดขายทุกสาขา',
    permission: Permission.VIEW_ALL_BRANCHES,
  },
] as const;

interface SettingsShellProps {
  children: React.ReactNode;
  controls?: React.ReactNode;
  error?: string | null;
  loading?: boolean;
}

export function SettingsShell({
  children,
  controls,
  error,
  loading = false,
}: SettingsShellProps): React.ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const can = useSession((state) => state.can);

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">สาขา</h1>
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
          {TABS.filter((tab) => can(tab.permission)).map((tab) => (
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
