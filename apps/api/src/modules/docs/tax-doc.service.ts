/**
 * ใบกำกับภาษีเต็มรูป and ใบลดหนี้ (Step 10).
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a full tax invoice is issued once,
 * and the only way back out is a credit note.
 *
 * A ใบกำกับภาษีเต็มรูป names the buyer and their tax id, and the buyer uses it
 * to claim the input VAT back. The moment it leaves the printer the shop
 * cannot edit it, cannot reissue it, and cannot delete the sale (project rule:
 * ห้ามลบบิลที่ออกใบกำกับภาษีแล้ว — ต้องออกใบลดหนี้แทน). So:
 *
 *  - it may only be issued against a PAID bill that actually carried VAT;
 *  - it may only be issued ONCE, and a second attempt returns the number that
 *    already exists rather than allocating another;
 *  - it is ONLINE ONLY (rule #9) — two offline tablets would hand the same
 *    number to two different customers, and unlike a duplicated receipt number
 *    that is a duplicated tax document;
 *  - undoing it means a numbered credit note with a reason and a supervisor's
 *    name on it, never a DELETE.
 *
 * WHAT A CREDIT NOTE DOES TO THE MONEY, stated plainly because it is a real
 * decision and not an obvious one: the order goes to CANCELLED, so the sale
 * drops out of the day it was taken. A bill paid on the 30th and credited on
 * the 1st therefore lowers the 30th's takings, not the 1st's. That is the
 * honest answer for a cash-basis shop — the money was given back, so it was
 * never income — and it means every existing report is correct with no
 * special-casing. The cost is that a report printed before the credit note no
 * longer matches one printed after, which is why the credit note carries its
 * own business date and its own number: the DOCUMENT trail says when it
 * happened even though the SALES figure moved.
 */

import { Prisma } from '@prisma/client';
import type { Branch, PrismaClient } from '@prisma/client';
import {
  buildCreditNote,
  buildTaxInvoice,
  creditNoteReasonLabel,
  DocType,
  HEAD_OFFICE_LABEL,
  OrderStatus,
  PrintJobType,
  WIDTH_80MM,
  CHANNEL_LABEL,
  type CreditNoteDto,
  type CreditNoteRequest,
  type PaidBillListResponse,
  type TaxInvoiceDto,
  type TaxInvoiceRequest,
} from '@pos/shared';
import { badRequest, conflict, notFound } from '../../http-error.js';
import { verifyApproval, VOID_APPROVAL } from '../auth/approval.service.js';
import {
  billLinesOf,
  ORDER_INCLUDE,
  shopHeaderOf,
  vatConfigOf,
  type Actor,
} from '../orders/order.service.js';
import {
  branchBusinessDate,
  formatDateColumn,
  toDateColumn,
  type OrderWithLines,
} from '../orders/order.mapper.js';
import type { PrintService } from '../print/print.service.js';
import { allocateDocNumber } from './doc-sequence.service.js';

type OrderWithCreditNote = OrderWithLines & {
  creditNote: { creditNoteNo: string } | null;
};

export class TaxDocService {
  constructor(
    private readonly db: PrismaClient,
    private readonly print: PrintService,
  ) {}

  /**
   * The day's closed bills.
   *
   * Exists for one sentence a customer says a minute after paying: "ขอใบกำกับ
   * ภาษีด้วยครับ". Before this screen a paid bill was unreachable — the table
   * had been cleared and the order screen only knows OPEN bills.
   *
   * CANCELLED bills are listed too, greyed, because a bill that was credited
   * disappearing from the screen looks exactly like a bill that was deleted.
   */
  async listPaidBills(branch: Branch, businessDate: string): Promise<PaidBillListResponse> {
    const orders = await this.db.order.findMany({
      where: {
        branchId: branch.id,
        businessDate: toDateColumn(businessDate),
        status: { in: [OrderStatus.PAID, OrderStatus.CANCELLED] },
        paidAt: { not: null },
      },
      include: {
        table: { select: { name: true } },
        creditNote: { select: { creditNoteNo: true } },
      },
      orderBy: { paidAt: 'desc' },
    });

    const counts = await this.db.orderLine.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orders.map((order) => order.id) }, voidedAt: null },
      _count: { _all: true },
    });
    const itemCounts = new Map(counts.map((row) => [row.orderId, row._count._all]));

    return {
      businessDate,
      vatActive: vatConfigOf(branch, businessDate).enabled,
      rows: orders.map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        receiptNo: order.receiptNo,
        tableName: order.table?.name ?? null,
        channel: CHANNEL_LABEL[order.channel],
        paidAt: order.paidAt?.toISOString() ?? null,
        status: order.status,

        totalSatang: order.totalSatang,
        vatAmountSatang: order.vatAmountSatang,
        vatRateBpSnapshot: order.vatRateBpSnapshot,
        itemCount: itemCounts.get(order.id) ?? 0,

        taxInvoiceNo: order.taxInvoiceNo,
        customerName: order.customerName,
        creditNoteNo: order.creditNote?.creditNoteNo ?? null,
      })),
    };
  }

  /**
   * Issues the full tax invoice.
   *
   * Everything is checked BEFORE a number is allocated: a number burned on a
   * refused request leaves a gap an auditor asks about, and while gaps are
   * legal, "we validated after we numbered" is not a sentence anyone wants to
   * say out loud.
   */
  async issueTaxInvoice(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: TaxInvoiceRequest,
  ): Promise<{ taxInvoice: TaxInvoiceDto; printJobId: string | null }> {
    const order = await this.requireOrder(branch, orderId);

    if (order.taxInvoiceNo) {
      throw conflict(
        'TAX_INVOICE_EXISTS',
        `บิลนี้ออกใบกำกับภาษีไปแล้ว เลขที่ ${order.taxInvoiceNo} — ถ้าผิดต้องออกใบลดหนี้แล้วออกใบใหม่`,
      );
    }
    if (order.status !== OrderStatus.PAID) {
      throw conflict(
        'ORDER_NOT_PAID',
        order.status === OrderStatus.CANCELLED
          ? 'บิลนี้ถูกยกเลิกไปแล้ว ออกใบกำกับภาษีไม่ได้'
          : 'ออกใบกำกับภาษีได้เฉพาะบิลที่รับเงินแล้ว',
      );
    }
    if (!branch.taxId) {
      throw badRequest(
        'SHOP_TAX_ID_MISSING',
        'ร้านยังไม่ได้กรอกเลขประจำตัวผู้เสียภาษี — ใส่ในหน้าตั้งค่าสาขาก่อน',
      );
    }
    // The bill's own snapshot decides, not the switch: a bill closed before
    // registration took effect carries 0% forever and can never become the
    // basis of a tax invoice, no matter what the settings say today.
    if (order.vatRateBpSnapshot <= 0) {
      throw conflict(
        'ORDER_HAS_NO_VAT',
        'บิลนี้ปิดตอนที่ร้านยังไม่ได้คิด VAT — ออกใบกำกับภาษีเต็มรูปไม่ได้',
      );
    }

    const businessDate = formatDateColumn(order.businessDate);
    const issuedAt = new Date();

    const saved = await this.db.$transaction(async (tx) => {
      const taxInvoiceNo = await allocateDocNumber(
        tx,
        branch,
        DocType.TAX_INVOICE,
        Number(businessDate.slice(0, 4)),
      );

      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          taxInvoiceNo,
          taxInvoiceIssuedAt: issuedAt,
          customerName: input.customerName,
          customerTaxId: input.customerTaxId,
          customerAddress: input.customerAddress,
          customerBranchLabel: input.customerBranchLabel,
        },
      });

      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actor.staffId,
          action: 'ISSUE_TAX_INVOICE',
          entityType: 'Order',
          entityId: order.id,
          before: Prisma.JsonNull,
          after: {
            taxInvoiceNo,
            receiptNo: order.receiptNo,
            customerName: input.customerName,
            customerTaxId: input.customerTaxId,
            totalSatang: order.totalSatang,
          },
        },
      });

      return updated;
    });

    const document = buildTaxInvoice({
      shop: shopHeaderOf(branch),
      taxInvoiceNo: saved.taxInvoiceNo as string,
      receiptNo: order.receiptNo,
      orderNo: order.orderNo,
      tableName: order.table?.name ?? null,
      channelLabel: CHANNEL_LABEL[order.channel],
      openedAt: order.openedAt,
      printedAt: issuedAt,
      issuedAt,
      staffName: actor.fullName,
      customer: {
        name: input.customerName,
        taxId: input.customerTaxId,
        address: input.customerAddress,
        branchLabel: input.customerBranchLabel || HEAD_OFFICE_LABEL,
      },
      lines: billLinesOf(order),
      totals: {
        subtotalExVatSatang: order.subtotalExVatSatang,
        vatAmountSatang: order.vatAmountSatang,
        vatRateBpSnapshot: order.vatRateBpSnapshot,
        totalSatang: order.totalSatang,
        isVatInclusive: order.isVatInclusive,
        // A full tax invoice must show the discount, not just a smaller total:
        // the line prices are printed above it and the buyer's accountant has
        // to be able to add them up and reach the figure at the bottom.
        discountSatang: order.discountSatang,
        grossSatang: order.totalSatang + order.discountSatang,
      },
      width: input.width ?? WIDTH_80MM,
    });

    const printJobId = await this.enqueueQuietly(branch.id, input.station, document, order.id);

    return {
      taxInvoice: {
        orderId: order.id,
        taxInvoiceNo: saved.taxInvoiceNo as string,
        receiptNo: order.receiptNo,
        issuedAt: issuedAt.toISOString(),
        customerName: input.customerName,
        customerTaxId: input.customerTaxId,
        customerAddress: input.customerAddress,
        customerBranchLabel: input.customerBranchLabel || HEAD_OFFICE_LABEL,
        businessDate,
        subtotalExVatSatang: order.subtotalExVatSatang,
        vatAmountSatang: order.vatAmountSatang,
        vatRateBpSnapshot: order.vatRateBpSnapshot,
        totalSatang: order.totalSatang,
      },
      printJobId,
    };
  }

  /**
   * Cancels a completed sale and issues the ใบลดหนี้ that documents it.
   *
   * The supervisor PIN is verified OUTSIDE the transaction (bcrypt costs
   * ~100ms and a Postgres transaction held open that long, at the counter,
   * during a rush, is how a till starts feeling slow) and the whole reversal
   * then happens inside one.
   */
  async issueCreditNote(
    branch: Branch,
    actor: Actor,
    orderId: string,
    input: CreditNoteRequest,
  ): Promise<{ creditNote: CreditNoteDto; printJobId: string | null }> {
    const order = await this.requireOrder(branch, orderId);

    if (order.creditNote) {
      throw conflict(
        'CREDIT_NOTE_EXISTS',
        `บิลนี้ออกใบลดหนี้ไปแล้ว เลขที่ ${order.creditNote.creditNoteNo}`,
      );
    }
    if (order.status !== OrderStatus.PAID) {
      throw conflict('ORDER_NOT_PAID', 'ออกใบลดหนี้ได้เฉพาะบิลที่รับเงินแล้ว');
    }
    if (input.reason === 'OTHER' && !input.note) {
      throw badRequest('REASON_REQUIRED', 'เลือก "อื่น ๆ" ต้องพิมพ์เหตุผลด้วย');
    }

    const approver = await verifyApproval(this.db, {
      branchId: branch.id,
      requestedByStaffId: actor.staffId,
      approverStaffId: input.approverStaffId,
      approverPin: input.approverPin,
      permission: VOID_APPROVAL,
      what: 'การยกเลิกบิลที่รับเงินแล้ว',
    });

    const originalBusinessDate = formatDateColumn(order.businessDate);
    // The credit note belongs to the day it is ISSUED, which is often not the
    // day of the sale and is occasionally not even the same month.
    const businessDate = branchBusinessDate(branch);
    const issuedAt = new Date();

    const saved = await this.db.$transaction(async (tx) => {
      const creditNoteNo = await allocateDocNumber(
        tx,
        branch,
        DocType.CREDIT_NOTE,
        Number(businessDate.slice(0, 4)),
      );

      const row = await tx.creditNote.create({
        data: {
          branchId: branch.id,
          orderId: order.id,
          creditNoteNo,
          taxInvoiceNo: order.taxInvoiceNo,
          receiptNo: order.receiptNo,
          businessDate: toDateColumn(businessDate),
          subtotalExVatSatang: order.subtotalExVatSatang,
          vatAmountSatang: order.vatAmountSatang,
          vatRateBpSnapshot: order.vatRateBpSnapshot,
          totalSatang: order.totalSatang,
          reason: input.reason,
          note: input.note,
          issuedByStaffId: actor.staffId,
          approvedByStaffId: approver.staffId,
          issuedAt,
        },
      });

      // The sale is taken back out of the day it was taken. The receipt and
      // tax invoice numbers stay on the order: the documents exist, and a
      // number that vanished is a number an auditor cannot account for.
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED },
      });

      await tx.auditLog.create({
        data: {
          branchId: branch.id,
          staffId: actor.staffId,
          action: 'ISSUE_CREDIT_NOTE',
          entityType: 'Order',
          entityId: order.id,
          before: {
            status: OrderStatus.PAID,
            receiptNo: order.receiptNo,
            taxInvoiceNo: order.taxInvoiceNo,
            totalSatang: order.totalSatang,
          },
          after: {
            status: OrderStatus.CANCELLED,
            creditNoteNo,
            reason: input.reason,
            note: input.note,
            approvedBy: approver.fullName,
          },
        },
      });

      return row;
    });

    const totals = {
      subtotalExVatSatang: order.subtotalExVatSatang,
      vatAmountSatang: order.vatAmountSatang,
      vatRateBpSnapshot: order.vatRateBpSnapshot,
      totalSatang: order.totalSatang,
      isVatInclusive: order.isVatInclusive,
      discountSatang: order.discountSatang,
      grossSatang: order.totalSatang + order.discountSatang,
    };

    const document = buildCreditNote({
      shop: shopHeaderOf(branch),
      creditNoteNo: saved.creditNoteNo,
      taxInvoiceNo: order.taxInvoiceNo,
      receiptNo: order.receiptNo,
      orderNo: order.orderNo,
      issuedAt,
      originalPaidAt: order.paidAt ?? order.openedAt,
      customer:
        order.taxInvoiceNo && order.customerName && order.customerTaxId
          ? {
              name: order.customerName,
              taxId: order.customerTaxId,
              address: order.customerAddress,
              branchLabel: order.customerBranchLabel ?? HEAD_OFFICE_LABEL,
            }
          : null,
      reasonLabel: creditNoteReasonLabel(input.reason),
      note: input.note,
      approvedBy: approver.fullName,
      totals,
      width: input.width ?? WIDTH_80MM,
    });

    const printJobId = await this.enqueueQuietly(branch.id, input.station, document, order.id);

    return {
      creditNote: {
        id: saved.id,
        orderId: order.id,
        creditNoteNo: saved.creditNoteNo,
        taxInvoiceNo: saved.taxInvoiceNo,
        receiptNo: saved.receiptNo,
        businessDate,
        originalBusinessDate,
        subtotalExVatSatang: saved.subtotalExVatSatang,
        vatAmountSatang: saved.vatAmountSatang,
        totalSatang: saved.totalSatang,
        reason: saved.reason,
        note: saved.note,
        issuedByName: actor.fullName,
        approvedByName: approver.fullName,
        issuedAt: issuedAt.toISOString(),
      },
      printJobId,
    };
  }

  private async requireOrder(branch: Branch, orderId: string): Promise<OrderWithCreditNote> {
    const order = await this.db.order.findFirst({
      where: { id: orderId, branchId: branch.id },
      include: { ...ORDER_INCLUDE, creditNote: { select: { creditNoteNo: true } } },
    });
    if (!order) throw notFound('ORDER_NOT_FOUND', 'ไม่พบบิลนี้');
    return order;
  }

  /**
   * Queues the print AFTER the document is committed, and never lets a printer
   * roll one back.
   *
   * The tax invoice and the credit note are legal documents the moment the row
   * exists. A jammed printer must show as "พิมพ์ไม่ออก", never as "the document
   * was not issued" — the number has been handed out either way, and the paper
   * can be reprinted from the bill list.
   */
  private async enqueueQuietly(
    branchId: string,
    station: string | undefined,
    document: Parameters<PrintService['enqueue']>[0]['document'],
    orderId: string,
  ): Promise<string | null> {
    try {
      const job = await this.print.enqueue({
        branchId,
        station: station ?? 'counter',
        type: PrintJobType.RECEIPT,
        document,
        orderId,
      });
      return job.id;
    } catch {
      return null;
    }
  }
}
