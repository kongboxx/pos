/**
 * Step 0 smoke screen.
 *
 * Proves the whole chain is wired: PWA shell renders, the shared package's
 * money/VAT/businessDate code runs in the browser, and the API + Postgres
 * answer. Kept as a diagnostics tab — it is the first place to look when
 * something on the counter stops working.
 */

import { useEffect, useState } from 'react';
import {
  calculateOrderTotal,
  formatSatang,
  toBusinessDate,
  VAT_RATE_BP_7,
  type DbHealthResponse,
} from '@pos/shared';
import { api } from './api-client.js';

type Connection =
  | { state: 'checking' }
  | { state: 'online'; db: DbHealthResponse }
  | { state: 'offline'; reason: string };

export function StatusPage(): React.ReactElement {
  const [connection, setConnection] = useState<Connection>({ state: 'checking' });

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      const result = await api.dbHealth();
      if (cancelled) return;
      setConnection(
        result.ok
          ? { state: 'online', db: result.data }
          : { state: 'offline', reason: result.error },
      );
    };

    void check();
    const timer = setInterval(() => void check(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Runs the real shared code so a broken build shows up here, not in Step 2.
  const demo = calculateOrderTotal(
    [
      {
        nameSnapshot: 'ก๋วยเตี๋ยวหมู',
        qty: 2,
        unitPriceSatang: 5000,
        unitCostSatang: 1800,
        modifiers: [{ nameSnapshot: 'พิเศษ', priceDeltaSatang: 1000, costDeltaSatang: 450 }],
      },
      { nameSnapshot: 'น้ำเปล่า', qty: 1, unitPriceSatang: 1000, unitCostSatang: 500 },
    ],
    { enabled: false, rateBp: VAT_RATE_BP_7, priceIncludesVat: true },
  );

  const businessDate = toBusinessDate(new Date(), {
    timezone: 'Asia/Bangkok',
    dayCutoffHour: 4,
  });

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-3xl font-bold">สถานะระบบ</h1>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">การเชื่อมต่อ</h2>
        <ConnectionStatus connection={connection} />
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">ตรวจสอบโค้ดที่ใช้ร่วมกัน</h2>
        <dl className="mt-3 space-y-2 text-slate-700">
          <Row label="วันขาย (business date)" value={businessDate} />
          <Row label="ยอดรวมตัวอย่าง" value={`${formatSatang(demo.totalSatang)} บาท`} />
          <Row label="ต้นทุน" value={`${formatSatang(demo.costSatang)} บาท`} />
          <Row label="VAT" value={`${formatSatang(demo.vatAmountSatang)} บาท (ยังไม่จด VAT)`} />
        </dl>
      </section>

      <p className="mt-6 text-sm text-slate-400">
        หน้าจอจริง — ผังโต๊ะ รับออร์เดอร์ จอครัว — อยู่ใน Step 2 เป็นต้นไป
      </p>
    </main>
  );
}

function ConnectionStatus({ connection }: { connection: Connection }): React.ReactElement {
  if (connection.state === 'checking') {
    return <p className="mt-3 text-slate-500">กำลังตรวจสอบ…</p>;
  }

  if (connection.state === 'offline') {
    return (
      <div className="mt-3 rounded-xl bg-amber-50 p-4 text-amber-900">
        <p className="font-medium">ออฟไลน์ — ต่อ API ไม่ได้</p>
        <p className="mt-1 text-sm">{connection.reason}</p>
        <p className="mt-2 text-sm">
          ตรวจว่ารัน <code className="rounded bg-amber-100 px-1">pnpm db:up</code> และ{' '}
          <code className="rounded bg-amber-100 px-1">pnpm dev:api</code> แล้วหรือยัง
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl bg-emerald-50 p-4 text-emerald-900">
      <p className="font-medium">ออนไลน์ — ต่อฐานข้อมูลได้</p>
      <p className="mt-1 text-sm tnum">
        ตอบกลับใน {connection.db.latencyMs} มิลลิวินาที · มี {connection.db.branchCount ?? 0} สาขา
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between border-b border-slate-100 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium tnum">{value}</dd>
    </div>
  );
}
