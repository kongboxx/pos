/**
 * The API client's wire format.
 *
 * Every other web test mocks this module, so nothing was checking the shape of
 * the requests it actually sends. That gap let a real bug through: POSTs with
 * no payload were sent with a JSON content-type and NO body, which Fastify
 * rejects with a 400. Logout and "cancel this empty bill" both failed silently
 * — the bill stayed open and held the table.
 *
 * These tests assert the wire format, not the business logic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api-client.js';

function stubFetch(status = 200, body: unknown = { ok: true }) {
  const mock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function lastCall(mock: ReturnType<typeof stubFetch>): [string, RequestInit] {
  return mock.mock.calls.at(-1) as [string, RequestInit];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request shape', () => {
  it('sends a JSON body on POSTs that take no payload', async () => {
    const fetchMock = stubFetch();

    for (const send of [() => api.logout(), () => api.cancelOrder('order-1')]) {
      await send();
      const [, init] = lastCall(fetchMock);
      expect(init.method).toBe('POST');
      // The header is always set, so the body must be parseable JSON.
      expect(typeof init.body).toBe('string');
      expect(() => JSON.parse(init.body as string)).not.toThrow();
    }
  });

  it('sends the session cookie on every call', async () => {
    const fetchMock = stubFetch();
    await api.tables();
    const [, init] = lastCall(fetchMock);
    // The token is httpOnly, so the browser attaches it — but only if asked.
    expect(init.credentials).toBe('include');
  });

  it('uses PATCH and DELETE for line edits rather than tunnelling them through POST', async () => {
    const fetchMock = stubFetch();

    await api.updateLine('order-1', 'line-1', { qty: 3 });
    expect(lastCall(fetchMock)[1].method).toBe('PATCH');
    expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({ qty: 3 });

    await api.removeLine('order-1', 'line-1');
    expect(lastCall(fetchMock)[1].method).toBe('DELETE');
  });

  it('does not claim a JSON body on a request that has none', async () => {
    // The bug this catches, found by reading the outbox during the Step 6
    // walkthrough: a DELETE went out declaring application/json with nothing
    // in it, Fastify answered 400 FST_ERR_CTP_EMPTY_JSON_BODY, and removing a
    // line from a bill became a permanent sync failure — the line disappeared
    // from the tablet, stayed on the server, and the bill needed a human.
    const fetchMock = stubFetch();

    await api.removeLine('order-1', 'line-1');
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();

    // ...and still declares it when there IS one, or Fastify will not parse it.
    await api.updateLine('order-1', 'line-1', { qty: 2 });
    const withBody = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(withBody['Content-Type']).toBe('application/json');
  });

  it('sends the queue`s DELETE without a content type too', async () => {
    // The sync queue does not go through the named helpers — it rebuilds the
    // request from a stored intent — so it needs its own guard.
    const fetchMock = stubFetch();
    await api.call('DELETE', '/orders/order-1/lines/line-1');
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });
});

describe('error handling', () => {
  it('returns the server`s Thai message instead of throwing', async () => {
    stubFetch(409, { error: 'TABLE_OCCUPIED', message: 'โต๊ะ A1 มีบิลค้างอยู่แล้ว' });

    const result = await api.createOrder({ id: 'x', tableId: 't', channel: 'DINE_IN' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('โต๊ะ A1 มีบิลค้างอยู่แล้ว');
      expect(result.offline).toBe(false);
      expect(result.status).toBe(409);
    }
  });

  it('flags a network failure as offline rather than as a server error', async () => {
    // Step 4 keys the whole sync queue off this flag, so it has to be right.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await api.tables();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offline).toBe(true);
  });
});
