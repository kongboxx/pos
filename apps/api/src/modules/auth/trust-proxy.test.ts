/**
 * Who the per-IP limiter thinks you are.
 *
 * These go through the office login route because that is where the limiter
 * with the smallest budget lives (10 per minute), and they send an EMPTY body
 * on purpose: the rate limit is checked before the body is parsed, so each
 * request costs a counter increment and a 400 rather than a ~1s bcrypt. The
 * same test written with real credentials would take ten seconds and time out.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../test-helpers.js';

const PATH = '/api/auth/office/login';
/** Matches `new RateLimiter(10, 60_000)` in auth.routes.ts. */
const OFFICE_LIMIT = 10;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Fires n requests from one X-Forwarded-For value and returns the statuses. */
async function knock(
  instance: FastifyInstance,
  forwardedFor: string,
  times: number,
): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const response = await instance.inject({
      method: 'POST',
      url: PATH,
      headers: { 'x-forwarded-for': forwardedFor },
      payload: {},
    });
    codes.push(response.statusCode);
  }
  return codes;
}

describe('with TRUST_PROXY on', () => {
  it('gives two different clients two different budgets', async () => {
    app = await buildTestApp({ TRUST_PROXY: 'true' });

    const first = await knock(app, '203.0.113.9', OFFICE_LIMIT);
    expect(first).not.toContain(429);

    // A different client, arriving after the first one used up its whole
    // allowance, must still get in.
    const second = await knock(app, '198.51.100.7', 1);
    expect(second).toEqual([400]);
  });

  it('ignores a forged first entry, because the proxy appends the real one last', async () => {
    app = await buildTestApp({ TRUST_PROXY: 'true' });

    for (let i = 0; i < OFFICE_LIMIT; i += 1) {
      // A new spoofed address every time. If the leftmost entry were believed,
      // this would be ten different clients and nothing would ever be limited.
      const response = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'x-forwarded-for': `192.0.2.${i}, 203.0.113.9` },
        payload: {},
      });
      expect(response.statusCode).not.toBe(429);
    }

    const eleventh = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'x-forwarded-for': '192.0.2.250, 203.0.113.9' },
      payload: {},
    });
    expect(eleventh.statusCode).toBe(429);
  });
});

describe('with TRUST_PROXY off', () => {
  it('ignores the header entirely, so everything shares one socket address', async () => {
    app = await buildTestApp();

    const first = await knock(app, '203.0.113.9', OFFICE_LIMIT);
    expect(first).not.toContain(429);

    // Same socket, different header. Off means off.
    const second = await knock(app, '198.51.100.7', 1);
    expect(second).toEqual([429]);
  });
});
