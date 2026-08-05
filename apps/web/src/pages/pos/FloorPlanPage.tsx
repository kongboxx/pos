/**
 * The floor plan — the screen the shop lives on.
 *
 * A table is either free or has a bill on it, and the difference must be
 * readable from across the room: colour plus the amount, not an icon. Tapping
 * a free table opens a bill and goes straight to ordering; tapping a busy one
 * opens the bill that is already there.
 *
 * Since Step 4 the whole screen works with the wifi off. The table list is
 * whatever the server last said (kept on the device), and any bill this tablet
 * opened while offline is drawn on top of it — otherwise the cashier would tap
 * the table they just seated and be told it is free.
 *
 * A bill opened offline has NO BILL NUMBER, and the card says so rather than
 * inventing one. Two tablets offline at once cannot agree on who gets 004, and
 * a duplicate document number is worse than a missing one (rule #9).
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { billsOnTable, formatSatang, Permission, type OrderDto, type TableDto } from '@pos/shared';
import { api } from '../../api-client.js';
import { BillPicker } from '../../components/BillMoveDialog.js';
import { onLiveEvent } from '../../live-store.js';
import { onOrdersChanged } from '../../offline/db.js';
import {
  openBill,
  readFloorPlan,
  readMenu,
  readUnsyncedTakeaway,
} from '../../offline/repository.js';
import { useSync } from '../../offline/sync-store.js';
import { useSession } from '../../session-store.js';
import { path } from '../../routes.js';

/** A takeaway bill has no table to sit on, so it needs its own row. */
interface TakeawayCard {
  id: string;
  orderNo: string | null;
  totalSatang: number;
  lineCount: number;
}

export function FloorPlanPage(): React.ReactElement {
  const navigate = useNavigate();
  const branch = useSession((state) => state.branch);
  const user = useSession((state) => state.user);
  const logout = useSession((state) => state.logout);
  const canManageMenu = useSession((state) => state.can(Permission.MANAGE_MENU));
  const canApproveQr = useSession((state) => state.can(Permission.APPROVE_QR_ORDER));
  const canViewReports = useSession((state) => state.can(Permission.VIEW_REPORTS));
  const canViewPayroll = useSession((state) => state.can(Permission.VIEW_PAYROLL));
  const canTakePayment = useSession((state) => state.can(Permission.TAKE_PAYMENT));
  const canManageBranch = useSession((state) => state.can(Permission.MANAGE_BRANCH));
  const online = useSync((state) => state.online);

  const [tables, setTables] = useState<TableDto[] | null>(null);
  const [takeaway, setTakeaway] = useState<TakeawayCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyTableId, setBusyTableId] = useState<string | null>(null);
  /** A table carrying more than one bill, waiting for the cashier to say which. */
  const [choosing, setChoosing] = useState<TableDto | null>(null);

  const load = useCallback(async () => {
    const [floor, localTakeaway, openOrders] = await Promise.all([
      readFloorPlan(),
      readUnsyncedTakeaway(),
      api.openOrders(),
    ]);

    setTables(floor.tables);
    setTakeaway(mergeTakeaway(openOrders.ok ? openOrders.data.orders : [], localTakeaway));
    // Falling back to the cached floor plan is normal, not an error worth
    // shouting about — the sync bar already says the connection is down.
    if (!floor.fromCache) setError(null);
  }, []);

  useEffect(() => {
    // Pull the menu onto the device as soon as the shop opens this screen,
    // not lazily when someone first taps a table.
    //
    // Without this, a tablet that boots, shows the floor plan, and THEN loses
    // the wifi has prices for nothing and cannot take a single order — and the
    // failure would arrive at the worst moment, with a customer already
    // waiting. This is the one request that has to happen while it still can.
    void readMenu();
  }, []);

  useEffect(() => {
    void load();
    // Another tablet may open a bill on the same table. 5s is often enough to
    // notice without hammering the API; a websocket push arrives with the
    // kitchen screen in Step 5.
    const timer = setInterval(() => void load(), 5000);
    // A background sync that adopts the server's version of a bill has to be
    // able to redraw this screen too.
    const unsubscribe = onOrdersChanged(() => void load());
    // A customer pressing send on their phone has to light the badge up here
    // NOW, not on the next 5s tick: the count on this screen is the only thing
    // between them and three minutes of staring at "รอพนักงานยืนยัน".
    const unsubscribeLive = onLiveEvent((event) => {
      // 'tables' is a bill moving, merging or splitting on another tablet. The
      // 5s tick would catch it eventually, but "eventually" here means seating
      // someone at a table the screen still shows as taken.
      if (event.type === 'qr' || event.type === 'tables') void load();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
      unsubscribeLive();
    };
  }, [load]);

  const openTable = useCallback(
    async (table: TableDto) => {
      const bills = billsOnTable(table);
      // More than one only happens after แยกบิล, and only then is it worth a
      // tap to ask which. One bill goes straight through, because that tap
      // would otherwise sit between the cashier and every order of the day.
      if (bills.length > 1) {
        setChoosing(table);
        return;
      }
      if (bills[0]) {
        navigate(path.order(bills[0].id));
        return;
      }
      setBusyTableId(table.id);
      const result = await openBill({
        tableId: table.id,
        tableName: table.name,
        channel: 'DINE_IN',
      });
      setBusyTableId(null);
      if (result.ok) navigate(path.order(result.value));
      else setError(result.error);
    },
    [navigate],
  );

  const openTakeaway = useCallback(async () => {
    setBusyTableId('takeaway');
    const result = await openBill({ tableId: null, tableName: null, channel: 'TAKEAWAY' });
    setBusyTableId(null);
    if (result.ok) navigate(path.order(result.value));
    else setError(result.error);
  }, [navigate]);

  const signOut = useCallback(async () => {
    const result = await logout();
    if (!result.ok) setError(result.error);
  }, [logout]);

  const zones = groupByZone(tables ?? []);
  const pendingApprovalCount = (tables ?? []).reduce(
    // `?? 0` and not a required field: a tablet drawing from a floor plan it
    // cached before Step 7 has no such number, and "this device does not know"
    // must not read as "nobody is waiting".
    (sum, table) => sum + (table.pendingApprovalCount ?? 0),
    0,
  );

  return (
    <div className="min-h-full bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div>
          <h1 className="text-xl font-bold">{branch?.name ?? 'ผังโต๊ะ'}</h1>
          <p className="text-sm text-slate-500">{user?.nickname ?? user?.fullName}</p>
        </div>
        <div className="flex gap-3">
          {/* Only when somebody is actually waiting. A permanent "รออนุมัติ 0"
              is a button staff stop reading within a day, and then the one time
              it says 2 nobody notices. */}
          {canApproveQr && pendingApprovalCount > 0 ? (
            <button
              type="button"
              onClick={() => navigate(path.approvals)}
              className="btn h-12 animate-none bg-amber-500 px-6 text-lg font-bold text-white
                hover:bg-amber-400"
            >
              รอยืนยัน {pendingApprovalCount} รายการ
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void openTakeaway()}
            disabled={busyTableId !== null}
            className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500 disabled:opacity-50"
          >
            + บิลกลับบ้าน
          </button>
          {/* The kitchen screen normally lives on its own device, but it has to
              be reachable from here too — that is how it gets opened the first
              time, and how anyone checks what the kitchen is seeing. */}
          <button
            type="button"
            onClick={() => navigate(path.kitchen)}
            className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
          >
            จอครัว
          </button>
          {/* Only for roles that may actually change the menu. A cashier who
              can see the button but not the screen learns to distrust the
              buttons. */}
          {canManageMenu ? (
            <button
              type="button"
              onClick={() => navigate(path.menu)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              จัดการเมนู
            </button>
          ) : null}
          {/* Step 10, and next to the till buttons rather than with the owner's
              screens: this is where a cashier goes when a customer who has
              already paid comes back and asks for a tax invoice. */}
          {canTakePayment ? (
            <button
              type="button"
              onClick={() => navigate(path.bills)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              บิลที่ปิดแล้ว
            </button>
          ) : null}
          {/* Next to บิลที่ปิดแล้ว because both are till errands, and reachable
              by the cashier for the same reason: whoever works the drawer is
              whoever counts it. */}
          {canTakePayment ? (
            <button
              type="button"
              onClick={() => navigate(path.shift)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              เปิด-ปิดกะ
            </button>
          ) : null}
          {/* The closing report (Step 8). Same rule as จัดการเมนู above: shown
              only to roles that can actually open it. */}
          {canViewReports ? (
            <button
              type="button"
              onClick={() => navigate(path.reportDaily)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              ปิดวัน
            </button>
          ) : null}
          {/* Step 9. Owner only, and further along the row than ปิดวัน on
              purpose: this is a once-a-month errand, not a nightly one. */}
          {canViewPayroll ? (
            <button
              type="button"
              onClick={() => navigate(path.staffPeople)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              พนักงาน
            </button>
          ) : null}
          {/* Step 10. Last in the row, because a shop opens a branch or
              registers for VAT a handful of times ever. */}
          {canManageBranch ? (
            <button
              type="button"
              onClick={() => navigate(path.settingsBranches)}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              สาขา
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void signOut()}
            className="btn h-12 bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            ออกจากระบบ
          </button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mx-6 mt-4 rounded-xl bg-red-50 p-4 text-red-900">
          {error}
        </p>
      ) : null}

      <main className="p-6">
        {takeaway.length > 0 ? (
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold text-slate-600">บิลกลับบ้านที่ยังไม่ปิด</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {takeaway.map((bill) => (
                <button
                  key={bill.id}
                  type="button"
                  onClick={() => navigate(path.order(bill.id))}
                  className="btn h-32 flex-col gap-1 border-2 border-brand-500 bg-brand-50 text-left"
                >
                  <span className="tnum text-lg font-bold">{bill.orderNo ?? 'รอเลขบิล'}</span>
                  <span className="tnum text-xl font-semibold text-brand-900">
                    {formatSatang(bill.totalSatang)}
                  </span>
                  <span className="text-sm text-slate-600">{bill.lineCount} รายการ</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {tables === null ? (
          <p className="text-slate-400">กำลังโหลด…</p>
        ) : tables.length === 0 ? (
          <p className="text-slate-400">
            {online
              ? 'ยังไม่มีโต๊ะในระบบ'
              : 'เครื่องนี้ยังไม่เคยโหลดผังโต๊ะ — ต้องต่อเน็ตสักครั้งก่อน'}
          </p>
        ) : (
          zones.map(([zone, zoneTables]) => (
            <section key={zone} className="mb-8">
              <h2 className="mb-3 text-lg font-semibold text-slate-600">{zone}</h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {zoneTables.map((table) => (
                  <TableCard
                    key={table.id}
                    table={table}
                    busy={busyTableId === table.id}
                    onOpen={() => void openTable(table)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </main>

      {choosing ? (
        <BillPicker
          tableName={choosing.name}
          bills={billsOnTable(choosing)}
          onPick={(orderId) => navigate(path.order(orderId))}
          onClose={() => setChoosing(null)}
        />
      ) : null}
    </div>
  );
}

function TableCard({
  table,
  busy,
  onOpen,
}: {
  table: TableDto;
  busy: boolean;
  onOpen: () => void;
}): React.ReactElement {
  const bills = billsOnTable(table);
  const occupied = bills.length > 0;
  const waiting = table.pendingApprovalCount ?? 0;
  // What the table owes altogether. With one bill this is that bill; with two
  // it is what the shop is still waiting to be paid for this table, which is
  // the number a manager glancing across the room actually wants.
  const totalSatang = bills.reduce((sum, bill) => sum + bill.totalSatang, 0);
  const lineCount = bills.reduce((sum, bill) => sum + bill.lineCount, 0);
  const oldest = bills[0];

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      className={`btn h-32 flex-col gap-1 border-2 text-left disabled:opacity-50 ${
        waiting > 0
          ? 'border-amber-500 bg-amber-100 hover:bg-amber-200'
          : occupied
            ? 'border-amber-400 bg-amber-50 hover:bg-amber-100'
            : 'border-slate-200 bg-white hover:bg-slate-50'
      }`}
    >
      <span className="text-2xl font-bold">{table.name}</span>
      {waiting > 0 ? (
        <span className="rounded-lg bg-amber-600 px-2 py-0.5 text-sm font-bold text-white">
          รอยืนยัน {waiting}
        </span>
      ) : null}
      {occupied && oldest ? (
        <>
          <span className="tnum text-xl font-semibold text-amber-900">
            {formatSatang(totalSatang)}
          </span>
          <span className="text-sm text-amber-700">
            {lineCount} รายการ · {minutesSince(oldest.openedAt)} นาที
          </span>
          {/* Said out loud, because the total above is now a sum of two bills
              and the cashier is about to be asked which one to open. */}
          {bills.length > 1 ? (
            <span className="rounded-lg bg-amber-600 px-2 py-0.5 text-sm font-bold text-white">
              แยก {bills.length} บิล
            </span>
          ) : null}
          {bills.some((bill) => bill.orderNo === null) ? (
            <span className="text-sm text-amber-700">รอเลขบิล</span>
          ) : null}
        </>
      ) : (
        <span className="text-sm text-slate-400">ว่าง · {table.seats} ที่นั่ง</span>
      )}
    </button>
  );
}

/**
 * Server-known takeaway bills plus the ones only this device knows about.
 *
 * Keyed by id so a bill that has just synced appears once, not twice — the id
 * is the tablet's from the start (rule #6), which is what makes the two lists
 * mergeable at all.
 */
export function mergeTakeaway(
  serverOrders: readonly OrderDto[],
  localOrders: readonly OrderDto[],
): TakeawayCard[] {
  const cards = new Map<string, TakeawayCard>();
  for (const order of [...serverOrders, ...localOrders]) {
    if (order.tableId !== null || order.status !== 'OPEN') continue;
    cards.set(order.id, {
      id: order.id,
      orderNo: order.orderNo,
      totalSatang: order.totalSatang,
      lineCount: order.lines.length,
    });
  }
  return [...cards.values()];
}

function groupByZone(tables: readonly TableDto[]): [string, TableDto[]][] {
  const groups = new Map<string, TableDto[]>();
  for (const table of tables) {
    const zone = table.zone ?? 'ไม่ระบุโซน';
    const list = groups.get(zone);
    if (list) list.push(table);
    else groups.set(zone, [table]);
  }
  return [...groups.entries()];
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
