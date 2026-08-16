/**
 * The HTTP transport both web apps share.
 *
 * `credentials: 'include'` on every call because the session lives in an
 * httpOnly cookie — the token is never readable from JS, so an XSS cannot lift
 * a session.
 *
 * Network errors are RETURNED, not thrown, so callers are forced to think
 * about the offline case instead of letting a rejected promise bubble up.
 * `offline: true` means fetch itself failed; anything else is a real answer
 * from the server, and the till's sync queue keys off exactly that flag.
 *
 * The base url is injected rather than read from import.meta.env because this
 * package is built by tsc, not Vite. Each app passes its own.
 */

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; offline: boolean; status?: number };

export interface Http {
  readonly baseUrl: string;
  request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>>;
  post<T>(path: string, body?: unknown): Promise<ApiResult<T>>;
  put<T>(path: string, body?: unknown): Promise<ApiResult<T>>;
  del<T>(path: string): Promise<ApiResult<T>>;
}

export function createHttp(baseUrl: string): Http {
  async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        credentials: 'include',
        headers: {
          // ONLY when there is something to describe.
          //
          // Fastify refuses a request that declares application/json and then
          // sends nothing (FST_ERR_CTP_EMPTY_JSON_BODY, a 400), so a bare
          // DELETE used to come back rejected: the line vanished from the
          // tablet, stayed on the server, and the bill landed in the
          // "ส่งเข้าระบบไม่ได้" list needing a human.
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

  return {
    baseUrl,
    request,
    /**
     * The empty body is still sent as `{}` rather than omitted. It no longer
     * has to be, but a POST with no body at all reads as an accident in the
     * network tab — and "cancel this empty bill" genuinely is an empty object.
     */
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    /** PUT is a whole-object replace throughout the management API. */
    put: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
    del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  };
}
