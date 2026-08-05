/**
 * `/api/reports/*` — reading the money back out (Step 8).
 *
 * All of it behind VIEW_REPORTS, which STAFF does not have. That is the same
 * boundary that keeps cost off the till: a cashier who can read the daily
 * report knows the margin on every bowl, and the project rule at the top of
 * permissions.ts says they must not.
 *
 * Read-only, every one of them. Nothing here writes, so nothing here needs a
 * transaction, and a report that is slightly stale is never a problem worth
 * locking a table for.
 */

import type { FastifyInstance } from 'fastify';
import {
  allBranchesQuerySchema,
  dailyReportQuerySchema,
  Permission,
  pnlQuerySchema,
  voidReportQuerySchema,
} from '@pos/shared';
import { requireSessionBranch } from '../../branch.js';
import { prisma } from '../../db.js';
import { requirePermission } from '../auth/guards.js';
import { branchBusinessDate } from '../orders/order.mapper.js';
import { ReportService } from './report.service.js';

export function registerReportRoutes(app: FastifyInstance): void {
  const viewReports = requirePermission(Permission.VIEW_REPORTS, 'ดูรายงาน');
  const viewAllBranches = requirePermission(Permission.VIEW_ALL_BRANCHES, 'ดูยอดขายทุกสาขา');
  const reports = new ReportService(prisma);

  /**
   * `date` may be omitted, and then it is TODAY IN THE BRANCH'S TERMS — the
   * business date, not the server's calendar day. At 00:30 those are different
   * answers and the one the shop means is yesterday.
   */
  app.get('/reports/daily', { preHandler: viewReports }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const query = request.query as Record<string, unknown>;
    const { date } = dailyReportQuerySchema.parse({
      date: query['date'] ?? branchBusinessDate(branch),
    });
    return reply.send(await reports.daily(branch, date));
  });

  app.get('/reports/pnl', { preHandler: viewReports }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const query = request.query as Record<string, unknown>;
    const { month } = pnlQuerySchema.parse({
      month: query['month'] ?? branchBusinessDate(branch).slice(0, 7),
    });
    return reply.send(await reports.pnl(branch, month));
  });

  /**
   * The void report takes an explicit range because the question behind it is
   * never "today" — it is "why are we throwing away so much lately", which
   * only shows up across a week or a month.
   */
  /**
   * Every branch's takings for one day (Step 10).
   *
   * Owner only, and read-only. A branch manager runs their own shop and is
   * measured on it; the owner is the only person whose job spans the shops.
   */
  app.get('/reports/branches', { preHandler: viewAllBranches }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const query = request.query as Record<string, unknown>;
    const { date } = allBranchesQuerySchema.parse({
      date: query['date'] ?? branchBusinessDate(branch),
    });
    return reply.send(await reports.allBranches(date, branch.id));
  });

  app.get('/reports/voids', { preHandler: viewReports }, async (request, reply) => {
    const branch = await requireSessionBranch(prisma, request.user.branchId);
    const query = request.query as Record<string, unknown>;
    const today = branchBusinessDate(branch);
    const { from, to } = voidReportQuerySchema.parse({
      from: query['from'] ?? `${today.slice(0, 7)}-01`,
      to: query['to'] ?? today,
    });
    return reply.send(await reports.voids(branch, from, to));
  });
}
