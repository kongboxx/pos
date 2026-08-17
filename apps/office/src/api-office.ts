/**
 * The back office's endpoints.
 *
 * Split from the till's client so neither app ships the other's surface: the
 * office has no business holding a "pay this bill" call, and the till has no
 * business holding "pay this month's wages".
 *
 * The auth methods are no longer a copy of the till's. The office logs in with
 * an email and a password against its own endpoint, and does not have the two
 * pre-session lookups at all — the API refuses them on this host anyway.
 */

import { createHttp, type ApiResult, type OfficeCredentials } from '@pos/web-kit';
import type {
  AllBranchesResponse,
  BranchCreateRequest,
  BranchDto,
  BranchListResponse,
  BranchSettingsRequest,
  DailyReportResponse,
  DeductionListResponse,
  DeductionRequest,
  ExpenseListResponse,
  ExpenseRequest,
  IngredientRequest,
  MeResponse,
  MenuAdminMutationResponse,
  MenuAdminResponse,
  MenuCategoryRequest,
  MenuItemRequest,
  ModifierGroupRequest,
  ModifierRequest,
  MoveDirection,
  PayrollLineUpdate,
  PayrollPayRequest,
  PayrollResponse,
  PnlResponse,
  SaveRecipeRequest,
  SessionUser,
  StaffCreateRequest,
  StaffListResponse,
  StaffRequest,
  TableQrResponse,
  TableRequest,
  VoidReportResponse,
} from '@pos/shared';

const API_BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api';

const { request, post, put, del } = createHttp(API_BASE);

export type { ApiResult };

export const officeApi = {
  /* ---------------- auth ---------------- */

  /**
   * The back office door. Email and password, not a PIN, and no list of who
   * works here — see the design doc §5.2.
   *
   * `loginBranches` and `staffList` used to sit here and are gone: the API
   * answers them only on the till's host now, and the office has no screen
   * that wants them. Code that cannot call an endpoint cannot leak it.
   */
  login: (credentials: OfficeCredentials): Promise<ApiResult<{ user: SessionUser }>> =>
    post('/auth/office/login', credentials),

  logout: (): Promise<ApiResult<{ ok: true }>> => post('/auth/logout'),

  me: (): Promise<ApiResult<MeResponse>> => request<MeResponse>('/auth/me'),

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

  /* ---------------- branches ---------------- */

  branches: (): Promise<ApiResult<BranchListResponse>> => request('/branches'),

  createBranch: (input: BranchCreateRequest): Promise<ApiResult<BranchDto>> =>
    post('/branches', input),

  updateBranch: (id: string, input: BranchSettingsRequest): Promise<ApiResult<BranchDto>> =>
    put(`/branches/${id}`, input),

  allBranches: (date: string): Promise<ApiResult<AllBranchesResponse>> =>
    request(`/reports/branches?date=${date}`),
};
