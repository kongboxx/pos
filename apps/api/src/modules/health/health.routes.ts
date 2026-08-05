/**
 * Health endpoints.
 *
 * `/api/health`    — is the process alive? (used by the PWA's online/offline banner)
 * `/api/health/db` — can it reach Postgres, and how fast?
 *
 * The PWA polls the first one to decide whether it is online. That decision
 * drives rule #9 (no tax invoice numbers while offline), so it must never
 * touch the database — a slow query would otherwise look like "offline".
 */

import type { FastifyInstance } from 'fastify';
import type { DbHealthResponse, HealthResponse } from '@pos/shared';
import { prisma } from '../../db.js';

const startedAt = Date.now();
const VERSION = '0.0.0';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: VERSION,
    };
  });

  app.get('/health/db', async (_request, reply): Promise<DbHealthResponse> => {
    const startedQueryAt = Date.now();
    try {
      const branchCount = await prisma.branch.count();
      return {
        status: 'ok',
        latencyMs: Date.now() - startedQueryAt,
        branchCount,
      };
    } catch (error) {
      void reply.status(503);
      return {
        status: 'error',
        latencyMs: Date.now() - startedQueryAt,
        message: error instanceof Error ? error.message : 'unknown database error',
      };
    }
  });
}
