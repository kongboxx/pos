/**
 * Branch settings and the VAT switch (Step 10).
 *
 * THE THREE REFUSALS IN HERE, in order of what they cost when missing:
 *
 *  1. THE BRANCH CODE FREEZES ONCE A DOCUMENT CARRIES IT. Document numbers are
 *     `TX-HQ-2026-000001` (rule #9) and the sequence counter is keyed by
 *     (branch, docType, year) — NOT by the code. Rename HQ to MAIN halfway
 *     through the year and the same unbroken series is suddenly printed under
 *     two names, so "show me this branch's tax invoices for 2026" has no
 *     answer that adds up. The branch NAME is free to change any time; it is
 *     decoration on a slip.
 *
 *  2. VAT CANNOT BE SWITCHED ON BACKWARDS. `vatEffectiveDate` cannot be set
 *     earlier than a bill that has already been paid without VAT, because that
 *     bill's snapshot says 0% and every report re-reads the effective date.
 *     The two would disagree, and the direction they disagree in is "the shop
 *     collected VAT it never remitted".
 *
 *  3. A BRANCH CANNOT BE DEACTIVATED WITH MONEY STILL ON ITS TABLES. Closing
 *     it hides it from login, and an OPEN bill on a hidden branch is food that
 *     was served and can never be charged for.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import type { Branch, PrismaClient } from '@prisma/client';
import {
  OrderStatus,
  Role,
  StaffStatus,
  type BranchCreateRequest,
  type BranchDto,
  type BranchSettingsRequest,
  type BusinessDate,
} from '@pos/shared';
import { conflict, notFound } from '../../http-error.js';
import { branchBusinessDate, formatDateColumn, toDateColumn } from '../orders/order.mapper.js';
import { PIN_SALT_ROUNDS } from '../staff/staff.service.js';

export interface BranchCounts {
  activeStaff: number;
  hasDocuments: boolean;
}

export class BranchService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Every branch the owner has, with the two facts the screen needs to grey a
   * field out honestly rather than accepting a change and then rejecting it.
   */
  async list(currentBranch: Branch): Promise<{ branches: BranchDto[]; today: BusinessDate }> {
    const branches = await this.db.branch.findMany({ orderBy: { createdAt: 'asc' } });

    const [staffCounts, sequences] = await Promise.all([
      this.db.staff.groupBy({
        by: ['branchId'],
        where: { status: { not: StaffStatus.LEFT } },
        _count: { _all: true },
      }),
      this.db.docSequence.findMany({
        where: { lastNumber: { gt: 0 } },
        select: { branchId: true },
      }),
    ]);

    const staffByBranch = new Map(staffCounts.map((row) => [row.branchId, row._count._all]));
    const numbered = new Set(sequences.map((row) => row.branchId));

    return {
      today: branchBusinessDate(currentBranch),
      branches: branches.map((branch) =>
        toBranchDto(branch, {
          activeStaff: staffByBranch.get(branch.id) ?? 0,
          hasDocuments: numbered.has(branch.id),
        }),
      ),
    };
  }

  async requireBranch(branchId: string): Promise<Branch> {
    const branch = await this.db.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw notFound('BRANCH_NOT_FOUND', 'ไม่พบสาขานี้');
    return branch;
  }

  /**
   * Opens a new shop, together with the one person who can log into it.
   *
   * Both in one transaction because a branch with no staff is a branch nobody
   * can open: the login screen lists that branch's staff, and an empty list is
   * a dead end whose only exit is a database edit.
   */
  async create(input: BranchCreateRequest, actorStaffId: string): Promise<BranchDto> {
    const code = input.branchCode.toUpperCase();
    const clash = await this.db.branch.findUnique({ where: { branchCode: code } });
    if (clash) {
      throw conflict('BRANCH_CODE_TAKEN', `รหัสสาขา ${code} ถูกใช้แล้วโดย ${clash.name}`);
    }

    const pinHash = await bcrypt.hash(input.ownerPin, PIN_SALT_ROUNDS);

    return this.db.$transaction(async (tx) => {
      const branch = await tx.branch.create({
        data: {
          name: input.name,
          branchCode: code,
          businessType: input.businessType,
          timezone: input.timezone,
          dayCutoffHour: input.dayCutoffHour,
        },
      });

      const today = branchBusinessDate(branch);

      await tx.staff.create({
        data: {
          branchId: branch.id,
          fullName: input.ownerFullName,
          nickname: input.ownerNickname,
          role: Role.OWNER,
          pinHash,
          startDate: toDateColumn(today),
          status: StaffStatus.ACTIVE,
        },
      });

      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actorStaffId,
          action: 'CREATE_BRANCH',
          entityType: 'Branch',
          entityId: branch.id,
          before: Prisma.JsonNull,
          after: { name: branch.name, branchCode: branch.branchCode, owner: input.ownerFullName },
        },
      });

      return toBranchDto(branch, { activeStaff: 1, hasDocuments: false });
    });
  }

  async update(
    branchId: string,
    input: BranchSettingsRequest,
    actorStaffId: string,
    actorBranchId: string,
  ): Promise<BranchDto> {
    const before = await this.requireBranch(branchId);

    await this.assertVatDateNotBackdated(before, input);
    await this.assertCanClose(before, input);

    const updated = await this.db.$transaction(async (tx) => {
      const branch = await tx.branch.update({
        where: { id: branchId },
        data: {
          name: input.name,
          businessType: input.businessType,
          address: input.address,
          phone: input.phone,
          taxId: input.taxId,
          timezone: input.timezone,
          dayCutoffHour: input.dayCutoffHour,
          vatEnabled: input.vatEnabled,
          vatRateBp: input.vatEnabled ? input.vatRateBp : 0,
          priceIncludesVat: input.priceIncludesVat,
          vatEffectiveDate: input.vatEffectiveDate ? toDateColumn(input.vatEffectiveDate) : null,
          rentPerMonthSatang: input.rentPerMonthSatang,
          promptPayId: input.promptPayId,
          qrOrderingEnabled: input.qrOrderingEnabled,
          isActive: input.isActive,
        },
      });

      // Written against the ACTOR's branch, not the edited one: the audit log
      // is read per branch, and "who changed branch 2's VAT" is a question
      // asked at the branch the owner was sitting in when they did it.
      await tx.auditLog.create({
        data: {
          branchId: actorBranchId,
          staffId: actorStaffId,
          action: 'UPDATE_BRANCH',
          entityType: 'Branch',
          entityId: branchId,
          before: branchAuditShape(before),
          after: branchAuditShape(branch),
        },
      });

      return branch;
    });

    const [activeStaff, numbered] = await Promise.all([
      this.db.staff.count({ where: { branchId, status: { not: StaffStatus.LEFT } } }),
      this.db.docSequence.count({ where: { branchId, lastNumber: { gt: 0 } } }),
    ]);

    return toBranchDto(updated, { activeStaff, hasDocuments: numbered > 0 });
  }

  /**
   * Refuses a VAT start date that lands on top of bills already settled
   * without VAT.
   *
   * The bills themselves are safe — they carry their own snapshot (rule #3) —
   * but every report re-reads the effective date to decide what a day's takings
   * mean, so the two would tell different stories about the same money. The
   * one that matters is the story the Revenue Department reads.
   */
  private async assertVatDateNotBackdated(
    before: Branch,
    input: BranchSettingsRequest,
  ): Promise<void> {
    if (!input.vatEnabled || !input.vatEffectiveDate) return;
    const wasAlready =
      before.vatEnabled &&
      before.vatEffectiveDate &&
      formatDateColumn(before.vatEffectiveDate) === input.vatEffectiveDate;
    if (wasAlready) return;

    const earliest = await this.db.order.findFirst({
      where: {
        branchId: before.id,
        status: OrderStatus.PAID,
        businessDate: { gte: toDateColumn(input.vatEffectiveDate) },
        vatRateBpSnapshot: 0,
      },
      orderBy: { businessDate: 'asc' },
      select: { businessDate: true, receiptNo: true },
    });
    if (!earliest) return;

    throw conflict(
      'VAT_DATE_BACKDATED',
      `มีบิลที่ปิดไปแล้วโดยไม่คิด VAT ตั้งแต่วันที่ ${formatDateColumn(earliest.businessDate)}` +
        ` (${earliest.receiptNo ?? 'ไม่มีเลขที่'}) — วันเริ่ม VAT ต้องเป็นวันที่ยังไม่มีการขาย`,
    );
  }

  /** A closed branch disappears from login; an open bill on it can never be charged. */
  private async assertCanClose(before: Branch, input: BranchSettingsRequest): Promise<void> {
    if (input.isActive || !before.isActive) return;

    const open = await this.db.order.count({
      where: { branchId: before.id, status: OrderStatus.OPEN },
    });
    if (open > 0) {
      throw conflict(
        'BRANCH_HAS_OPEN_BILLS',
        `สาขานี้ยังมีบิลค้างอยู่ ${open} ใบ — เก็บเงินหรือยกเลิกให้หมดก่อนปิดสาขา`,
      );
    }
  }
}

export function toBranchDto(branch: Branch, counts: BranchCounts): BranchDto {
  return {
    id: branch.id,
    name: branch.name,
    branchCode: branch.branchCode,
    businessType: branch.businessType,
    address: branch.address,
    phone: branch.phone,
    taxId: branch.taxId,

    timezone: branch.timezone,
    dayCutoffHour: branch.dayCutoffHour,

    vatEnabled: branch.vatEnabled,
    vatRateBp: branch.vatRateBp,
    priceIncludesVat: branch.priceIncludesVat,
    vatEffectiveDate: branch.vatEffectiveDate ? formatDateColumn(branch.vatEffectiveDate) : null,

    rentPerMonthSatang: branch.rentPerMonthSatang,
    promptPayId: branch.promptPayId,
    qrOrderingEnabled: branch.qrOrderingEnabled,
    isActive: branch.isActive,

    activeStaffCount: counts.activeStaff,
    hasDocuments: counts.hasDocuments,
  };
}

/** The settings worth being able to reconstruct from the audit log. */
function branchAuditShape(branch: Branch): Prisma.InputJsonValue {
  return {
    name: branch.name,
    branchCode: branch.branchCode,
    taxId: branch.taxId,
    vatEnabled: branch.vatEnabled,
    vatRateBp: branch.vatRateBp,
    priceIncludesVat: branch.priceIncludesVat,
    vatEffectiveDate: branch.vatEffectiveDate ? formatDateColumn(branch.vatEffectiveDate) : null,
    dayCutoffHour: branch.dayCutoffHour,
    rentPerMonthSatang: branch.rentPerMonthSatang,
    qrOrderingEnabled: branch.qrOrderingEnabled,
    isActive: branch.isActive,
  };
}
