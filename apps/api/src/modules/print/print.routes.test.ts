/**
 * Route-level tests using Fastify's `inject` — no port, no browser.
 *
 * These cover the parts that would be embarrassing to get wrong in a shop:
 * the agent token gate, the staff session gate on the counter routes, and
 * turning a bad request into a 400 instead of a 500.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Role } from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp, loginAs, TEST_AGENT_TOKEN } from '../../test-helpers.js';

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = (await loginAs(app, Role.OWNER)).cookie;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('agent authentication', () => {
  it('rejects a claim with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/print/agent/claim',
      payload: { station: 'counter', agentId: 'test' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a claim with the wrong token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/print/agent/claim',
      headers: { 'x-print-agent-token': 'not-the-right-token-at-all' },
      payload: { station: 'counter', agentId: 'test' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a claim with the right token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/print/agent/claim',
      headers: { 'x-print-agent-token': TEST_AGENT_TOKEN },
      payload: { station: 'no-such-station', agentId: 'test' },
    });
    expect(response.statusCode).toBe(200);
    // Nothing is queued for that station, so the queue is empty — not an error.
    expect(response.json()).toEqual({ job: null });
  });

  it('does not accept a staff session in place of the agent token', async () => {
    // A cashier's tablet must not be able to mark a receipt as printed.
    const response = await app.inject({
      method: 'POST',
      url: '/api/print/agent/claim',
      headers: { cookie },
      payload: { station: 'counter', agentId: 'pretending-to-be-the-pi' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('counter routes need a staff session', () => {
  it('refuses a test print with no session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/print/test', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a preview with no session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/print/preview', payload: {} });
    expect(response.statusCode).toBe(401);
  });
});

describe('bad input is the caller`s fault, not a 500', () => {
  it('returns 400 for an impossible paper width', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/print/test',
      headers: { cookie },
      payload: { width: 9999 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
    expect(response.json().message).toMatch(/width/);
  });

  it('returns 400 for a malformed job id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/print/jobs/not-a-uuid',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for a well-formed but unknown job id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/print/jobs/00000000-0000-4000-8000-000000000000',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('JOB_NOT_FOUND');
  });
});

describe('preview', () => {
  it('renders a slip without queueing anything', async () => {
    const before = await prisma.printJob.count();

    const response = await app.inject({
      method: 'POST',
      url: '/api/print/preview',
      headers: { cookie },
      payload: { width: 48, openDrawer: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().document.width).toBe(48);
    expect(await prisma.printJob.count()).toBe(before);
  });
});
