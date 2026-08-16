/**
 * The transport's wire format.
 *
 * These assert the two rules that a real bug came from: a request with no body
 * must NOT declare a JSON content type (Fastify answers 400
 * FST_ERR_CTP_EMPTY_JSON_BODY and the caller sees a permanent sync failure),
 * and a network failure must come back as `offline: true` rather than throw —
 * the whole offline queue keys off that flag.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttp } from './http.js';

const http = createHttp('http://api.test/api');

function stubFetch(status = 200, body: unknown = { ok: true }) {
  const mock = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function lastInit(mock: ReturnType<typeof stubFetch>): RequestInit {
  return (mock.mock.calls.at(-1) as [string, RequestInit])[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttp', () => {
  it('prefixes every path with the base url it was given', async () => {
    const fetchMock = stubFetch();
    await http.request('/tables');
    expect((fetchMock.mock.calls.at(-1) as [string, RequestInit])[0]).toBe(
      'http://api.test/api/tables',
    );
  });

  it('sends the session cookie on every call', async () => {
    const fetchMock = stubFetch();
    await http.request('/tables');
    expect(lastInit(fetchMock).credentials).toBe('include');
  });

  it('does not claim a JSON body on a request that has none', async () => {
    const fetchMock = stubFetch();
    await http.del('/orders/o1/lines/l1');
    expect((lastInit(fetchMock).headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('declares a JSON body when there is one', async () => {
    const fetchMock = stubFetch();
    await http.request('/orders/o1/lines/l1', {
      method: 'PATCH',
      body: JSON.stringify({ qty: 2 }),
    });
    expect((lastInit(fetchMock).headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('still sends an empty object for a payload-less POST', async () => {
    const fetchMock = stubFetch();
    await http.post('/auth/logout');
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({});
  });

  it("returns the server's Thai message instead of throwing", async () => {
    stubFetch(409, { error: 'TABLE_OCCUPIED', message: 'โต๊ะ A1 มีบิลค้างอยู่แล้ว' });
    const result = await http.request('/orders');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('โต๊ะ A1 มีบิลค้างอยู่แล้ว');
      expect(result.offline).toBe(false);
      expect(result.status).toBe(409);
    }
  });

  it('flags a network failure as offline rather than as a server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await http.request('/tables');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offline).toBe(true);
  });
});
