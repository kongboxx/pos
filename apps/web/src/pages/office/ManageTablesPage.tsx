/**
 * ผังโต๊ะ · สติกเกอร์ QR · สวิตช์ปิดรับ.
 *
 * Three jobs on one screen, in the order the shop needs them:
 *
 *  1. THE LAYOUT. Until now the floor plan came from the seed, which meant a
 *     real shop arranging its own room had to edit the database. Add, rename,
 *     move, retire — all from here.
 *
 *  2. Print the codes. The QR is drawn here rather than fetched as an image so
 *     it prints at whatever the paper can resolve, and the URL under each one
 *     is printed too — a code that will not scan is then still a page someone
 *     can type in.
 *
 *  3. Close it. "ปิดรับออร์เดอร์ผ่าน QR" stops every table at once, and
 *     "เปลี่ยนรหัส" kills one sticker whose photograph is being abused. Without
 *     these the only answer to a problem at 8pm is peeling stickers off the
 *     furniture.
 *
 * A RETIRED TABLE STAYS IN THE LIST and loses its sticker card. It has to stay
 * visible — a table that vanished from this screen looks exactly like a table
 * somebody deleted, and "where did โต๊ะ B3 go" is the question the retire/delete
 * distinction exists to never have to answer with a shrug.
 *
 * THE URL IS BUILT FROM window.location.origin, not from the server. The API
 * knows it is running on localhost:3001, which is precisely the address a
 * customer's phone cannot reach; the browser looking at this page is already at
 * an address that works from inside the shop.
 */

import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  groupTablesByZone,
  qrOrderUrl,
  type TableQrDto,
  type TableQrResponse,
  type TableRequest,
} from '@pos/shared';
import { officeApi, type ApiResult } from '../../api-office.js';
import { ManageShell } from '../../components/office/ManageShell.js';

export function ManageTablesPage(): React.ReactElement {
  const [data, setData] = useState<TableQrResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingQrId, setConfirmingQrId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  /** The table being edited, or 'NEW' for the add form. */
  const [editing, setEditing] = useState<TableQrDto | 'NEW' | null>(null);

  const load = useCallback(async () => {
    const result = await officeApi.manageTables();
    if (result.ok) setData(result.data);
    else setError(result.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (work: () => Promise<ApiResult<TableQrResponse>>) => {
    setBusy(true);
    setError(null);
    const result = await work();
    setBusy(false);
    if (result.ok) {
      setData(result.data);
      return true;
    }
    setError(result.error);
    return false;
  }, []);

  const origin = globalThis.location?.origin ?? '';
  const zones = groupTablesByZone(data?.tables ?? []);
  const printable = (data?.tables ?? []).filter((table) => table.isActive);

  return (
    <ManageShell>
      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 p-4 text-red-900">
          {error}
        </p>
      ) : null}

      {data === null ? (
        <p className="text-slate-400">กำลังโหลด…</p>
      ) : (
        <>
          <section className="mb-6 flex items-center justify-between rounded-2xl bg-white p-4">
            <div>
              <h2 className="text-lg font-semibold">รับออร์เดอร์จาก QR</h2>
              <p className="text-slate-500">
                {data.orderingEnabled
                  ? 'เปิดอยู่ — ลูกค้าสแกนแล้วสั่งได้ ทุกรายการยังต้องให้พนักงานกดยืนยันก่อนเข้าครัว'
                  : 'ปิดอยู่ — ลูกค้าสแกนแล้วเห็นเมนู แต่สั่งไม่ได้'}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => officeApi.setQrOrdering(!data.orderingEnabled))}
              className={`btn h-14 px-8 text-lg text-white disabled:opacity-40 ${
                data.orderingEnabled
                  ? 'bg-slate-600 hover:bg-slate-500'
                  : 'bg-emerald-600 hover:bg-emerald-500'
              }`}
            >
              {data.orderingEnabled ? 'ปิดรับ' : 'เปิดรับ'}
            </button>
          </section>

          <section className="mb-6 rounded-2xl bg-white p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">ผังโต๊ะ</h2>
                <p className="text-slate-500">
                  ลำดับตรงนี้คือลำดับที่ขึ้นบนหน้าผังโต๊ะ · โซนเรียงตามตัวอักษร
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing('NEW')}
                className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-700"
              >
                + เพิ่มโต๊ะ
              </button>
            </div>

            {data.tables.length === 0 ? (
              <p className="text-slate-500">ยังไม่มีโต๊ะ — กด &quot;เพิ่มโต๊ะ&quot; เพื่อเริ่ม</p>
            ) : null}

            {zones.map((group) => (
              <div key={group.zone} className="mb-5 last:mb-0">
                <h3 className="mb-2 font-semibold text-slate-600">{group.zone}</h3>
                <div className="flex flex-col gap-2">
                  {group.tables.map((table, index) => (
                    <TableRow
                      key={table.id}
                      table={table}
                      busy={busy}
                      isFirst={index === 0}
                      isLast={index === group.tables.length - 1}
                      confirmingDelete={confirmingDeleteId === table.id}
                      onMove={(direction) => void run(() => officeApi.moveTable(table.id, direction))}
                      onEdit={() => setEditing(table)}
                      onToggleActive={() =>
                        void run(() =>
                          officeApi.updateTable(table.id, {
                            name: table.name,
                            zone: table.zone,
                            seats: table.seats,
                            isActive: !table.isActive,
                          }),
                        )
                      }
                      onAskDelete={() => setConfirmingDeleteId(table.id)}
                      onCancelDelete={() => setConfirmingDeleteId(null)}
                      onDelete={() => {
                        setConfirmingDeleteId(null);
                        void run(() => officeApi.deleteTable(table.id));
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>

          <h2 className="mb-2 text-lg font-semibold">สติกเกอร์ QR</h2>
          <p className="mb-4 text-slate-500">
            พิมพ์ QR ของแต่ละโต๊ะแล้วติดไว้บนโต๊ะ · ถ้ามีคนถ่ายรูป QR ไปสั่งป่วน ให้กด
            &quot;เปลี่ยนรหัส&quot; แล้วพิมพ์ใหม่เฉพาะโต๊ะนั้น ·
            เปลี่ยนชื่อโต๊ะไม่ทำให้สติกเกอร์เดิมเสีย
          </p>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {printable.map((table) => (
              <TableQrCard
                key={table.id}
                table={table}
                url={qrOrderUrl(origin, table.qrToken)}
                busy={busy}
                confirming={confirmingQrId === table.id}
                onAskRotate={() => setConfirmingQrId(table.id)}
                onCancelRotate={() => setConfirmingQrId(null)}
                onRotate={() => {
                  setConfirmingQrId(null);
                  void run(() => officeApi.rotateTableQr(table.id));
                }}
              />
            ))}
          </div>
        </>
      )}

      {editing ? (
        <TableEditDialog
          table={editing === 'NEW' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const ok = await run(() =>
              editing === 'NEW' ? officeApi.createTable(input) : officeApi.updateTable(editing.id, input),
            );
            if (ok) setEditing(null);
          }}
        />
      ) : null}
    </ManageShell>
  );
}

/* ------------------------------------------------------------------ */

function TableRow({
  table,
  busy,
  isFirst,
  isLast,
  confirmingDelete,
  onMove,
  onEdit,
  onToggleActive,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  table: TableQrDto;
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  confirmingDelete: boolean;
  onMove: (direction: 'UP' | 'DOWN') => void;
  onEdit: () => void;
  onToggleActive: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl p-3 ${
        table.isActive ? 'bg-slate-50' : 'bg-slate-100'
      }`}
    >
      <div className="flex gap-1">
        <button
          type="button"
          aria-label={`เลื่อน ${table.name} ขึ้น`}
          disabled={busy || isFirst}
          onClick={() => onMove('UP')}
          className="btn h-11 w-11 bg-white text-lg ring-1 ring-slate-200 disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`เลื่อน ${table.name} ลง`}
          disabled={busy || isLast}
          onClick={() => onMove('DOWN')}
          className="btn h-11 w-11 bg-white text-lg ring-1 ring-slate-200 disabled:opacity-30"
        >
          ↓
        </button>
      </div>

      <div className="min-w-0 flex-1">
        <p className={`text-lg font-semibold ${table.isActive ? '' : 'text-slate-400'}`}>
          {table.name}
          {table.isActive ? null : <span className="ml-2 text-sm">· ปิดใช้อยู่</span>}
        </p>
        <p className="text-sm text-slate-500">
          {table.seats} ที่นั่ง
          {table.hasOpenBill ? <span className="ml-2 text-amber-700">· มีบิลเปิดค้าง</span> : null}
        </p>
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={onEdit}
        className="btn h-11 bg-white px-5 text-slate-700 ring-1 ring-slate-200 disabled:opacity-40"
      >
        แก้ไข
      </button>

      <button
        type="button"
        disabled={busy || (table.isActive && table.hasOpenBill)}
        onClick={onToggleActive}
        className="btn h-11 bg-white px-5 text-slate-700 ring-1 ring-slate-200 disabled:opacity-40"
      >
        {table.isActive ? 'ปิดใช้' : 'เปิดใช้'}
      </button>

      {/* Deleting is offered ONLY for a table nothing points at — see
          table-admin.routes.ts. A row with history gets the reason in words
          rather than a greyed-out button nobody can explain. */}
      {table.hasHistory ? (
        <span className="text-sm text-slate-400">เคยมีบิลแล้ว ลบไม่ได้</span>
      ) : confirmingDelete ? (
        <span className="flex gap-2">
          <button
            type="button"
            onClick={onDelete}
            className="btn h-11 bg-red-600 px-4 text-sm text-white"
          >
            ยืนยันลบ
          </button>
          <button type="button" onClick={onCancelDelete} className="btn h-11 bg-slate-200 px-4">
            ยกเลิก
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy || table.hasOpenBill}
          onClick={onAskDelete}
          className="btn h-11 bg-white px-5 text-red-700 ring-1 ring-slate-200 disabled:opacity-40"
        >
          ลบ
        </button>
      )}
    </div>
  );
}

function TableEditDialog({
  table,
  busy,
  onClose,
  onSave,
}: {
  table: TableQrDto | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: TableRequest) => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState(table?.name ?? '');
  const [zone, setZone] = useState(table?.zone ?? '');
  const [seats, setSeats] = useState(String(table?.seats ?? 4));

  const ready = name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={table ? 'แก้ไขโต๊ะ' : 'เพิ่มโต๊ะ'}
        className="w-full max-w-md rounded-3xl bg-white p-6"
      >
        <h2 className="text-2xl font-bold">{table ? `แก้ไข ${table.name}` : 'เพิ่มโต๊ะ'}</h2>
        {table ? (
          <p className="mt-1 text-slate-500">เปลี่ยนชื่อแล้วสติกเกอร์ QR เดิมยังใช้ได้ตามปกติ</p>
        ) : null}

        <div className="mt-5 grid gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">ชื่อโต๊ะ</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">โซน</span>
            <input
              className="input"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
            />
            <span className="text-sm text-slate-400">
              เว้นว่างได้ · โต๊ะที่โซนเดียวกันจะอยู่กลุ่มเดียวกันบนหน้าผังโต๊ะ
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-600">จำนวนที่นั่ง</span>
            <input
              className="input tnum"
              inputMode="numeric"
              value={seats}
              onChange={(event) => setSeats(event.target.value.replace(/\D/g, ''))}
            />
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn h-14 bg-slate-100 px-8 text-slate-700 hover:bg-slate-200"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() =>
              void onSave({
                name: name.trim(),
                zone: zone.trim() || null,
                seats: Number(seats) || 0,
                // Editing never flips this — that is the ปิดใช้ button's job,
                // and it is the one that checks for an open bill.
                isActive: table?.isActive ?? true,
              })
            }
            className="btn h-14 bg-brand-600 px-8 text-white hover:bg-brand-700 disabled:opacity-40"
          >
            บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}

function TableQrCard({
  table,
  url,
  busy,
  confirming,
  onAskRotate,
  onCancelRotate,
  onRotate,
}: {
  table: TableQrDto;
  url: string;
  busy: boolean;
  confirming: boolean;
  onAskRotate: () => void;
  onCancelRotate: () => void;
  onRotate: () => void;
}): React.ReactElement {
  return (
    <section className="flex flex-col items-center rounded-2xl bg-white p-4 text-center">
      <h3 className="text-xl font-bold">{table.name}</h3>
      <p className="mb-2 text-sm text-slate-500">{table.zone ?? 'ไม่ระบุโซน'}</p>

      <div className="rounded-xl bg-white p-2 ring-1 ring-slate-200">
        <QRCodeSVG value={url} size={140} level="M" />
      </div>

      {/* Printed under the code on purpose: a phone that cannot scan can still
          be typed into, and a sticker with no readable address is a sticker
          nobody can debug. */}
      <p className="mt-2 w-full truncate text-xs text-slate-400" title={url}>
        {url}
      </p>

      {confirming ? (
        <div className="mt-3 flex w-full gap-2">
          <button
            type="button"
            onClick={onRotate}
            className="btn h-11 flex-1 bg-red-600 text-sm text-white"
          >
            ยืนยันเปลี่ยน
          </button>
          <button type="button" onClick={onCancelRotate} className="btn h-11 bg-slate-100 px-3">
            ยกเลิก
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onAskRotate}
          className="btn mt-3 h-11 w-full bg-slate-100 text-sm text-slate-700 disabled:opacity-40"
        >
          เปลี่ยนรหัส
        </button>
      )}

      {confirming ? (
        <p className="mt-2 text-sm text-red-700">สติกเกอร์เดิมของโต๊ะนี้จะใช้ไม่ได้ทันที</p>
      ) : null}
    </section>
  );
}
