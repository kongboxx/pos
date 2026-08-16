/**
 * The frame around the three management screens.
 *
 * Dishes, options and ingredients are one job split across three tabs, so the
 * tabs live here rather than each page growing its own header — and so the
 * error and the "คิดต้นทุนใหม่ให้ 9 เมนูแล้ว" notice appear in the same place
 * whichever screen produced them.
 */

import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useManage } from '../../manage-store.js';
import { path } from '@pos/web-kit';

const TABS = [
  { to: path.menu, label: 'เมนู' },
  { to: path.options, label: 'ตัวเลือก' },
  { to: path.ingredients, label: 'วัตถุดิบ' },
  { to: path.manageTables, label: 'โต๊ะ & QR' },
] as const;

export function ManageShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const error = useManage((state) => state.error);
  const notice = useManage((state) => state.notice);
  const dismiss = useManage((state) => state.dismiss);

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">จัดการร้าน</h1>
          <button
            type="button"
            onClick={() => navigate(path.tables)}
            className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
          >
            ← กลับไปหน้าโต๊ะ
          </button>
        </div>
        <nav className="mt-3 flex gap-2">
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
        <p role="alert" className="mx-6 mt-4 flex gap-4 rounded-xl bg-red-50 p-4 text-red-900">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={dismiss} className="font-semibold underline">
            ปิด
          </button>
        </p>
      ) : null}

      {notice ? (
        <p role="status" className="mx-6 mt-4 rounded-xl bg-emerald-50 p-4 text-emerald-900">
          {notice}
        </p>
      ) : null}

      <main className="p-6">{children}</main>
    </div>
  );
}
