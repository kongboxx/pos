/**
 * Step 1 screen: one button that puts paper out of the printer.
 *
 * It also shows a live preview of the slip. Before the hardware arrives the
 * preview is the deliverable — it proves the Thai layout and the money column
 * are right. Once the printer is on the LAN, the same page proves the whole
 * chain: browser -> API -> queue -> Pi -> printer -> drawer.
 *
 * The preview is rendered with the SAME code the agent uses (renderReceiptText
 * from @pos/shared), so it cannot drift from what actually prints.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isTerminalStatus,
  PrintJobStatus,
  renderReceiptText,
  WIDTH_58MM,
  WIDTH_80MM,
  type PrintJobStatusResponse,
  type ReceiptDoc,
} from '@pos/shared';
import { api } from './api-client.js';

type Phase =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'tracking'; jobId: string; status: PrintJobStatusResponse }
  | { state: 'error'; message: string };

export function PrintTestPage(): React.ReactElement {
  const [width, setWidth] = useState<number>(WIDTH_80MM);
  const [openDrawer, setOpenDrawer] = useState(true);
  const [preview, setPreview] = useState<ReceiptDoc | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ state: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresh the preview whenever the paper settings change.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.printPreview({ width, openDrawer });
      if (cancelled) return;
      if (result.ok) {
        setPreview(result.data.document);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [width, openDrawer]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const pollJob = useCallback((jobId: string) => {
    const tick = async (): Promise<void> => {
      const result = await api.printJobStatus(jobId);
      if (!result.ok) {
        setPhase({ state: 'error', message: result.error });
        return;
      }
      setPhase({ state: 'tracking', jobId, status: result.data });
      if (!isTerminalStatus(result.data.status)) {
        pollTimer.current = setTimeout(() => void tick(), 700);
      }
    };
    void tick();
  }, []);

  const handlePrint = useCallback(async (): Promise<void> => {
    setPhase({ state: 'sending' });
    const result = await api.printTest({ width, openDrawer });
    if (!result.ok) {
      setPhase({ state: 'error', message: result.error });
      return;
    }
    pollJob(result.data.jobId);
  }, [width, openDrawer, pollJob]);

  const busy =
    phase.state === 'sending' ||
    (phase.state === 'tracking' && !isTerminalStatus(phase.status.status));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-3xl font-bold">ทดสอบเครื่องพิมพ์</h1>
      <p className="mt-1 text-slate-500">
        Step 1 — กดปุ่มเดียว ใบเสร็จต้องออกจากเครื่องพิมพ์และลิ้นชักต้องเปิด
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_auto]">
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold">ตั้งค่ากระดาษ</h2>

          <div className="mt-4 flex flex-wrap gap-3">
            <WidthButton
              current={width}
              value={WIDTH_80MM}
              onSelect={setWidth}
              label="80 มม. (48 ช่อง)"
            />
            <WidthButton
              current={width}
              value={WIDTH_58MM}
              onSelect={setWidth}
              label="58 มม. (32 ช่อง)"
            />
          </div>

          <label className="mt-5 flex min-h-touch cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={openDrawer}
              onChange={(event) => setOpenDrawer(event.target.checked)}
              className="h-6 w-6 rounded"
            />
            <span>เปิดลิ้นชักเก็บเงินด้วย</span>
          </label>

          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={busy}
            className="btn mt-6 h-16 w-full bg-brand-600 text-lg text-white
              hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {busy ? 'กำลังพิมพ์…' : 'พิมพ์ใบทดสอบ'}
          </button>

          <PhaseStatus phase={phase} />
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold">ตัวอย่างใบเสร็จ</h2>
          <p className="mt-1 text-sm text-slate-500">
            เรนเดอร์ด้วยโค้ดชุดเดียวกับที่เครื่องพิมพ์ใช้
          </p>
          {previewError ? (
            <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{previewError}</p>
          ) : preview ? (
            <ReceiptPreview doc={preview} />
          ) : (
            <p className="mt-4 text-slate-400">กำลังโหลด…</p>
          )}
        </section>
      </div>
    </main>
  );
}

function WidthButton({
  current,
  value,
  label,
  onSelect,
}: {
  current: number;
  value: number;
  label: string;
  onSelect: (value: number) => void;
}): React.ReactElement {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`btn h-12 border ${
        active ? 'border-brand-600 bg-brand-50 text-brand-900' : 'border-slate-200 bg-white'
      }`}
    >
      {label}
    </button>
  );
}

function PhaseStatus({ phase }: { phase: Phase }): React.ReactElement | null {
  if (phase.state === 'idle') return null;

  if (phase.state === 'error') {
    return (
      <div className="mt-4 rounded-xl bg-red-50 p-4 text-red-900">
        <p className="font-medium">ส่งงานพิมพ์ไม่สำเร็จ</p>
        <p className="mt-1 text-sm">{phase.message}</p>
      </div>
    );
  }

  if (phase.state === 'sending') {
    return <p className="mt-4 text-slate-500">กำลังส่งเข้าคิว…</p>;
  }

  const { status } = phase;
  const tone =
    status.status === PrintJobStatus.PRINTED
      ? 'bg-emerald-50 text-emerald-900'
      : status.status === PrintJobStatus.FAILED
        ? 'bg-red-50 text-red-900'
        : 'bg-slate-100 text-slate-700';

  return (
    <div className={`mt-4 rounded-xl p-4 ${tone}`}>
      <p className="font-medium">{STATUS_LABEL[status.status]}</p>
      <p className="mt-1 text-sm tnum">
        ครั้งที่ {status.attempts}/{status.maxAttempts}
      </p>
      {status.lastError ? <p className="mt-1 text-sm">{status.lastError}</p> : null}
      {status.status === PrintJobStatus.QUEUED && status.attempts === 0 ? (
        <p className="mt-2 text-sm">
          ถ้าค้างอยู่นาน แปลว่ายังไม่มี print agent รับงาน — รัน{' '}
          <code className="rounded bg-white/60 px-1">pnpm dev:agent</code>
        </p>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<PrintJobStatus, string> = {
  QUEUED: 'อยู่ในคิว รอ print agent มารับ',
  CLAIMED: 'print agent รับงานแล้ว กำลังพิมพ์',
  PRINTED: 'พิมพ์สำเร็จ',
  FAILED: 'พิมพ์ไม่สำเร็จ — ตรวจเครื่องพิมพ์',
  CANCELLED: 'ยกเลิกแล้ว',
};

/**
 * Renders the slip in a monospace column of exactly `doc.width` characters.
 *
 * Thai combining marks are given zero width here too, so what shows on screen
 * matches the printer's grid rather than the browser's idea of text layout.
 */
function ReceiptPreview({ doc }: { doc: ReceiptDoc }): React.ReactElement {
  const lines = renderReceiptText(doc);
  return (
    <pre
      className="mt-4 overflow-x-auto rounded-xl bg-slate-900 p-4 text-[13px]
        leading-snug text-slate-100"
      style={{ fontFamily: "'Sarabun', 'Noto Sans Thai Mono', ui-monospace, monospace" }}
    >
      {lines.map((line) => line.replace(/\s+$/, '')).join('\n')}
    </pre>
  );
}
