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
  AllBranchesResponse,
  BranchChoiceList,
  BranchCreateRequest,
  BranchDto,
  BranchListResponse,
  BranchSettingsRequest,
  ClearDiscountRequest,
  CloseShiftRequest,
  CurrentShiftResponse,
  CreditNoteRequest,
  CreditNoteResponse,
  DailyReportResponse,
  DbHealthResponse,
  DeductionListResponse,
  DeductionRequest,
  DiscountRequest,
  OpenShiftRequest,
  ShiftDto,
  ShiftListResponse,
  ExpenseListResponse,
  ExpenseRequest,
  HealthResponse,
  IngredientRequest,
  KitchenBoardResponse,
  KitchenTicketDto,
  MeResponse,
  MenuAdminMutationResponse,
  MenuAdminResponse,
  MenuCategoryRequest,
  MenuItemRequest,
  MergeBillsRequest,
  MoveDirection,
  MoveTableRequest,
  SplitBillRequest,
  MenuResponse,
  PaidBillListResponse,
  TaxInvoiceRequest,
  TaxInvoiceResponse,
  ModifierGroupRequest,
  ModifierRequest,
  SaveRecipeRequest,
  OrderDto,
  PayOrderRequest,
  PayOrderResponse,
  PayrollLineUpdate,
  PayrollPayRequest,
  PayrollResponse,
  PendingApprovalResponse,
  PnlResponse,
  PrintJobStatusResponse,
  QrBillDto,
  QrSubmitRequest,
  QrSubmitResponse,
  QrTableResponse,
  ReceiptDoc,
  SessionUser,
  StaffCreateRequest,
  StaffListResponse,
  StaffPublic,
  StaffRequest,
  TableDto,
  TableQrResponse,
  TableRequest,
  VoidLineRequest,
  VoidReportResponse,
} from '@pos/shared';

const API_BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api';

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

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: string; offline: boolean; status?: number };

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        // ONLY when there is something to describe.
        //
        // Fastify refuses a request that declares application/json and then
        // sends nothing (FST_ERR_CTP_EMPTY_JSON_BODY, a 400), so a bare DELETE
        // used to come back rejected. That is how "ลบรายการออกจากบิล" reached
        // the server as a permanent failure: the line vanished from the tablet,
        // stayed on the server, and the bill landed in the "ส่งเข้าระบบไม่ได้"
        // list needing a human — found by watching the outbox during the Step 6
        // walkthrough, because every test either mocks fetch or calls
        // app.inject, and neither sets this header.
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : `HTTP ${response.status}`;
      return { ok: false, error: message, offline: false, status: response.status };
    }

    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    // fetch only rejects on a genuine network failure — that is our offline signal.
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'network error',
      offline: true,
    };
  }
}

/**
 * POST helper.
 *
 * The empty body is still sent as `{}` rather than omitted. It no longer has to
 * be — `request` only sets the JSON content type when there is a body — but a
 * POST with no body at all reads as an accident to anyone looking at the
 * network tab, and "cancel this empty bill" genuinely is an empty object.
 */
const post = <T>(path: string, body?: unknown): Promise<ApiResult<T>> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/** PUT is a whole-object replace throughout the management API (Step 6). */
const put = <T>(path: string, body?: unknown): Promise<ApiResult<T>> =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

const del = <T>(path: string): Promise<ApiResult<T>> => request<T>(path, { method: 'DELETE' });

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

  login: (
    staffId: string,
    pin: string,
    branchId?: string,
  ): Promise<ApiResult<{ user: SessionUser }>> =>
    post('/auth/login', { staffId, pin, ...(branchId ? { branchId } : {}) }),

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

  /* ---------------- managing the menu (Step 6) ---------------- */

  /**
   * Every one of these answers with the WHOLE menu, not the row that changed.
   *
   * Raising the price of pork moves the cost of nine dishes; a response
   * carrying only the ingredient would leave the other eight rows on screen
   * showing last week's margin. See menu-admin.ts in @pos/shared.
   *
   * None of it is offline-capable and none of it should be: the menu is edited
   * once a week from a chair, not at the counter mid-service.
   */
  manageMenu: (): Promise<ApiResult<MenuAdminResponse>> => request('/manage/menu'),

  createCategory: (input: MenuCategoryRequest): Promise<ApiResult<MenuAdminMutationResponse>> =>
    post('/manage/categories', input),
  updateCategory: (
    id: string,
    input: MenuCategoryRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/categories/${id}`, input),
  deleteCategory: (id: string): Promise<ApiResult<MenuAdminMutationResponse>> =>
    del(`/manage/categories/${id}`),
  moveCategory: (
    id: string,
    direction: MoveDirection,
  ): Promise<ApiResult<MenuAdminMutationResponse>> =>
    post(`/manage/categories/${id}/move`, { direction }),

  createMenuItem: (input: MenuItemRequest): Promise<ApiResult<MenuAdminMutationResponse>> =>
    post('/manage/menu-items', input),
  updateMenuItem: (
    id: string,
    input: MenuItemRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/menu-items/${id}`, input),
  moveMenuItem: (
    id: string,
    direction: MoveDirection,
  ): Promise<ApiResult<MenuAdminMutationResponse>> =>
    post(`/manage/menu-items/${id}/move`, { direction }),
  setMenuItemAvailability: (
    id: string,
    isAvailable: boolean,
  ): Promise<ApiResult<MenuAdminMutationResponse>> =>
    request(`/manage/menu-items/${id}/availability`, {
      method: 'PATCH',
      body: JSON.stringify({ isAvailable }),
    }),
  deleteMenuItem: (id: string): Promise<ApiResult<MenuAdminMutationResponse>> =>
    del(`/manage/menu-items/${id}`),
  saveMenuItemRecipe: (
    id: string,
    input: SaveRecipeRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/menu-items/${id}/recipe`, input),

  createIngredient: (input: IngredientRequest): Promise<ApiResult<MenuAdminMutationResponse>> =>
    post('/manage/ingredients', input),
  updateIngredient: (
    id: string,
    input: IngredientRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/ingredients/${id}`, input),
  deleteIngredient: (id: string): Promise<ApiResult<MenuAdminMutationResponse>> =>
    del(`/manage/ingredients/${id}`),

  createModifierGroup: (
    input: ModifierGroupRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => post('/manage/modifier-groups', input),
  updateModifierGroup: (
    id: string,
    input: ModifierGroupRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/modifier-groups/${id}`, input),
  deleteModifierGroup: (id: string): Promise<ApiResult<MenuAdminMutationResponse>> =>
    del(`/manage/modifier-groups/${id}`),

  createModifier: (
    groupId: string,
    input: ModifierRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> =>
    post(`/manage/modifier-groups/${groupId}/modifiers`, input),
  updateModifier: (
    id: string,
    input: ModifierRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/modifiers/${id}`, input),
  deleteModifier: (id: string): Promise<ApiResult<MenuAdminMutationResponse>> =>
    del(`/manage/modifiers/${id}`),
  saveModifierRecipe: (
    id: string,
    input: SaveRecipeRequest,
  ): Promise<ApiResult<MenuAdminMutationResponse>> => put(`/manage/modifiers/${id}/recipe`, input),

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

  /* ---------------- the floor plan and the stickers ---------------- */

  manageTables: (): Promise<ApiResult<TableQrResponse>> => request('/manage/tables'),

  /** Every one of these answers with the WHOLE floor plan — see table-admin.routes.ts. */
  createTable: (input: TableRequest): Promise<ApiResult<TableQrResponse>> =>
    post('/manage/tables', input),

  updateTable: (tableId: string, input: TableRequest): Promise<ApiResult<TableQrResponse>> =>
    put(`/manage/tables/${tableId}`, input),

  deleteTable: (tableId: string): Promise<ApiResult<TableQrResponse>> =>
    del(`/manage/tables/${tableId}`),

  moveTable: (tableId: string, direction: MoveDirection): Promise<ApiResult<TableQrResponse>> =>
    post(`/manage/tables/${tableId}/move`, { direction }),

  rotateTableQr: (tableId: string): Promise<ApiResult<TableQrResponse>> =>
    post(`/manage/tables/${tableId}/rotate-qr`),

  setQrOrdering: (enabled: boolean): Promise<ApiResult<TableQrResponse>> =>
    request('/manage/qr-ordering', { method: 'PATCH', body: JSON.stringify({ enabled }) }),

  /* ---------------- money in, money out (Step 8) ---------------- */

  /**
   * None of these are offline-capable and none of them should be.
   *
   * A report read off a tablet that has been out of contact since lunchtime is
   * a wrong number presented as a right one, and unlike a bill there is no
   * screen anywhere that would show it was stale. Every one of these calls
   * fails loudly instead.
   */
  dailyReport: (date?: string): Promise<ApiResult<DailyReportResponse>> =>
    request(date ? `/reports/daily?date=${date}` : '/reports/daily'),

  pnl: (month?: string): Promise<ApiResult<PnlResponse>> =>
    request(month ? `/reports/pnl?month=${month}` : '/reports/pnl'),

  voidReport: (from: string, to: string): Promise<ApiResult<VoidReportResponse>> =>
    request(`/reports/voids?from=${from}&to=${to}`),

  expenses: (month: string): Promise<ApiResult<ExpenseListResponse>> =>
    request(`/expenses?month=${month}`),

  createExpense: (input: ExpenseRequest): Promise<ApiResult<ExpenseListResponse>> =>
    post('/expenses', input),

  updateExpense: (id: string, input: ExpenseRequest): Promise<ApiResult<ExpenseListResponse>> =>
    put(`/expenses/${id}`, input),

  deleteExpense: (id: string): Promise<ApiResult<ExpenseListResponse>> => del(`/expenses/${id}`),

  /* ---------------- people and wages (Step 9) ---------------- */

  /**
   * Online-only for the same reason as the reports above, plus one of its own:
   * a wage rate cached on a tablet is a wage rate that can be read off a tablet
   * left on the counter.
   */
  staff: (): Promise<ApiResult<StaffListResponse>> => request('/staff'),

  createStaff: (input: StaffCreateRequest): Promise<ApiResult<StaffListResponse>> =>
    post('/staff', input),

  updateStaff: (id: string, input: StaffRequest): Promise<ApiResult<StaffListResponse>> =>
    put(`/staff/${id}`, input),

  setStaffPin: (id: string, pin: string): Promise<ApiResult<StaffListResponse>> =>
    post(`/staff/${id}/pin`, { pin }),

  deleteStaff: (id: string): Promise<ApiResult<StaffListResponse>> => del(`/staff/${id}`),

  deductions: (month: string): Promise<ApiResult<DeductionListResponse>> =>
    request(`/staff/deductions?month=${month}`),

  createDeduction: (input: DeductionRequest): Promise<ApiResult<DeductionListResponse>> =>
    post('/staff/deductions', input),

  deleteDeduction: (id: string): Promise<ApiResult<DeductionListResponse>> =>
    del(`/staff/deductions/${id}`),

  payroll: (month: string): Promise<ApiResult<PayrollResponse>> =>
    request(`/payroll?month=${month}`),

  generatePayroll: (month: string): Promise<ApiResult<PayrollResponse>> =>
    post(`/payroll/${month}/generate`, {}),

  updatePayrollLine: (id: string, input: PayrollLineUpdate): Promise<ApiResult<PayrollResponse>> =>
    put(`/payroll/lines/${id}`, input),

  payPayroll: (month: string, input: PayrollPayRequest): Promise<ApiResult<PayrollResponse>> =>
    post(`/payroll/${month}/pay`, input),

  unpayPayroll: (month: string): Promise<ApiResult<PayrollResponse>> =>
    post(`/payroll/${month}/unpay`, {}),

  discardPayroll: (month: string): Promise<ApiResult<PayrollResponse>> => del(`/payroll/${month}`),

  /* ---------------- branches and tax documents (Step 10) ---------------- */

  branches: (): Promise<ApiResult<BranchListResponse>> => request('/branches'),

  createBranch: (input: BranchCreateRequest): Promise<ApiResult<BranchDto>> =>
    post('/branches', input),

  updateBranch: (id: string, input: BranchSettingsRequest): Promise<ApiResult<BranchDto>> =>
    put(`/branches/${id}`, input),

  allBranches: (date: string): Promise<ApiResult<AllBranchesResponse>> =>
    request(`/reports/branches?date=${date}`),

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
