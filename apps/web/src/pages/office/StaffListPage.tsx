/**
 * พนักงาน — the people (Step 9).
 *
 * Two things on this screen are not obvious and both are deliberate:
 *
 *  - THE PIN IS NOT PART OF THE EDIT FORM. Changing a phone number and changing
 *    who can sign in as this person are different acts, and merging them means
 *    every edit is a chance to silently reissue somebody's credential. Setting
 *    one is its own button and its own confirmation.
 *  - PEOPLE WHO HAVE LEFT STAY ON THE LIST, greyed, at the bottom. Their names
 *    are on old payslips and on approved voids; hiding them makes those records
 *    unexplainable a year later.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  documentExpiryState,
  formatSatang,
  Nationality,
  parseBahtToSatang,
  Permission,
  Role,
  ROLE_LABEL,
  satangToBaht,
  STAFF_STATUS_LABEL,
  StaffStatus,
  WAGE_TYPE_LABEL,
  WageType,
  type StaffDto,
  type StaffListResponse,
  type StaffRequest,
} from '@pos/shared';
import { officeApi } from '../../api-office.js';
import { ExpiryBadge, expiryWarningText, StaffShell } from '../../components/office/StaffShell.js';
import { useBusinessToday } from '../../business-day.js';
import { useSession } from '../../session.js';

interface Draft {
  fullName: string;
  nickname: string;
  position: string;
  role: Role;
  phone: string;
  startDate: string;
  endDate: string;
  status: StaffStatus;
  nationality: Nationality;
  passportNo: string;
  passportExpiry: string;
  workPermitNo: string;
  workPermitExpiry: string;
  wageType: WageType;
  wage: string;
  note: string;
  pin: string;
}

export function StaffListPage(): React.ReactElement {
  const today = useBusinessToday();
  const canWrite = useSession((state) => state.can(Permission.MANAGE_STAFF));

  const [data, setData] = useState<StaffListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(today));

  const load = useCallback(async () => {
    setLoading(true);
    const result = await officeApi.staff();
    setLoading(false);
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — หน้านี้ต้องออนไลน์' : result.error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback((result: Awaited<ReturnType<typeof officeApi.staff>>, message: string) => {
    if (!result.ok) {
      setError(result.offline ? 'ต่อเซิร์ฟเวอร์ไม่ได้ — บันทึกไม่สำเร็จ' : result.error);
      return false;
    }
    setData(result.data);
    setError(null);
    setNotice(message);
    return true;
  }, []);

  const submit = useCallback(async () => {
    const wageRateSatang = parseBahtToSatang(draft.wage === '' ? '0' : draft.wage);
    if (wageRateSatang === null || wageRateSatang < 0) {
      setError('ใส่ค่าแรงให้ถูกต้อง');
      return;
    }
    const input: StaffRequest = {
      fullName: draft.fullName.trim(),
      nickname: blank(draft.nickname),
      position: blank(draft.position),
      role: draft.role,
      phone: blank(draft.phone),
      startDate: draft.startDate,
      endDate: blank(draft.endDate),
      status: draft.status,
      nationality: draft.nationality,
      passportNo: blank(draft.passportNo),
      passportExpiry: blank(draft.passportExpiry),
      workPermitNo: blank(draft.workPermitNo),
      workPermitExpiry: blank(draft.workPermitExpiry),
      wageType: draft.wageType,
      wageRateSatang,
      note: blank(draft.note),
    };

    setBusy(true);
    const result = editingId
      ? await officeApi.updateStaff(editingId, input)
      : await officeApi.createStaff({ ...input, pin: draft.pin });
    setBusy(false);

    if (apply(result, editingId ? 'บันทึกการแก้ไขแล้ว' : `เพิ่ม ${input.fullName} แล้ว`)) {
      setFormOpen(false);
      setEditingId(null);
      setDraft(emptyDraft(today));
    }
  }, [draft, editingId, today, apply]);

  const startEdit = useCallback((staff: StaffDto) => {
    setEditingId(staff.id);
    setFormOpen(true);
    setDraft({
      fullName: staff.fullName,
      nickname: staff.nickname ?? '',
      position: staff.position ?? '',
      role: staff.role,
      phone: staff.phone ?? '',
      startDate: staff.startDate,
      endDate: staff.endDate ?? '',
      status: staff.status,
      nationality: staff.nationality,
      passportNo: staff.passportNo ?? '',
      passportExpiry: staff.passportExpiry ?? '',
      workPermitNo: staff.workPermitNo ?? '',
      workPermitExpiry: staff.workPermitExpiry ?? '',
      wageType: staff.wageType,
      wage: String(satangToBaht(staff.wageRateSatang)),
      note: staff.note ?? '',
      pin: '',
    });
  }, []);

  const resetPin = useCallback(
    async (staff: StaffDto) => {
      const pin = globalThis.prompt(
        `ตั้ง PIN ใหม่ให้ ${staff.nickname ?? staff.fullName} (4 หลัก)`,
      );
      if (!pin) return;
      setBusy(true);
      const result = await officeApi.setStaffPin(staff.id, pin.trim());
      setBusy(false);
      apply(result, `ตั้ง PIN ใหม่ให้ ${staff.nickname ?? staff.fullName} แล้ว`);
    },
    [apply],
  );

  const remove = useCallback(
    async (staff: StaffDto) => {
      if (!globalThis.confirm(`ลบ ${staff.fullName} ออกจากระบบ?`)) return;
      setBusy(true);
      const result = await officeApi.deleteStaff(staff.id);
      setBusy(false);
      apply(result, `ลบ ${staff.fullName} แล้ว`);
    },
    [apply],
  );

  const staff = data?.staff ?? [];
  const expiringCount = useMemo(
    () =>
      staff.filter((person) =>
        [person.workPermitExpiry, person.passportExpiry].some((date) =>
          ['EXPIRED', 'EXPIRING'].includes(documentExpiryState(date, today)),
        ),
      ).length,
    [staff, today],
  );

  const controls = canWrite ? (
    <button
      type="button"
      onClick={() => {
        setEditingId(null);
        setDraft(emptyDraft(today));
        setFormOpen(true);
      }}
      className="btn h-12 bg-brand-600 px-6 text-white hover:bg-brand-500"
    >
      + เพิ่มพนักงาน
    </button>
  ) : null;

  return (
    <StaffShell
      controls={controls}
      error={error}
      notice={notice}
      loading={loading && data === null}
    >
      {expiringCount > 0 ? (
        <p role="status" className="mb-4 rounded-2xl bg-amber-50 p-4 text-amber-900">
          {expiryWarningText(expiringCount)}
        </p>
      ) : null}

      {formOpen && canWrite ? (
        <form
          aria-label={editingId ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน'}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mb-4 rounded-2xl bg-white p-5"
        >
          <h2 className="text-lg font-semibold">{editingId ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน'}</h2>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="ชื่อ-นามสกุล">
              <input
                type="text"
                aria-label="ชื่อ-นามสกุล"
                required
                value={draft.fullName}
                onChange={(event) => setDraft((d) => ({ ...d, fullName: event.target.value }))}
                className="input"
              />
            </Field>
            <Field label="ชื่อเล่น">
              <input
                type="text"
                aria-label="ชื่อเล่น"
                value={draft.nickname}
                onChange={(event) => setDraft((d) => ({ ...d, nickname: event.target.value }))}
                className="input"
              />
            </Field>
            <Field label="ตำแหน่ง">
              <input
                type="text"
                aria-label="ตำแหน่ง"
                placeholder="กุ๊ก / แคชเชียร์"
                value={draft.position}
                onChange={(event) => setDraft((d) => ({ ...d, position: event.target.value }))}
                className="input"
              />
            </Field>

            <Field label="สิทธิ์การใช้งาน">
              <select
                aria-label="สิทธิ์การใช้งาน"
                value={draft.role}
                onChange={(event) => setDraft((d) => ({ ...d, role: event.target.value as Role }))}
                className="input"
              >
                {Object.values(Role).map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="สถานะ">
              <select
                aria-label="สถานะ"
                value={draft.status}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, status: event.target.value as StaffStatus }))
                }
                className="input"
              >
                {Object.values(StaffStatus).map((status) => (
                  <option key={status} value={status}>
                    {STAFF_STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="เบอร์โทร">
              <input
                type="tel"
                aria-label="เบอร์โทร"
                value={draft.phone}
                onChange={(event) => setDraft((d) => ({ ...d, phone: event.target.value }))}
                className="input"
              />
            </Field>

            <Field label="วันเริ่มงาน">
              <input
                type="date"
                aria-label="วันเริ่มงาน"
                required
                value={draft.startDate}
                onChange={(event) => setDraft((d) => ({ ...d, startDate: event.target.value }))}
                className="input tnum"
              />
            </Field>
            <Field label="วันที่ออก (ถ้ามี)">
              <input
                type="date"
                aria-label="วันที่ออก"
                value={draft.endDate}
                onChange={(event) => setDraft((d) => ({ ...d, endDate: event.target.value }))}
                className="input tnum"
              />
            </Field>
            <Field label="สัญชาติ">
              <select
                aria-label="สัญชาติ"
                value={draft.nationality}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, nationality: event.target.value as Nationality }))
                }
                className="input"
              >
                <option value={Nationality.TH}>ไทย</option>
                <option value={Nationality.FOREIGN}>ต่างชาติ</option>
              </select>
            </Field>

            <Field label="ค่าแรงแบบ">
              <select
                aria-label="ค่าแรงแบบ"
                value={draft.wageType}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, wageType: event.target.value as WageType }))
                }
                className="input"
              >
                {Object.values(WageType).map((type) => (
                  <option key={type} value={type}>
                    {WAGE_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={draft.wageType === WageType.DAILY ? 'ค่าแรงต่อวัน (บาท)' : 'เงินเดือน (บาท)'}
            >
              <input
                type="text"
                inputMode="decimal"
                aria-label="ค่าแรง"
                value={draft.wage}
                onChange={(event) => setDraft((d) => ({ ...d, wage: event.target.value }))}
                className="input tnum text-right"
              />
            </Field>
            {editingId ? null : (
              <Field label="PIN เข้าใช้งาน (4 หลัก)">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="PIN เข้าใช้งาน"
                  required
                  maxLength={4}
                  value={draft.pin}
                  onChange={(event) => setDraft((d) => ({ ...d, pin: event.target.value }))}
                  className="input tnum"
                />
              </Field>
            )}
          </div>

          {draft.nationality === Nationality.FOREIGN ? (
            <div className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-4 md:grid-cols-4">
              <Field label="เลขพาสปอร์ต">
                <input
                  type="text"
                  aria-label="เลขพาสปอร์ต"
                  value={draft.passportNo}
                  onChange={(event) => setDraft((d) => ({ ...d, passportNo: event.target.value }))}
                  className="input"
                />
              </Field>
              <Field label="พาสปอร์ตหมดอายุ">
                <input
                  type="date"
                  aria-label="พาสปอร์ตหมดอายุ"
                  value={draft.passportExpiry}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, passportExpiry: event.target.value }))
                  }
                  className="input tnum"
                />
              </Field>
              <Field label="เลขใบอนุญาตทำงาน">
                <input
                  type="text"
                  aria-label="เลขใบอนุญาตทำงาน"
                  value={draft.workPermitNo}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, workPermitNo: event.target.value }))
                  }
                  className="input"
                />
              </Field>
              <Field label="ใบอนุญาตหมดอายุ">
                <input
                  type="date"
                  aria-label="ใบอนุญาตหมดอายุ"
                  value={draft.workPermitExpiry}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, workPermitExpiry: event.target.value }))
                  }
                  className="input tnum"
                />
              </Field>
            </div>
          ) : null}

          <div className="mt-3 flex gap-3">
            <button
              type="submit"
              disabled={busy}
              className="btn h-12 bg-brand-600 px-8 text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {editingId ? 'บันทึกการแก้ไข' : 'เพิ่มพนักงาน'}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setEditingId(null);
              }}
              className="btn h-12 bg-slate-100 px-6 text-slate-700 hover:bg-slate-200"
            >
              ยกเลิก
            </button>
          </div>
        </form>
      ) : null}

      <ul className="space-y-2">
        {staff.map((person) => (
          <li
            key={person.id}
            className={`rounded-2xl p-4 ${
              person.status === StaffStatus.LEFT ? 'bg-slate-200/60' : 'bg-white'
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold">
                {person.fullName}
                {person.nickname ? (
                  <span className="ml-2 text-slate-500">({person.nickname})</span>
                ) : null}
              </span>
              <span className="rounded-lg bg-slate-100 px-2 py-1 text-sm">
                {ROLE_LABEL[person.role]}
              </span>
              <span className="text-sm text-slate-500">
                {STAFF_STATUS_LABEL[person.status]}
                {person.position ? ` · ${person.position}` : ''}
              </span>
              {person.isPinLocked ? (
                <span className="rounded-lg bg-red-100 px-2 py-1 text-sm font-semibold text-red-900">
                  PIN ถูกล็อก
                </span>
              ) : null}
              <ExpiryBadge label="ใบอนุญาตทำงาน" expiry={person.workPermitExpiry} today={today} />
              <ExpiryBadge label="พาสปอร์ต" expiry={person.passportExpiry} today={today} />

              <span className="tnum ml-auto text-lg">
                {formatSatang(person.wageRateSatang)}
                <span className="ml-1 text-sm text-slate-500">
                  {person.wageType === WageType.DAILY ? '/วัน' : '/เดือน'}
                </span>
              </span>

              {canWrite ? (
                <>
                  <button
                    type="button"
                    onClick={() => startEdit(person)}
                    className="btn h-11 bg-slate-100 px-4 text-slate-700 hover:bg-slate-200"
                  >
                    แก้ไข
                  </button>
                  <button
                    type="button"
                    onClick={() => void resetPin(person)}
                    disabled={busy}
                    className="btn h-11 bg-slate-100 px-4 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                  >
                    ตั้ง PIN ใหม่
                  </button>
                  {person.hasHistory ? (
                    // Not a disabled button: an explanation. Their name is on
                    // payslips and approved voids, and "ลาออก" is the exit.
                    <span className="text-sm text-slate-400">มีประวัติแล้ว ลบไม่ได้</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void remove(person)}
                      disabled={busy}
                      className="btn h-11 bg-red-50 px-4 text-red-800 hover:bg-red-100 disabled:opacity-50"
                    >
                      ลบ
                    </button>
                  )}
                </>
              ) : null}
            </div>
          </li>
        ))}
        {data && staff.length === 0 ? (
          <li className="rounded-2xl bg-white p-6 text-center text-slate-400">
            ยังไม่มีพนักงานในระบบ
          </li>
        ) : null}
      </ul>
    </StaffShell>
  );
}

/* ------------------------------------------------------------------ */

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-sm text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function blank(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

function emptyDraft(today: string): Draft {
  return {
    fullName: '',
    nickname: '',
    position: '',
    role: Role.STAFF,
    phone: '',
    startDate: today,
    endDate: '',
    status: StaffStatus.PROBATION,
    nationality: Nationality.TH,
    passportNo: '',
    passportExpiry: '',
    workPermitNo: '',
    workPermitExpiry: '',
    wageType: WageType.DAILY,
    wage: '',
    note: '',
    pin: '',
  };
}
