/**
 * The one place that tells staff what the connection is doing.
 *
 * Design rules it follows, in order of importance:
 *
 *  1. SILENT WHEN FINE. Online with an empty queue renders nothing at all — no
 *     green tick, no "connected". A bar that is always there stops being read,
 *     and then the one time it says something that matters, nobody sees it.
 *
 *  2. OFFLINE IS NOT AN ERROR. It is amber, and the words say what still works:
 *     orders keep going in. Staff who believe the till is broken start writing
 *     on paper, and then the two versions of the evening never reconcile.
 *
 *  3. A REJECTION IS RED AND ASKS A QUESTION. It is the only state that needs a
 *     human, so it is the only state with buttons, and both answers are spelled
 *     out: send it again, or take the server's version and lose what this
 *     device queued. "ทิ้ง" says exactly what it destroys.
 */

import { useState } from 'react';
import { useSync } from '../offline/sync-store.js';

export function SyncBar(): React.ReactElement | null {
  const online = useSync((state) => state.online);
  const pending = useSync((state) => state.pending);
  const rejected = useSync((state) => state.rejected);
  const retry = useSync((state) => state.retry);
  const discard = useSync((state) => state.discard);

  const [open, setOpen] = useState(false);

  if (rejected.length > 0) {
    return (
      <div role="alert" className="bg-red-700 text-white">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between px-4 py-2 text-left"
        >
          <span className="font-medium">
            มี {rejected.length} บิลที่ส่งเข้าระบบไม่ได้ — ต้องเลือกว่าจะทำยังไง
          </span>
          <span aria-hidden className="px-2">
            {open ? '▲' : '▼'}
          </span>
        </button>

        {open ? (
          <ul className="border-t border-red-500/50">
            {rejected.map((bill) => (
              <li
                key={bill.orderId}
                className="flex flex-wrap items-center gap-3 border-b border-red-500/30 px-4 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{bill.message}</span>
                  <span className="tnum block text-sm text-red-100">
                    บิล {bill.orderId.slice(0, 8)} · ค้างอยู่ {bill.count} รายการ
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void retry(bill.orderId)}
                  className="btn h-11 bg-white px-4 text-red-800"
                >
                  ลองส่งอีกครั้ง
                </button>
                <button
                  type="button"
                  onClick={() => void discard(bill.orderId)}
                  className="btn h-11 bg-red-900 px-4 text-white"
                >
                  ทิ้งการแก้ไขบนเครื่องนี้
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (!online) {
    return (
      <div role="status" className="flex items-center gap-3 bg-amber-400 px-4 py-2 text-amber-950">
        <span aria-hidden>●</span>
        <span className="font-medium">
          ออฟไลน์ — สั่งอาหารได้ตามปกติ ระบบจะส่งให้เองเมื่อเน็ตกลับมา
        </span>
        {pending > 0 ? <span className="tnum ml-auto">รอส่ง {pending} รายการ</span> : null}
      </div>
    );
  }

  if (pending > 0) {
    return (
      <div role="status" className="flex items-center gap-3 bg-slate-800 px-4 py-2 text-white">
        <span className="tnum">กำลังส่งข้อมูลที่ค้างไว้ {pending} รายการ…</span>
      </div>
    );
  }

  return null;
}
