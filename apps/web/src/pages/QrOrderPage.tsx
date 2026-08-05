/**
 * The page behind the sticker on the table (Step 7).
 *
 * The brief's rule for this screen is thirty seconds: scan, find the bowl,
 * send. Everything here is shaped by that and by the fact that the person
 * holding the phone has never seen this app before and will not read anything.
 *
 * So:
 *  - No login, no account, no name, no table number to type. The sticker
 *    already said which table this is.
 *  - Tapping a dish with no options ADDS IT. One tap. The options sheet only
 *    appears for something that genuinely cannot be ordered without a choice.
 *  - The cart is a bar at the bottom that is always visible once it has
 *    anything in it, because a cart you have to go and find is a cart people
 *    abandon.
 *  - "ส่งออร์เดอร์" says รอพนักงานยืนยัน afterwards, in those words. The
 *    single worst thing this screen could do is imply the food is on its way
 *    when no member of staff has looked at it yet — that customer waits twenty
 *    minutes and then complains about the kitchen.
 *
 * NOT OFFLINE, unlike every staff screen. A customer's phone cannot queue an
 * order for later: it would tell them the food was ordered while the request
 * sat in a browser nobody would open again. If the connection is down the page
 * says so and asks them to call a member of staff, which is the true answer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  defaultSelectionFor,
  formatModifierSummary,
  formatSatang,
  lineSignature,
  QR_LINE_STATUS_LABEL,
  selectedModifiersOf,
  selectionPriceDeltaSatang,
  type MenuItemDto,
  type ModifierGroupDto,
  type QrBillDto,
  type QrTableResponse,
} from '@pos/shared';
import { api } from '../api-client.js';
import { ModifierSheet } from '../components/ModifierSheet.js';

/** How often the page re-reads the bill while it is open. */
const POLL_MS = 8000;

interface CartLine {
  /** Generated here (rule #6) — what makes a double-tapped send harmless. */
  id: string;
  menuItemId: string;
  name: string;
  qty: number;
  modifierIds: string[];
  unitPriceSatang: number;
  optionsSummary: string;
}

export function QrOrderPage(): React.ReactElement {
  const { token = '' } = useParams();

  const [view, setView] = useState<QrTableResponse | null>(null);
  const [bill, setBill] = useState<QrBillDto | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [choosing, setChoosing] = useState<MenuItemDto | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const groupsById = useMemo(() => {
    const map = new Map<string, ModifierGroupDto>();
    for (const group of view?.menu.modifierGroups ?? []) map.set(group.id, group);
    return map;
  }, [view]);

  const groupsFor = useCallback(
    (item: MenuItemDto): ModifierGroupDto[] =>
      item.groupIds.map((id) => groupsById.get(id)).filter((g): g is ModifierGroupDto => !!g),
    [groupsById],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.qrTable(token);
      if (cancelled) return;
      if (result.ok) {
        setView(result.data);
        setBill(result.data.bill);
        setCategoryId(result.data.menu.categories[0]?.id ?? null);
        setError(null);
      } else {
        setError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Polling, not a socket: the live feed is authenticated by a staff session
  // and a customer has none. Eight seconds is how long "รอพนักงานยืนยัน" may
  // stay on screen after somebody has already pressed the button.
  useEffect(() => {
    if (!view) return;
    const timer = setInterval(() => {
      void api.qrBill(token).then((result) => {
        if (result.ok) setBill(result.data.bill);
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [token, view]);

  const addToCart = useCallback(
    (item: MenuItemDto, modifierIds: string[], qty: number) => {
      const groups = groupsFor(item);
      const unitPriceSatang = item.priceSatang + selectionPriceDeltaSatang(groups, modifierIds);
      const optionsSummary = formatModifierSummary(
        selectedModifiersOf(groups, modifierIds).map((modifier) => modifier.name),
      );
      const signature = lineSignature(item.id, modifierIds);

      setSent(false);
      setCart((current) => {
        const existing = current.find(
          (line) => lineSignature(line.menuItemId, line.modifierIds) === signature,
        );
        if (existing) {
          return current.map((line) =>
            line === existing ? { ...line, qty: Math.min(99, line.qty + qty) } : line,
          );
        }
        return [
          ...current,
          {
            id: crypto.randomUUID(),
            menuItemId: item.id,
            name: item.name,
            qty,
            modifierIds,
            unitPriceSatang,
            optionsSummary,
          },
        ];
      });
    },
    [groupsFor],
  );

  const tapItem = useCallback(
    (item: MenuItemDto) => {
      if (!item.isAvailable) return;
      const groups = groupsFor(item);
      // One tap for a drink; the sheet only for something that needs a choice.
      if (groups.length === 0) addToCart(item, [], 1);
      else setChoosing(item);
    },
    [addToCart, groupsFor],
  );

  const changeQty = useCallback((id: string, delta: number) => {
    setCart((current) =>
      current
        .map((line) => (line.id === id ? { ...line, qty: line.qty + delta } : line))
        .filter((line) => line.qty > 0),
    );
  }, []);

  const send = useCallback(async () => {
    if (cart.length === 0) return;
    setSending(true);
    setError(null);

    const result = await api.qrSubmit(token, {
      lines: cart.map((line) => ({
        id: line.id,
        menuItemId: line.menuItemId,
        qty: line.qty,
        modifierIds: line.modifierIds,
        // No note box on the customer's phone — see the header of
        // ModifierSheet for why that is a decision and not an oversight.
        note: null,
      })),
    });

    setSending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBill(result.data.bill);
    setCart([]);
    setCartOpen(false);
    setSent(true);
  }, [cart, token]);

  const cartTotalSatang = cart.reduce((sum, line) => sum + line.unitPriceSatang * line.qty, 0);
  const cartCount = cart.reduce((sum, line) => sum + line.qty, 0);

  if (!view) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6 text-center">
        {error ? (
          <p role="alert" className="text-lg text-slate-700">
            {error}
          </p>
        ) : (
          <p className="text-slate-400">กำลังโหลดเมนู…</p>
        )}
      </main>
    );
  }

  const category =
    view.menu.categories.find((row) => row.id === categoryId) ?? view.menu.categories[0];

  return (
    <div className="min-h-screen bg-slate-100 pb-28">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-bold">{view.shopName}</h1>
        <p className="text-sm text-slate-500">โต๊ะ {view.tableName}</p>
      </header>

      {!view.orderingEnabled ? (
        <p role="alert" className="m-4 rounded-xl bg-amber-50 p-4 text-amber-900">
          ตอนนี้ร้านปิดรับออร์เดอร์ผ่าน QR — ดูเมนูได้ แต่กรุณาสั่งกับพนักงาน
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="m-4 rounded-xl bg-red-50 p-4 text-red-900">
          {error}
        </p>
      ) : null}

      {sent ? (
        <p role="status" className="m-4 rounded-xl bg-emerald-50 p-4 text-emerald-900">
          ส่งให้พนักงานแล้ว รอพนักงานยืนยันสักครู่
        </p>
      ) : null}

      {bill && bill.lines.length > 0 ? <BillPanel bill={bill} /> : null}

      <nav className="flex gap-2 overflow-x-auto px-4 py-3">
        {view.menu.categories.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setCategoryId(row.id)}
            aria-current={row.id === category?.id ? 'true' : undefined}
            className={`btn h-12 shrink-0 px-5 ${
              row.id === category?.id ? 'bg-brand-600 text-white' : 'bg-white text-slate-700'
            }`}
          >
            {row.name}
          </button>
        ))}
      </nav>

      <main className="grid grid-cols-2 gap-3 px-4">
        {(category?.items ?? []).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => tapItem(item)}
            disabled={!item.isAvailable || !view.orderingEnabled}
            className="btn h-24 flex-col items-start gap-1 bg-white px-4 text-left
              disabled:opacity-40"
          >
            <span className="line-clamp-2 font-semibold">{item.name}</span>
            <span className="tnum text-slate-600">{formatSatang(item.priceSatang)}</span>
            {!item.isAvailable ? <span className="text-sm text-red-700">หมดแล้ว</span> : null}
          </button>
        ))}
      </main>

      {choosing ? (
        <ModifierSheet
          itemName={choosing.name}
          basePriceSatang={choosing.priceSatang}
          groups={groupsFor(choosing)}
          initialSelection={defaultSelectionFor(groupsFor(choosing))}
          initialQty={1}
          mode="add"
          onCancel={() => setChoosing(null)}
          onConfirm={(modifierIds, qty) => {
            addToCart(choosing, modifierIds, qty);
            setChoosing(null);
          }}
        />
      ) : null}

      {cart.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white">
          {cartOpen ? (
            <ul className="max-h-64 overflow-y-auto px-4 py-2">
              {cart.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center gap-3 border-b border-slate-100 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{line.name}</p>
                    {line.optionsSummary ? (
                      <p className="truncate text-sm text-slate-500">{line.optionsSummary}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={`ลด ${line.name}`}
                    onClick={() => changeQty(line.id, -1)}
                    className="btn h-11 w-11 bg-slate-100 text-xl"
                  >
                    −
                  </button>
                  <span className="tnum w-8 text-center font-bold">{line.qty}</span>
                  <button
                    type="button"
                    aria-label={`เพิ่ม ${line.name}`}
                    onClick={() => changeQty(line.id, 1)}
                    className="btn h-11 w-11 bg-slate-100 text-xl"
                  >
                    +
                  </button>
                  <span className="tnum w-20 text-right">
                    {formatSatang(line.unitPriceSatang * line.qty)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex gap-3 p-4">
            <button
              type="button"
              onClick={() => setCartOpen((open) => !open)}
              className="btn h-14 bg-slate-100 px-5 text-slate-700"
            >
              {cartOpen ? 'ย่อ' : `ดู ${cartCount} รายการ`}
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending}
              className="btn tnum h-14 flex-1 bg-emerald-600 text-lg text-white disabled:opacity-40"
            >
              {sending ? 'กำลังส่ง…' : `ส่งออร์เดอร์ ${formatSatang(cartTotalSatang)}`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What is already on the table's bill.
 *
 * The status on each row is the whole point of this panel: the customer has to
 * be able to tell "we have asked the staff" from "the kitchen has it", and the
 * total only counts the second kind.
 */
function BillPanel({ bill }: { bill: QrBillDto }): React.ReactElement {
  return (
    <section aria-label="รายการของโต๊ะนี้" className="m-4 rounded-2xl bg-white p-4">
      <h2 className="mb-2 font-semibold">รายการของโต๊ะนี้</h2>
      <ul>
        {bill.lines.map((line) => (
          <li key={line.id} className="flex gap-3 border-b border-slate-100 py-2 last:border-0">
            <span className="tnum w-8 font-bold">{line.qty}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate">{line.name}</p>
              {line.optionsSummary ? (
                <p className="truncate text-sm text-slate-500">{line.optionsSummary}</p>
              ) : null}
              <p
                className={`text-sm ${
                  line.status === 'PENDING' ? 'font-semibold text-amber-700' : 'text-slate-500'
                }`}
              >
                {QR_LINE_STATUS_LABEL[line.status]}
              </p>
            </div>
            <span className="tnum">{formatSatang(line.lineTotalSatang)}</span>
          </li>
        ))}
      </ul>

      <p className="mt-3 flex justify-between border-t border-slate-200 pt-3 font-bold">
        <span>ยอดที่ยืนยันแล้ว</span>
        <span className="tnum">{formatSatang(bill.confirmedTotalSatang)}</span>
      </p>
      {bill.pendingCount > 0 ? (
        <p className="mt-1 text-sm text-amber-700">
          อีก {bill.pendingCount} รายการรอพนักงานยืนยัน — ยังไม่รวมในยอด
        </p>
      ) : null}
      <p className="mt-2 text-sm text-slate-400">ชำระเงินที่เคาน์เตอร์</p>
    </section>
  );
}
