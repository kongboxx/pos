/**
 * ตั้งค่าสาขา — the settings that were hard-coded until Step 10.
 *
 * Three things on this screen can hurt, and each says so on the screen rather
 * than only in a rejected save:
 *
 *  - THE VAT SWITCH. Turning it on changes what every customer is charged and
 *    what every receipt calls itself. The start date is spelled out in words
 *    next to it, because "เปิด VAT" with no date means "from the beginning of
 *    time" and that is almost never what somebody registering next month wants.
 *  - THE BRANCH CODE, which is frozen the moment a document carries it (rule
 *    #9). The field is disabled with the reason next to it, not accepted and
 *    then refused by the server.
 *  - ปิดสาขา, which takes the branch off the login screen entirely.
 *
 * Adding a branch asks for its first owner's name and PIN in the same form,
 * because a branch with nobody who can log in is a branch nobody can open.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  branchSettingsSchema,
  formatSatang,
  formatTaxId,
  parseBahtToSatang,
  satangToBaht,
  vatIsPending,
  VAT_RATE_BP_7,
  type BranchDto,
  type BranchListResponse,
  type BranchSettingsRequest,
} from '@pos/shared';
import { api } from '../../api-client.js';
import { Card } from '../../components/office/ReportShell.js';
import { SettingsShell } from '../../components/office/SettingsShell.js';

type Form = Omit<BranchSettingsRequest, 'rentPerMonthSatang' | 'vatRateBp'> & {
  rentBaht: string;
  vatPercent: string;
};

export function BranchesPage(): React.ReactElement {
  const [data, setData] = useState<BranchListResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (keepId?: string) => {
    setLoading(true);
    const result = await api.branches();
    setLoading(false);
    if (!result.ok) {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — หน้านี้ต้องออนไลน์' : result.error);
      return;
    }
    setData(result.data);
    setError(null);
    const id = keepId ?? result.data.currentBranchId;
    const branch = result.data.branches.find((row) => row.id === id);
    setSelectedId(id);
    if (branch) setForm(formOf(branch));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = data?.branches.find((row) => row.id === selectedId) ?? null;

  const pick = (branch: BranchDto): void => {
    setSelectedId(branch.id);
    setForm(formOf(branch));
    setNotice(null);
    setError(null);
  };

  const save = async (): Promise<void> => {
    if (!selected || !form) return;
    const payload = toRequest(form);
    const parsed = branchSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง');
      return;
    }

    setBusy(true);
    const result = await api.updateBranch(selected.id, parsed.data);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setNotice('บันทึกแล้ว');
    await load(selected.id);
  };

  return (
    <SettingsShell
      error={error}
      loading={loading}
      controls={
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-700"
        >
          + เพิ่มสาขา
        </button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <nav className="flex flex-col gap-2">
          {(data?.branches ?? []).map((branch) => (
            <button
              key={branch.id}
              type="button"
              onClick={() => pick(branch)}
              className={`btn h-auto flex-col items-start gap-0.5 px-4 py-3 text-left ${
                branch.id === selectedId
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <span className="font-semibold">{branch.name}</span>
              <span className={branch.id === selectedId ? 'text-sm' : 'text-sm text-slate-500'}>
                {branch.branchCode}
                {branch.id === data?.currentBranchId ? ' · สาขาที่ล็อกอินอยู่' : ''}
                {branch.isActive ? '' : ' · ปิดอยู่'}
              </span>
            </button>
          ))}
        </nav>

        {selected && form ? (
          <div className="flex flex-col gap-6">
            {notice ? (
              <p className="rounded-xl bg-emerald-50 p-3 text-emerald-900">{notice}</p>
            ) : null}

            <Card title="ข้อมูลร้าน" subtitle="ชื่อและที่อยู่ที่จะพิมพ์บนใบเสร็จ">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="ชื่อสาขา">
                  <input
                    className="input"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </Field>
                <Field
                  label="รหัสสาขา"
                  hint={
                    selected.hasDocuments
                      ? 'แก้ไม่ได้แล้ว — มีเลขเอกสารที่ออกด้วยรหัสนี้ไปแล้ว'
                      : 'ใช้เป็นส่วนหนึ่งของเลขใบเสร็จและใบกำกับภาษี'
                  }
                >
                  <input className="input bg-slate-100" value={selected.branchCode} disabled />
                </Field>
                <Field label="ที่อยู่">
                  <input
                    className="input"
                    value={form.address ?? ''}
                    onChange={(event) => setForm({ ...form, address: event.target.value })}
                  />
                </Field>
                <Field label="เบอร์โทร">
                  <input
                    className="input"
                    value={form.phone ?? ''}
                    onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  />
                </Field>
                <Field
                  label="เลขประจำตัวผู้เสียภาษีของร้าน"
                  hint={form.taxId ? formatTaxId(form.taxId) : '13 หลัก จำเป็นเมื่อเปิด VAT'}
                >
                  <input
                    className="input"
                    inputMode="numeric"
                    value={form.taxId ?? ''}
                    onChange={(event) => setForm({ ...form, taxId: event.target.value })}
                  />
                </Field>
                <Field label="พร้อมเพย์" hint="เบอร์มือถือหรือเลขผู้เสียภาษี ใช้สร้าง QR รับเงิน">
                  <input
                    className="input"
                    value={form.promptPayId ?? ''}
                    onChange={(event) => setForm({ ...form, promptPayId: event.target.value })}
                  />
                </Field>
              </div>
            </Card>

            <Card
              title="ภาษีมูลค่าเพิ่ม (VAT)"
              subtitle="เปิดเมื่อจดทะเบียน VAT แล้วเท่านั้น — บิลที่ปิดไปแล้วจะไม่ถูกคิดย้อนหลัง"
            >
              <label className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={form.vatEnabled}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      vatEnabled: event.target.checked,
                      vatPercent: event.target.checked && !form.vatPercent ? '7' : form.vatPercent,
                    })
                  }
                />
                <span className="text-lg font-semibold">คิด VAT</span>
              </label>

              {form.vatEnabled ? (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label="อัตรา (%)">
                    <input
                      className="input tnum"
                      inputMode="decimal"
                      value={form.vatPercent}
                      onChange={(event) => setForm({ ...form, vatPercent: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="เริ่มคิดวันที่"
                    hint="ว่างไว้ = คิดย้อนหลังทุกบิลที่คำนวณใหม่ ปกติควรใส่วันที่จดทะเบียน"
                  >
                    <input
                      type="date"
                      className="input"
                      value={form.vatEffectiveDate ?? ''}
                      onChange={(event) =>
                        setForm({ ...form, vatEffectiveDate: event.target.value || null })
                      }
                    />
                  </Field>
                  <Field label="ราคาในเมนู">
                    <select
                      className="input"
                      value={form.priceIncludesVat ? 'INCLUDE' : 'EXCLUDE'}
                      onChange={(event) =>
                        setForm({ ...form, priceIncludesVat: event.target.value === 'INCLUDE' })
                      }
                    >
                      <option value="INCLUDE">รวม VAT แล้ว</option>
                      <option value="EXCLUDE">ยังไม่รวม VAT</option>
                    </select>
                  </Field>
                </div>
              ) : null}

              {form.vatEnabled && data
                ? (() => {
                    const pending = vatIsPending(
                      {
                        vatEnabled: true,
                        vatRateBp: VAT_RATE_BP_7,
                        priceIncludesVat: form.priceIncludesVat,
                        vatEffectiveDate: form.vatEffectiveDate,
                      },
                      data.today,
                    );
                    return (
                      <p className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-900">
                        {pending
                          ? `ยังไม่เริ่มคิด — บิลจะเริ่มมี VAT ตั้งแต่วันที่ ${form.vatEffectiveDate}`
                          : 'คิด VAT อยู่ตอนนี้ — ใบเสร็จจะเปลี่ยนเป็น "ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ"'}
                      </p>
                    );
                  })()
                : null}
            </Card>

            <Card title="การใช้งาน" subtitle="ค่าเช่าใช้คำนวณจุดคุ้มทุนในหน้ากำไรขาดทุน">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="ค่าเช่าต่อเดือน (บาท)">
                  <input
                    className="input tnum"
                    inputMode="decimal"
                    value={form.rentBaht}
                    onChange={(event) => setForm({ ...form, rentBaht: event.target.value })}
                  />
                </Field>
                <Field label="เวลาเริ่มวันใหม่ (ชั่วโมง)" hint="4 = บิลตอนตี 1 นับเป็นของเมื่อวาน">
                  <input
                    className="input tnum"
                    inputMode="numeric"
                    value={String(form.dayCutoffHour)}
                    onChange={(event) =>
                      setForm({ ...form, dayCutoffHour: Number(event.target.value) || 0 })
                    }
                  />
                </Field>
              </div>

              <label className="mt-4 flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={form.qrOrderingEnabled}
                  onChange={(event) =>
                    setForm({ ...form, qrOrderingEnabled: event.target.checked })
                  }
                />
                <span>เปิดให้ลูกค้าสั่งผ่าน QR</span>
              </label>

              <label className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={!form.isActive}
                  onChange={(event) => setForm({ ...form, isActive: !event.target.checked })}
                />
                <span>ปิดสาขานี้ (จะหายจากหน้าล็อกอิน)</span>
              </label>

              <p className="mt-2 text-sm text-slate-500">
                พนักงานที่ยังทำงานอยู่ {selected.activeStaffCount} คน · ค่าเช่าปัจจุบัน{' '}
                <span className="tnum">{formatSatang(selected.rentPerMonthSatang)}</span> บาท
              </p>
            </Card>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy}
                className="btn h-14 bg-brand-600 px-8 text-lg text-white hover:bg-brand-700
                  disabled:opacity-50"
              >
                บันทึก
              </button>
              <button
                type="button"
                onClick={() => pick(selected)}
                className="btn h-14 bg-slate-100 px-8 text-slate-700 hover:bg-slate-200"
              >
                ยกเลิกการแก้ไข
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {adding ? (
        <AddBranchDialog
          onClose={() => setAdding(false)}
          onCreated={async (branch) => {
            setAdding(false);
            await load(branch.id);
          }}
        />
      ) : null}
    </SettingsShell>
  );
}

/* ------------------------------------------------------------------ */

function AddBranchDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (branch: BranchDto) => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [branchCode, setBranchCode] = useState('');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [ownerNickname, setOwnerNickname] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    const result = await api.createBranch({
      name: name.trim(),
      branchCode: branchCode.trim().toUpperCase(),
      businessType: 'RESTAURANT',
      timezone: 'Asia/Bangkok',
      dayCutoffHour: 4,
      ownerFullName: ownerFullName.trim(),
      ownerNickname: ownerNickname.trim() || null,
      ownerPin: pin,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onCreated(result.data);
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="เพิ่มสาขา"
        className="w-full max-w-lg rounded-3xl bg-white p-6"
      >
        <h2 className="text-2xl font-bold">เพิ่มสาขา</h2>
        <p className="mt-1 text-slate-500">
          สาขาใหม่ต้องมีคนเข้าระบบได้อย่างน้อยหนึ่งคน จึงต้องตั้งเจ้าของสาขาพร้อมกัน
        </p>

        <div className="mt-5 grid gap-4">
          <Field label="ชื่อสาขา">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="รหัสสาขา" hint="ตัวอักษร/ตัวเลข 1-8 ตัว ตั้งแล้วเปลี่ยนไม่ได้">
            <input
              className="input uppercase"
              value={branchCode}
              onChange={(e) => setBranchCode(e.target.value)}
            />
          </Field>
          <Field label="ชื่อเจ้าของสาขา">
            <input
              className="input"
              value={ownerFullName}
              onChange={(e) => setOwnerFullName(e.target.value)}
            />
          </Field>
          <Field label="ชื่อเล่น">
            <input
              className="input"
              value={ownerNickname}
              onChange={(e) => setOwnerNickname(e.target.value)}
            />
          </Field>
          <Field label="PIN 4 หลัก">
            <input
              className="input tnum"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-red-900">
            {error}
          </p>
        ) : null}

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
            onClick={() => void submit()}
            disabled={busy}
            className="btn h-14 bg-brand-600 px-8 text-white hover:bg-brand-700 disabled:opacity-50"
          >
            เปิดสาขา
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="text-sm text-slate-400">{hint}</span> : null}
    </label>
  );
}

function formOf(branch: BranchDto): Form {
  return {
    name: branch.name,
    businessType: branch.businessType,
    address: branch.address,
    phone: branch.phone,
    taxId: branch.taxId,
    timezone: branch.timezone,
    dayCutoffHour: branch.dayCutoffHour,
    vatEnabled: branch.vatEnabled,
    vatPercent: branch.vatRateBp ? String(branch.vatRateBp / 100) : '',
    priceIncludesVat: branch.priceIncludesVat,
    vatEffectiveDate: branch.vatEffectiveDate,
    rentBaht: String(satangToBaht(branch.rentPerMonthSatang)),
    promptPayId: branch.promptPayId,
    qrOrderingEnabled: branch.qrOrderingEnabled,
    isActive: branch.isActive,
  };
}

function toRequest(form: Form): Record<string, unknown> {
  return {
    ...form,
    // Percent on screen, basis points on the wire — the rate is an Int all the
    // way down (rule #2), so 7.5% is 750 and never 0.075.
    vatRateBp: Math.round((Number(form.vatPercent) || 0) * 100),
    rentPerMonthSatang: parseBahtToSatang(form.rentBaht) ?? 0,
  };
}
