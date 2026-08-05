/**
 * ใบกำกับภาษีเต็มรูป and ใบลดหนี้.
 *
 * The tests that would hurt most if they were missing are all one rule: a full
 * tax invoice is issued ONCE, and the only way back out is a credit note. A
 * second number against the same sale, or a DELETE where a credit note should
 * have been, is not found by anybody until an audit.
 *
 * WHY THE VAT IS FAKED ONTO THE ORDER ROW rather than switched on at the
 * branch: the branch is shared with every other test file in the suite and
 * they all pay bills through it, so a real VAT switch here would make a
 * parallel file's cash bill total 7% more than it asserted. The behaviour
 * under test is "the bill's own snapshot decides", so writing the snapshot
 * directly is not a shortcut — it is the input.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OrderStatus, PaymentMethod, Role, type PaidBillListResponse } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, cleanupOrders, loginAs } from '../../test-helpers.js';

/** Valid check digits — see isValidThaiTaxId in @pos/shared. */
const SHOP_TAX_ID = '0105558123451';
const CUSTOMER_TAX_ID = '0105558123400';

const CUSTOMER = {
  customerName: 'บริษัท ทดสอบภาษี จำกัด',
  customerTaxId: CUSTOMER_TAX_ID,
  customerAddress: '1 ถนนพระราม 4 กรุงเทพฯ',
};

let app: FastifyInstance;
let owner: { staffId: string; cookie: string };
let manager: { staffId: string; cookie: string };
let staff: { staffId: string; cookie: string };
let branchId: string;
let originalTaxId: string | null;
let noodlesId: string;
let startedAt: Date;

const createdOrderIds: string[] = [];

/** Opens a takeaway bill, puts one bowl on it, and takes the money. */
async function paidBill(): Promise<{ id: string; totalSatang: number }> {
  const id = crypto.randomUUID();
  createdOrderIds.push(id);

  const opened = await app.inject({
    method: 'POST',
    url: '/api/orders',
    headers: { cookie: staff.cookie },
    payload: { id, channel: 'TAKEAWAY' },
  });
  expect(opened.statusCode).toBe(201);

  await app.inject({
    method: 'POST',
    url: `/api/orders/${id}/lines`,
    headers: { cookie: staff.cookie },
    payload: { id: crypto.randomUUID(), menuItemId: noodlesId, qty: 2 },
  });

  const order = await prisma.order.findUniqueOrThrow({ where: { id } });
  const paid = await app.inject({
    method: 'POST',
    url: `/api/orders/${id}/pay`,
    headers: { cookie: staff.cookie },
    payload: { method: PaymentMethod.CASH, receivedSatang: order.totalSatang + 10_000 },
  });
  expect(paid.statusCode).toBe(200);

  return { id, totalSatang: order.totalSatang };
}

/**
 * Rewrites the bill's VAT snapshot as if it had been rung up after
 * registration. 7% carved out of a VAT-inclusive price, exactly as
 * calculateVat would have done it.
 */
async function withVat(orderId: string): Promise<{ subtotal: number; vat: number; total: number }> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const vat = Math.round((order.totalSatang * 700) / 10_700);

  await prisma.order.update({
    where: { id: orderId },
    data: {
      vatRateBpSnapshot: 700,
      vatAmountSatang: vat,
      subtotalExVatSatang: order.totalSatang - vat,
      isVatInclusive: true,
    },
  });
  return { subtotal: order.totalSatang - vat, vat, total: order.totalSatang };
}

const issueTaxInvoice = (orderId: string, body = CUSTOMER, cookie = manager.cookie) =>
  app.inject({
    method: 'POST',
    url: `/api/bills/${orderId}/tax-invoice`,
    headers: { cookie },
    payload: body,
  });

const issueCreditNote = (orderId: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/bills/${orderId}/credit-note`,
    headers: { cookie: manager.cookie },
    payload: {
      reason: 'WRONG_CUSTOMER',
      note: 'ลูกค้าให้เลขผู้เสียภาษีผิด',
      approverStaffId: owner.staffId,
      approverPin: '1111',
      ...extra,
    },
  });

async function bills(cookie = staff.cookie): Promise<PaidBillListResponse> {
  const response = await app.inject({ method: 'GET', url: '/api/bills', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  app = await buildTestApp();
  owner = await loginAs(app, Role.OWNER);
  manager = await loginAs(app, Role.MANAGER);
  staff = await loginAs(app, Role.STAFF);
  startedAt = new Date();

  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;
  originalTaxId = branch.taxId;
  // The shop's own tax id is required on a tax invoice and is NOT the VAT
  // switch, so setting it changes nothing another test file relies on.
  await prisma.branch.update({ where: { id: branchId }, data: { taxId: SHOP_TAX_ID } });

  const menu = await app.inject({
    method: 'GET',
    url: '/api/menu',
    headers: { cookie: staff.cookie },
  });
  noodlesId = menu.json().categories[0].items[0].id;
});

afterEach(async () => {
  await cleanupOrders(createdOrderIds);
  createdOrderIds.length = 0;
  await prisma.auditLog.deleteMany({
    where: {
      action: { in: ['ISSUE_TAX_INVOICE', 'ISSUE_CREDIT_NOTE'] },
      createdAt: { gte: startedAt },
    },
  });
});

afterAll(async () => {
  await prisma.branch.update({ where: { id: branchId }, data: { taxId: originalTaxId } });
  await app.close();
});

describe('who may issue a tax document', () => {
  it('lets a cashier read the day’s bills but not issue anything', async () => {
    const bill = await paidBill();
    await withVat(bill.id);

    // The cashier is who the customer walks back to, so they must be able to
    // find the bill — but a full tax invoice is not a receipt reprint.
    expect((await bills(staff.cookie)).rows.some((row) => row.id === bill.id)).toBe(true);
    expect((await issueTaxInvoice(bill.id, CUSTOMER, staff.cookie)).statusCode).toBe(403);
  });
});

describe('the day’s closed bills', () => {
  it('lists a paid bill with its receipt number and item count', async () => {
    const bill = await paidBill();
    const row = (await bills()).rows.find((candidate) => candidate.id === bill.id);

    expect(row?.receiptNo).toMatch(/^RC-/);
    expect(row?.status).toBe(OrderStatus.PAID);
    expect(row?.itemCount).toBe(1);
    expect(row?.taxInvoiceNo).toBeNull();
  });
});

describe('issuing a full tax invoice', () => {
  it('numbers it, stores the buyer, and leaves an audit trail', async () => {
    const bill = await paidBill();
    const amounts = await withVat(bill.id);

    const response = await issueTaxInvoice(bill.id);
    expect(response.statusCode).toBe(201);

    const { taxInvoice } = response.json();
    expect(taxInvoice.taxInvoiceNo).toMatch(/^TX-[A-Z0-9]+-\d{4}-\d{6}$/);
    expect(taxInvoice.customerTaxId).toBe(CUSTOMER_TAX_ID);
    // สำนักงานใหญ่ by default — required on the document, and meaningless to
    // almost everyone who has to type it.
    expect(taxInvoice.customerBranchLabel).toBe('สำนักงานใหญ่');
    expect(taxInvoice.vatAmountSatang).toBe(amounts.vat);
    expect(taxInvoice.subtotalExVatSatang).toBe(amounts.subtotal);

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: bill.id } });
    expect(stored.taxInvoiceNo).toBe(taxInvoice.taxInvoiceNo);
    expect(stored.taxInvoiceIssuedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ISSUE_TAX_INVOICE', entityId: bill.id },
    });
    expect((audit.after as { customerName: string }).customerName).toBe(CUSTOMER.customerName);
  });

  it('never issues a second one for the same sale', async () => {
    // The rule the whole file exists for. Two numbered tax invoices for one
    // sale is two customers able to claim the same input VAT.
    const bill = await paidBill();
    await withVat(bill.id);
    const first = await issueTaxInvoice(bill.id);
    expect(first.statusCode).toBe(201);

    const second = await issueTaxInvoice(bill.id);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('TAX_INVOICE_EXISTS');
    expect(second.json().message).toContain(first.json().taxInvoice.taxInvoiceNo);
  });

  it('refuses a bill that was closed before the shop charged VAT', async () => {
    const bill = await paidBill();
    const response = await issueTaxInvoice(bill.id);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ORDER_HAS_NO_VAT');
  });

  it('refuses a customer tax id whose check digit is wrong', async () => {
    const bill = await paidBill();
    await withVat(bill.id);

    const response = await issueTaxInvoice(bill.id, {
      ...CUSTOMER,
      customerTaxId: '0105558123401',
    });
    expect(response.statusCode).toBe(400);
    // Nothing was numbered on the way to the refusal.
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })).taxInvoiceNo,
    ).toBeNull();
  });

  it('refuses a bill that has not been paid', async () => {
    const id = crypto.randomUUID();
    createdOrderIds.push(id);
    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { cookie: staff.cookie },
      payload: { id, channel: 'TAKEAWAY' },
    });

    const response = await issueTaxInvoice(id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('ORDER_NOT_PAID');
  });
});

describe('the credit note', () => {
  it('reverses the sale, keeps both document numbers, and names the approver', async () => {
    const bill = await paidBill();
    const amounts = await withVat(bill.id);
    const invoice = await issueTaxInvoice(bill.id);
    const taxInvoiceNo = invoice.json().taxInvoice.taxInvoiceNo;

    const response = await issueCreditNote(bill.id);
    expect(response.statusCode).toBe(201);

    const { creditNote } = response.json();
    expect(creditNote.creditNoteNo).toMatch(/^CN-[A-Z0-9]+-\d{4}-\d{6}$/);
    // The pairing IS the document: an auditor holding one must find the other.
    expect(creditNote.taxInvoiceNo).toBe(taxInvoiceNo);
    expect(creditNote.totalSatang).toBe(amounts.total);
    expect(creditNote.approvedByName).toBeTruthy();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: bill.id } });
    expect(order.status).toBe(OrderStatus.CANCELLED);
    // The numbers stay: a document number that vanished is a number nobody
    // can account for.
    expect(order.taxInvoiceNo).toBe(taxInvoiceNo);
    expect(order.receiptNo).not.toBeNull();
  });

  it('takes the sale out of the day it was taken and reports the refund on the day it was given', async () => {
    const bill = await paidBill();
    await withVat(bill.id);

    const before = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: manager.cookie },
    });
    const salesBefore = before.json().netSalesSatang;

    await issueCreditNote(bill.id, { reason: 'RETURNED', note: null });

    const after = await app.inject({
      method: 'GET',
      url: '/api/reports/daily',
      headers: { cookie: manager.cookie },
    });
    expect(after.json().netSalesSatang).toBeLessThan(salesBefore);
    expect(after.json().creditNoteCount).toBe(1);
  });

  it('refuses a second credit note for the same bill', async () => {
    const bill = await paidBill();
    await withVat(bill.id);
    expect((await issueCreditNote(bill.id)).statusCode).toBe(201);

    const second = await issueCreditNote(bill.id);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('CREDIT_NOTE_EXISTS');
  });

  it('refuses to issue a fresh tax invoice on a bill that was credited', async () => {
    const bill = await paidBill();
    await withVat(bill.id);
    expect((await issueCreditNote(bill.id)).statusCode).toBe(201);

    const response = await issueTaxInvoice(bill.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('ยกเลิก');
  });

  it('refuses without a supervisor PIN, and refuses self-approval', async () => {
    const bill = await paidBill();
    await withVat(bill.id);

    const wrongPin = await issueCreditNote(bill.id, { approverPin: '9999' });
    expect(wrongPin.statusCode).toBe(401);

    // Cancelling a completed sale is the one thing a cashier can do that makes
    // a whole bill disappear, so it is never self-served (rule #8).
    const self = await app.inject({
      method: 'POST',
      url: `/api/bills/${bill.id}/credit-note`,
      headers: { cookie: manager.cookie },
      payload: {
        reason: 'WRONG_BILL',
        approverStaffId: manager.staffId,
        approverPin: '2222',
      },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error).toBe('SELF_APPROVAL');

    // Neither refusal burned a credit note number or touched the sale.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe(
      OrderStatus.PAID,
    );
  });

  it('requires words when the reason is "อื่น ๆ"', async () => {
    const bill = await paidBill();
    const response = await issueCreditNote(bill.id, { reason: 'OTHER', note: null });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('REASON_REQUIRED');
  });

  it('works on a plain bill that never had a tax invoice', async () => {
    const bill = await paidBill();
    const response = await issueCreditNote(bill.id, { reason: 'WRONG_BILL', note: null });

    expect(response.statusCode).toBe(201);
    expect(response.json().creditNote.taxInvoiceNo).toBeNull();
    expect(response.json().creditNote.receiptNo).toMatch(/^RC-/);
  });

  it('shows the reversed bill on the bill list instead of hiding it', async () => {
    const bill = await paidBill();
    await withVat(bill.id);
    await issueCreditNote(bill.id);

    // A credited bill vanishing from the screen looks exactly like a bill
    // somebody deleted.
    const row = (await bills()).rows.find((candidate) => candidate.id === bill.id);
    expect(row?.status).toBe(OrderStatus.CANCELLED);
    expect(row?.creditNoteNo).toMatch(/^CN-/);
  });
});
