/**
 * Thin API client.
 *
 * `credentials: 'include'` on every call because the session lives in an
 * httpOnly cookie — the token is never readable from JS, so an XSS on the QR
 * customer page cannot steal a staff session.
 *
 * Network errors are returned, not thrown, so callers are forced to think
 * about the offline case instead of letting a rejected promise bubble up.
 * `offline: true` means fetch itself failed (no connection); anything else is
 * a real answer from the server. Step 4 turns that flag into the sync queue.
 */

import type {
  BranchChoiceList,
  ClearDiscountRequest,
  CloseShiftRequest,
  CurrentShiftResponse,
  CreditNoteRequest,
  CreditNoteResponse,
  DbHealthResponse,
  DiscountRequest,
  OpenShiftRequest,
  ShiftDto,
  ShiftListResponse,
  HealthResponse,
  KitchenBoardResponse,
  KitchenTicketDto,
  MeResponse,
  MergeBillsRequest,
  MoveTableRequest,
  SplitBillRequest,
  MenuResponse,
  PaidBillListResponse,
  TaxInvoiceRequest,
  TaxInvoiceResponse,
  OrderDto,
  PayOrderRequest,
  PayOrderResponse,
  PendingApprovalResponse,
  PrintJobStatusResponse,
  QrBillDto,
  QrSubmitRequest,
  QrSubmitResponse,
  QrTableResponse,
  ReceiptDoc,
  SessionUser,
  StaffPublic,
  TableDto,
  VoidLineRequest,
} from '@pos/shared';
import { createHttp, type ApiResult, type PinCredentials } from '@pos/web-kit';

const API_BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api';

const http = createHttp(API_BASE);
// No `put` or `del`: those two verbs only ever appeared on management calls,
// which now live in api-office.ts. The till's own deletes — removing a line
// from a bill, clearing a discount — carry a body, so they go through
// `request` directly.
const { request, post } = http;

export type { ApiResult };

/**
 * Where the live socket lives, derived from the same base as everything else.
 *
 * Derived rather than configured separately so there is exactly one address to
 * get wrong when the shop's mini-PC changes IP — a second env var would drift
 * from the first and the symptom would be "the kitchen screen stopped updating"
 * with no error anywhere.
 */
export function liveSocketUrl(): string {
  const base = new URL(API_BASE, globalThis.location?.href ?? 'http://localhost');
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `${base.pathname.replace(/\/$/, '')}/live`;
  return base.toString();
}

export interface PrintOptions {
  width: number;
  openDrawer: boolean;
  station?: string;
  requestedBy?: string;
}

export const api = {
  /**
   * Escape hatch for the sync queue (Step 4).
   *
   * A queued mutation is stored as an intent and turned into a method + path
   * only at send time, so it needs one generic entry point rather than the
   * named helper it happened to be created by.
   */
  call: <T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> =>
    request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),

  health: (): Promise<ApiResult<HealthResponse>> => request<HealthResponse>('/health'),
  dbHealth: (): Promise<ApiResult<DbHealthResponse>> => request<DbHealthResponse>('/health/db'),

  /* ---------------- auth ---------------- */

  /**
   * The shops on the login screen (Step 10). Only ever more than one when the
   * owner has opened a second branch, so the picker hides itself in a
   * single-shop shop.
   */
  loginBranches: (): Promise<ApiResult<BranchChoiceList>> => request('/auth/branches'),

  staffList: (
    branchId?: string,
  ): Promise<
    ApiResult<{ branch: { id: string; name: string; branchCode: string }; staff: StaffPublic[] }>
  > => request(branchId ? `/auth/staff?branchId=${branchId}` : '/auth/staff'),

  login: (credentials: PinCredentials): Promise<ApiResult<{ user: SessionUser }>> =>
    post('/auth/login', {
      staffId: credentials.staffId,
      pin: credentials.pin,
      ...(credentials.branchId ? { branchId: credentials.branchId } : {}),
    }),

  logout: (): Promise<ApiResult<{ ok: true }>> => post('/auth/logout'),

  me: (): Promise<ApiResult<MeResponse>> => request<MeResponse>('/auth/me'),

  /* ---------------- menu & floor ---------------- */

  /** Categories, items and every option group, in one round trip. */
  menu: (): Promise<ApiResult<MenuResponse>> => request('/menu'),
  tables: (): Promise<ApiResult<{ tables: TableDto[] }>> => request('/tables'),
  openOrders: (): Promise<ApiResult<{ orders: OrderDto[] }>> => request('/orders/open'),

  /* ---------------- bills ---------------- */

  getOrder: (orderId: string): Promise<ApiResult<{ order: OrderDto }>> =>
    request(`/orders/${orderId}`),

  /** `id` is generated on THIS device (rule #6) — see openBill() in the store. */
  createOrder: (input: {
    id: string;
    tableId?: string | null;
    channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  }): Promise<ApiResult<{ order: OrderDto }>> => post('/orders', input),

  /** `modifierIds` omitted asks the server for the group defaults. */
  addLine: (
    orderId: string,
    input: {
      id: string;
      menuItemId: string;
      qty: number;
      note?: string | null;
      modifierIds?: string[];
    },
  ): Promise<ApiResult<{ order: OrderDto }>> => post(`/orders/${orderId}/lines`, input),

  /** `modifierIds` replaces the whole option set; omit it to leave it alone. */
  updateLine: (
    orderId: string,
    lineId: string,
    input: { qty: number; note?: string | null; modifierIds?: string[] },
  ): Promise<ApiResult<{ order: OrderDto }>> =>
    request(`/orders/${orderId}/lines/${lineId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  removeLine: (orderId: string, lineId: string): Promise<ApiResult<{ order: OrderDto }>> =>
    request(`/orders/${orderId}/lines/${lineId}`, { method: 'DELETE' }),

  cancelOrder: (orderId: string): Promise<ApiResult<{ order: OrderDto }>> =>
    post(`/orders/${orderId}/cancel`),

  /* ---------------- discount ---------------- */

  /**
   * Both online only, and NOT queued through the outbox like an ordinary line
   * edit: the approver's PIN is checked on the server, so a queued discount
   * would be a signature waiting to be validated against a hash the tablet
   * cannot see. There is nothing sensible to do with it while offline.
   */
  setDiscount: (orderId: string, input: DiscountRequest): Promise<ApiResult<{ order: OrderDto }>> =>
    post(`/orders/${orderId}/discount`, input),

  clearDiscount: (
    orderId: string,
    input: ClearDiscountRequest,
  ): Promise<ApiResult<{ order: OrderDto }>> =>
    request(`/orders/${orderId}/discount`, {
      method: 'DELETE',
      body: JSON.stringify(input),
    }),

  /* ---------------- ย้ายโต๊ะ / รวมบิล / แยกบิล ---------------- */

  /**
   * Online only, all three, and NOT queued through the outbox.
   *
   * Not because of a PIN — these need none (see order.routes.ts) — but because
   * each one is a statement about bills the tablet may not be the only holder
   * of. Two devices queueing "merge B into A" and "merge A into B" while the
   * wifi is down would sync into a pair of cancelled bills and no food. The
   * outbox is for edits to a bill this device owns; these are edits to the
   * shape of the floor.
   */
  moveBillToTable: (
    orderId: string,
    input: MoveTableRequest,
  ): Promise<ApiResult<{ order: OrderDto }>> => post(`/orders/${orderId}/move-table`, input),

  mergeBills: (
    orderId: string,
    input: MergeBillsRequest,
  ): Promise<ApiResult<{ order: OrderDto }>> => post(`/orders/${orderId}/merge`, input),

  splitBill: (
    orderId: string,
    input: SplitBillRequest,
  ): Promise<ApiResult<{ order: OrderDto; newOrder: OrderDto }>> =>
    post(`/orders/${orderId}/split`, input),

  /* ---------------- shifts ---------------- */

  /**
   * Online only, all four. The drawer is one physical object with one count,
   * and two tablets counting it offline would sync two different answers to the
   * same question with no way to tell which one held the money.
   */
  currentShift: (): Promise<ApiResult<CurrentShiftResponse>> => request('/shifts/current'),

  openShift: (input: OpenShiftRequest): Promise<ApiResult<{ shift: ShiftDto }>> =>
    post('/shifts/open', input),

  closeShift: (input: CloseShiftRequest): Promise<ApiResult<{ shift: ShiftDto }>> =>
    post('/shifts/close', input),

  shifts: (limit = 30): Promise<ApiResult<ShiftListResponse>> => request(`/shifts?limit=${limit}`),

  /* ---------------- kitchen ---------------- */

  /** Sends everything not yet fired. Online only — see OrderPage. */
  fireOrder: (orderId: string): Promise<ApiResult<{ order: OrderDto; stations: string[] }>> =>
    post(`/orders/${orderId}/fire`),

  voidLine: (
    orderId: string,
    lineId: string,
    input: VoidLineRequest,
  ): Promise<ApiResult<{ order: OrderDto }>> =>
    post(`/orders/${orderId}/lines/${lineId}/void`, input),

  kitchenBoard: (station?: string): Promise<ApiResult<KitchenBoardResponse>> =>
    request(station ? `/kitchen/board?station=${encodeURIComponent(station)}` : '/kitchen/board'),

  startTicket: (ticketId: string): Promise<ApiResult<{ ticket: KitchenTicketDto }>> =>
    post(`/kitchen/tickets/${ticketId}/start`),

  completeTicket: (ticketId: string): Promise<ApiResult<{ ticket: KitchenTicketDto }>> =>
    post(`/kitchen/tickets/${ticketId}/done`),

  recallTicket: (ticketId: string): Promise<ApiResult<{ ticket: KitchenTicketDto }>> =>
    post(`/kitchen/tickets/${ticketId}/recall`),

  completeTicketLine: (ticketLineId: string): Promise<ApiResult<{ ticket: KitchenTicketDto }>> =>
    post(`/kitchen/lines/${ticketLineId}/done`),

  printCheck: (orderId: string, width: number): Promise<ApiResult<{ jobId: string }>> =>
    post(`/orders/${orderId}/print-check`, { width }),

  promptPayQr: (orderId: string): Promise<ApiResult<{ payload: string; amountSatang: number }>> =>
    request(`/orders/${orderId}/promptpay`),

  pay: (orderId: string, input: PayOrderRequest): Promise<ApiResult<PayOrderResponse>> =>
    post(`/orders/${orderId}/pay`, input),

  /* ---------------- printing ---------------- */

  printPreview: (options: PrintOptions): Promise<ApiResult<{ document: ReceiptDoc }>> =>
    post('/print/preview', options),

  printTest: (options: PrintOptions): Promise<ApiResult<{ jobId: string; document: ReceiptDoc }>> =>
    post('/print/test', options),

  printJobStatus: (jobId: string): Promise<ApiResult<PrintJobStatusResponse>> =>
    request<PrintJobStatusResponse>(`/print/jobs/${jobId}`),

  /* ---------------- QR ordering (Step 7) ---------------- */

  /**
   * The customer's three calls. No session, and none of them may ever be put
   * through the offline sync queue: a phone that submits an order it cannot
   * send has told its owner the food is coming when nobody has heard of it.
   */
  qrTable: (token: string): Promise<ApiResult<QrTableResponse>> =>
    request(`/qr/${encodeURIComponent(token)}`),

  qrBill: (token: string): Promise<ApiResult<{ bill: QrBillDto }>> =>
    request(`/qr/${encodeURIComponent(token)}/bill`),

  qrSubmit: (token: string, input: QrSubmitRequest): Promise<ApiResult<QrSubmitResponse>> =>
    post(`/qr/${encodeURIComponent(token)}/order`, input),

  /* ---------------- answering a QR order ---------------- */

  pendingApproval: (): Promise<ApiResult<PendingApprovalResponse>> =>
    request('/orders/pending-approval'),

  /** Approves and, unless told otherwise, sends the same lines to the kitchen. */
  approveQrLines: (
    orderId: string,
    lineIds: string[],
    fire = true,
  ): Promise<ApiResult<{ order: OrderDto; stations: string[] }>> =>
    post(`/orders/${orderId}/approve`, { lineIds, fire }),

  rejectQrLines: (
    orderId: string,
    lineIds: string[],
    reason?: string,
  ): Promise<ApiResult<{ order: OrderDto }>> =>
    post(`/orders/${orderId}/reject`, { lineIds, reason: reason ?? null }),

  /* ---------------- tax documents (Step 10) ---------------- */

  /**
   * Online only, all four of them. A tax invoice number MUST NOT be allocated
   * offline (rule #9) — two tablets would hand the same number to two
   * customers — and there is no useful offline answer to "which bills did we
   * close today" either.
   */
  paidBills: (date?: string): Promise<ApiResult<PaidBillListResponse>> =>
    request(date ? `/bills?date=${date}` : '/bills'),

  issueTaxInvoice: (
    orderId: string,
    input: TaxInvoiceRequest,
  ): Promise<ApiResult<TaxInvoiceResponse>> => post(`/bills/${orderId}/tax-invoice`, input),

  issueCreditNote: (
    orderId: string,
    input: CreditNoteRequest,
  ): Promise<ApiResult<CreditNoteResponse>> => post(`/bills/${orderId}/credit-note`, input),
};
