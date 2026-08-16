# แยกหลังร้านออกจากหน้าร้าน — แผนที่ 1: แยกแอป

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** แยกหน้าจอหลังร้าน 13 หน้าออกจาก `apps/web` ไปเป็นแอปของตัวเองที่ `apps/office` โดยพฤติกรรมของทั้งสองฝั่งไม่เปลี่ยนแม้แต่อย่างเดียว

**Architecture:** แกะโค้ดที่สองเว็บใช้ร่วมกันขึ้นไปไว้ที่ `packages/web-kit` ก่อน (ยังเป็นแอปเดียว เทสต์ต้องเขียวครบทุกขั้น) แล้วค่อยสร้าง `apps/office` และ `git mv` ไฟล์หลังร้านเข้าไป ปิดท้ายด้วยการถอดกลไก lazy chunk / precache exclusion ที่ไม่จำเป็นอีกต่อไปออกจาก `apps/web` แล้วเขียนเทสต์ขอบเขตชุดใหม่

**Tech Stack:** pnpm workspace · TypeScript 5.7 (strict + `noUncheckedIndexedAccess`) · React 19 · Vite 6 · vitest 3 · zustand 5 · react-router 7 · Tailwind 4

**Spec:** [`docs/superpowers/specs/2026-08-06-back-office-split-design.md`](../specs/2026-08-06-back-office-split-design.md)

## Global Constraints

- **เทสต์ต้องเขียวครบทุกขั้น** — ทุก task จบด้วย `pnpm test` ที่ผ่านทั้ง workspace ไม่มีขั้นไหนที่ยอมให้แดงชั่วคราว
- **แก้เทสต์ได้แค่บรรทัด `import`** — ถ้าต้องแก้ `expect` แปลว่าพฤติกรรมเปลี่ยน = ทำผิด ให้หยุดแล้วรายงาน
- **ห้ามเพิ่มหน้าจอหรือฟีเจอร์ใหม่ ยกเว้นข้อเดียว** — `apps/office` ต้องมีหน้าล็อกอินของตัวเอง ไม่งั้นแยกเสร็จแล้วไม่มีใครเข้าหลังร้านได้เลย (คุกกี้ของ `shop.*` ไม่ถูกส่งไป `office.*` — นั่นคือสิ่งที่เราตั้งใจให้เป็น) · หน้านี้ใช้ PIN แบบเดิมไปก่อนและ **แผนที่ 2 จะทิ้งมันแล้วเขียนใหม่เป็นอีเมล+รหัสผ่าน** จึงทำให้เล็กที่สุดเท่าที่ใช้ได้ อย่าลงทุนกับมัน
- **`packages/shared` ห้าม import React / react-router / zustand / `node:*`** — กฎเดิมของโปรเจกต์ ของพวกนี้ไปอยู่ `packages/web-kit`
- **`apps/office` ห้าม import อะไรจาก `offline/` เลย** และห้ามมี service worker
- **เงินเป็น `Int` สตางค์เสมอ** ESLint แบน `parseFloat` อยู่แล้ว อย่าปลด
- **ย้ายไฟล์ด้วย `git mv` เสมอ** ไม่ใช่ copy+delete — ไม่งั้นประวัติไฟล์ขาด
- **เส้นทาง URL ไม่เปลี่ยนในแผนนี้** — `shop.*` ยังเป็น `/pos/*`, `office.*` ยังเป็น `/office/*`
- Node ≥ 20.11 · pnpm 11.18.0

**สถานะฐาน วัดไว้ 2026-08-06 (ต้องไม่ต่ำกว่านี้ตอนจบทุก task):**

| ชุด | เทสต์ |
|---|---|
| `@pos/shared` | 405 ผ่าน |
| `@pos/print-agent` | 15 ผ่าน |
| `@pos/web` | 364 ผ่าน (ในนั้น 112 คือหลังร้าน) |
| `pnpm typecheck` · `pnpm lint` | ผ่าน ไม่มี warning |

> `@pos/api` ต้องมี Postgres จึงจะรันได้ (`pnpm db:up && pnpm db:seed:demo`) แผนนี้ไม่แตะโค้ด API เลย ถ้ารันไม่ได้ให้ข้ามและบันทึกไว้

---

## File Structure

### สร้างใหม่

| ไฟล์ | รับผิดชอบอะไร |
|---|---|
| `packages/web-kit/package.json` | นิยาม `@pos/web-kit` |
| `packages/web-kit/tsconfig.json` | build เป็น `dist/` พร้อม `.d.ts` |
| `packages/web-kit/vitest.config.ts` | รันเทสต์ใน jsdom (มี React อยู่ข้างใน) |
| `packages/web-kit/src/index.ts` | ประตูเดียวของ package |
| `packages/web-kit/src/http.ts` | `createHttp()` — ตัวยิง request + `ApiResult` |
| `packages/web-kit/src/http.test.ts` | ทดสอบรูปแบบ request ที่ส่งออกจริง |
| `packages/web-kit/src/routes.ts` | เส้นทาง URL ทั้งหมดของทั้งสองเว็บ |
| `packages/web-kit/src/session-store.ts` | `createSessionStore()` — โรงงาน ไม่ใช่ store สำเร็จรูป |
| `packages/web-kit/src/session-store.test.ts` | ทดสอบว่าไม่มี persistence แล้วยังทำงานถูก |
| `packages/web-kit/src/business-day.ts` | `createUseBusinessToday()` |
| `packages/web-kit/src/route-guards.tsx` | `RequireAuth` · `RequirePermission` ที่รับ fallback |
| `apps/office/*` | แอปหลังร้านทั้งแอป (โครงเหมือน `apps/web` แต่ไม่มี PWA) |
| `apps/web/src/session.ts` | สร้าง store ของหน้าร้าน พร้อม persistence ที่ผูก IndexedDB |
| `apps/web/src/bundle-boundary.test.ts` | เขียนใหม่ทั้งไฟล์ (ดู Task 10) |

### ย้าย (`git mv`)

- `apps/web/src/pages/office/**` → `apps/office/src/pages/**` (24 ไฟล์)
- `apps/web/src/components/office/**` → `apps/office/src/components/**` (8 ไฟล์)
- `apps/web/src/manage-store.ts` + `.test.ts` → `apps/office/src/` (2 ไฟล์)

### ลบ

- `apps/web/src/office-gate.tsx` + `apps/web/src/office-gate.test.tsx`
- `apps/web/src/routes.ts` · `route-guards.tsx` · `business-day.ts` · `session-store.ts` (ย้ายเนื้อไป `web-kit` แล้ว)

---

## Task 1: สร้าง `packages/web-kit` ที่ build ผ่าน

**Files:**
- Create: `packages/web-kit/package.json`
- Create: `packages/web-kit/tsconfig.json`
- Create: `packages/web-kit/vitest.config.ts`
- Create: `packages/web-kit/src/index.ts`

**Interfaces:**
- Consumes: ไม่มี
- Produces: package ชื่อ `@pos/web-kit` ที่ `pnpm --filter @pos/web-kit build` ผ่าน และ import ได้ด้วย `workspace:*`

- [ ] **Step 1: เขียน `package.json`**

`packages/web-kit/package.json` — ลอกโครงจาก `packages/shared/package.json` แต่เพิ่ม React เป็น peer:

```json
{
  "name": "@pos/web-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch --preserveWatchOutput",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@pos/shared": "workspace:*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-router-dom": "^7.18.1",
    "zustand": "^5.0.3"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.7",
    "jsdom": "^26.0.0",
    "react": "^19.0.0",
    "react-router-dom": "^7.18.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5",
    "zustand": "^5.0.3"
  }
}
```

`--passWithNoTests` เป็นของชั่วคราวเพราะ task นี้ยังไม่มีไฟล์เทสต์ และ `vitest run` ออกด้วย exit 1 เมื่อไม่เจอเทสต์ ซึ่งจะทำให้ `pnpm test` ทั้ง workspace แดง ผิดกฎ "เขียวครบทุกขั้น" · **Task 2 ถอดธงนี้ออก** ตอนที่เทสต์ตัวจริงตัวแรกเข้ามา ปล่อยไว้ถาวรไม่ได้เพราะจะกลบกรณีที่ `include` พังแล้วเทสต์ทั้ง package หายเงียบ ๆ

React/react-router/zustand เป็น `peerDependencies` เพราะทั้งสองแอปต้องใช้ **อินสแตนซ์เดียวกัน** — ถ้า `web-kit` ลากสำเนา React ของตัวเองมา hook จะพังแบบที่ error บอกว่า "invalid hook call" โดยไม่ชี้ว่ามาจากไหน

- [ ] **Step 2: เขียน `tsconfig.json`**

`packages/web-kit/tsconfig.json` — ต่างจาก `packages/shared` ตรงที่ต้องมี DOM และ JSX:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx", "dist", "node_modules"]
}
```

- [ ] **Step 3: เขียน `vitest.config.ts`**

`packages/web-kit/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    // businessDate must not depend on the machine running the tests.
    env: { TZ: 'UTC' },
  },
});
```

- [ ] **Step 4: เขียน `src/index.ts` ที่ยังว่าง**

`packages/web-kit/src/index.ts`:

```ts
/**
 * @pos/web-kit — the browser code BOTH web apps need.
 *
 * Separate from @pos/shared because that package must stay free of React and
 * node:* so it can run inside a service worker; this one is allowed React,
 * react-router and zustand.
 *
 * Nothing here may import Dexie or anything under an app's `offline/` folder.
 * The back office has no local database, and a stray import would put one
 * there — see bundle-boundary.test.ts.
 */

export {};
```

- [ ] **Step 5: ติดตั้งและ build**

```bash
pnpm install
```

```bash
pnpm --filter @pos/web-kit build
```

Expected: สร้าง `packages/web-kit/dist/index.js` และ `index.d.ts` โดยไม่มี error

- [ ] **Step 6: ยืนยันว่าไม่มีอะไรพัง**

```bash
pnpm typecheck && pnpm lint
```

Expected: ผ่านทั้งคู่

- [ ] **Step 7: Commit**

```bash
git add packages/web-kit pnpm-lock.yaml && git commit -m "chore: scaffold @pos/web-kit"
```

---

## Task 2: ย้ายตัวยิง request เข้า `web-kit`

**Files:**
- Create: `packages/web-kit/src/http.ts`
- Create: `packages/web-kit/src/http.test.ts`
- Modify: `packages/web-kit/src/index.ts`
- Modify: `packages/web-kit/package.json` (ถอด `--passWithNoTests` ออกจาก `test` — มีเทสต์จริงแล้ว)
- Modify: `apps/web/src/api-client.ts:82-165` (ลบ `request`/`post`/`put`/`del` แล้ว import แทน)
- Modify: `apps/web/package.json` (เพิ่ม `@pos/web-kit`)
- Modify: `apps/web/src/pages/office/PayrollPage.test.tsx` (ครอบ `waitFor` ที่เทสต์ flaky — เลื่อนมาจากแผนที่ 3 เพราะมันทำให้ `pnpm test` แดงสุ่ม ๆ จนใช้เป็นเกณฑ์ผ่านของ task ถัดไปไม่ได้)

> **หมายเหตุตอนลงมือ:** การแก้ `build:shared` ให้ build `web-kit` ด้วย เดิมอยู่ที่ Task 7 แต่ต้องเลื่อนมาทำที่ Task 3 — `apps/web` พึ่ง `@pos/web-kit` ตั้งแต่ task นี้แล้ว ถ้าไม่แก้ เครื่องที่ clone ใหม่จะรัน `pnpm dev:web` ไม่ผ่านเพราะยังไม่มี `web-kit/dist`

**Interfaces:**
- Consumes: `@pos/web-kit` จาก Task 1
- Produces:
  - `type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; offline: boolean; status?: number }`
  - `interface Http { request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>>; post<T>(path: string, body?: unknown): Promise<ApiResult<T>>; put<T>(path: string, body?: unknown): Promise<ApiResult<T>>; del<T>(path: string): Promise<ApiResult<T>>; baseUrl: string }`
  - `function createHttp(baseUrl: string): Http`

- [ ] **Step 1: เขียนเทสต์ที่ยังล้ม**

`packages/web-kit/src/http.test.ts` — เทสต์ตัวยิงตรง ๆ ไม่ผ่าน `api` เหมือน `apps/web/src/api-client.test.ts` (ไฟล์นั้นอยู่ที่เดิม ไม่ต้องแตะ):

```ts
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
    await http.request('/orders/o1/lines/l1', { method: 'PATCH', body: JSON.stringify({ qty: 2 }) });
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
```

- [ ] **Step 2: รันเทสต์ให้เห็นว่ามันล้ม**

```bash
pnpm --filter @pos/web-kit test
```

Expected: FAIL — `Failed to resolve import "./http.js"`

- [ ] **Step 3: เขียน `http.ts`**

`packages/web-kit/src/http.ts` — ยกเนื้อมาจาก `apps/web/src/api-client.ts:99-158` ตรง ๆ เปลี่ยนแค่ให้ base url ฉีดเข้ามาแทนที่จะอ่าน `import.meta.env` เอง (package นี้ build ด้วย `tsc` ไม่ใช่ Vite จึงไม่มี `import.meta.env`):

```ts
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
```

- [ ] **Step 4: ส่งออกจาก `index.ts`**

`packages/web-kit/src/index.ts` — แทนที่ `export {};` ด้วย:

```ts
export * from './http.js';
```

- [ ] **Step 5: รันเทสต์ให้ผ่าน**

```bash
pnpm --filter @pos/web-kit build && pnpm --filter @pos/web-kit test
```

Expected: PASS 7 เทสต์

- [ ] **Step 6: เพิ่ม dependency ให้ `apps/web`**

แก้ `apps/web/package.json` ใน `dependencies` เพิ่มบรรทัด (เรียงตามตัวอักษร ต่อจาก `@pos/shared`):

```json
    "@pos/web-kit": "workspace:*",
```

แล้ว:

```bash
pnpm install
```

- [ ] **Step 7: ให้ `apps/web/src/api-client.ts` ใช้ตัวยิงจาก web-kit**

ใน `apps/web/src/api-client.ts`:

1. ลบบรรทัด `export type ApiResult<T> = ...` (บรรทัด 99-100) และฟังก์ชัน `request` (102-141), `post` (151-152), `put` (155-156), `del` (158) ออกทั้งหมด
2. เพิ่มหลังบรรทัด `import type { ... } from '@pos/shared';`:

```ts
import { createHttp, type ApiResult } from '@pos/web-kit';

const API_BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api';

const http = createHttp(API_BASE);
const { request, post, put, del } = http;

export type { ApiResult };
```

3. ลบ `const API_BASE = ...` ตัวเดิม (บรรทัด 82) ทิ้ง เพราะย้ายขึ้นไปข้างบนแล้ว
4. `liveSocketUrl()` **อยู่ที่เดิม** — มันเป็นของจอครัวซึ่งเป็นหน้าร้านล้วน

- [ ] **Step 8: รันเทสต์ทั้ง workspace**

```bash
pnpm test
```

Expected: `@pos/shared` 405 ผ่าน · `@pos/web-kit` 7 ผ่าน · `@pos/web` **364 ผ่าน** · `@pos/print-agent` 15 ผ่าน

ถ้า `@pos/web` ไม่ครบ 364 ให้หยุด — แปลว่าการแกะตัวยิงเปลี่ยนพฤติกรรม

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "refactor: move the HTTP transport into @pos/web-kit"
```

---

## Task 3: ย้าย `routes.ts` เข้า `web-kit`

**Files:**
- Create: `packages/web-kit/src/routes.ts` (ผ่าน `git mv`)
- Modify: `packages/web-kit/src/index.ts`
- Delete: `apps/web/src/routes.ts`
- Modify: ทุกไฟล์ที่ `import { path } from './routes.js'` หรือ `'../../routes.js'`

**Interfaces:**
- Consumes: `@pos/web-kit` จาก Task 2
- Produces: `export const path` (ตัวเดิมทุกคีย์ ไม่เพิ่มไม่ลด) และ `export const OFFICE_PREFIX = '/office'`

- [ ] **Step 1: ย้ายไฟล์**

```bash
git mv apps/web/src/routes.ts packages/web-kit/src/routes.ts
```

ไฟล์นี้ไม่ import อะไรเลย จึงย้ายได้โดยไม่ต้องแก้เนื้อใน

- [ ] **Step 2: ส่งออกจาก `index.ts`**

`packages/web-kit/src/index.ts`:

```ts
export * from './http.js';
export * from './routes.js';
```

- [ ] **Step 3: แก้ import ทุกที่ที่อ้างถึง**

```bash
node -e "
const fs=require('fs'),cp=require('child_process');
const files=cp.execSync('git grep -l \"from .\\\\(\\\\.\\\\./\\\\)*routes.js.\" -- apps/web/src',{encoding:'utf8'}).trim().split('\n').filter(Boolean);
for(const f of files){
  const before=fs.readFileSync(f,'utf8');
  const after=before.replace(/from '(?:\.\.\/)*(?:\.\/)?routes\.js'/g, \"from '@pos/web-kit'\");
  if(before!==after){fs.writeFileSync(f,after);console.log('patched',f);}
}
"
```

> ใช้ Node ไม่ใช่ PowerShell `Get-Content`/`Set-Content` — ไฟล์เหล่านี้มีข้อความไทย และ PowerShell 5.1 ทำ UTF-8 เพี้ยนเงียบ ๆ

- [ ] **Step 4: รวม import ที่ซ้ำ**

ไฟล์ที่ import จาก `@pos/web-kit` อยู่แล้วจะมีสองบรรทัด ให้รวมเป็นบรรทัดเดียว
`pnpm lint` จะไม่ฟ้อง แต่ `pnpm format` จัดให้ไม่ได้ ต้องรวมมือ

```bash
pnpm --filter @pos/web-kit build && pnpm typecheck
```

Expected: ผ่าน ถ้าไม่ผ่านให้ตามแก้ import ตามที่ error ชี้

- [ ] **Step 5: รันเทสต์**

```bash
pnpm test && pnpm lint
```

Expected: `@pos/web` 364 ผ่าน · lint ไม่มี error

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: move routes into @pos/web-kit"
```

---

## Task 4: แปลง `session-store` เป็นโรงงาน

**Files:**
- Create: `packages/web-kit/src/session-store.ts`
- Create: `packages/web-kit/src/session-store.test.ts`
- Create: `apps/web/src/session.ts`
- Delete: `apps/web/src/session-store.ts`
- Modify: `packages/web-kit/src/index.ts`
- Modify: ทุกไฟล์ที่ import `session-store.js`

**Interfaces:**
- Consumes: `ApiResult` จาก Task 2
- Produces:
  ```ts
  interface SessionPersistence {
    save(identity: { user: SessionUser; permissions: Permission[]; branch: MeResponse['branch'] }): Promise<void>;
    load(): Promise<{ user: SessionUser; branch: MeResponse['branch'] } | null>;
    forget(): Promise<void>;
    clearAll(): Promise<void>;
    unsentCount(): Promise<number>;
  }
  interface SessionApi {
    me(): Promise<ApiResult<MeResponse>>;
    login(staffId: string, pin: string, branchId?: string): Promise<ApiResult<{ user: SessionUser }>>;
    logout(): Promise<ApiResult<unknown>>;
  }
  interface SessionState { status: 'loading' | 'anonymous' | 'authenticated'; user: SessionUser | null; branch: MeResponse['branch'] | null; offline: boolean; refresh(): Promise<void>; login(staffId: string, pin: string, branchId?: string): Promise<{ ok: true } | { ok: false; error: string }>; logout(): Promise<{ ok: true } | { ok: false; error: string }>; can(permission: Permission): boolean }
  function createSessionStore(deps: { api: SessionApi; persistence?: SessionPersistence }): UseBoundStore<StoreApi<SessionState>>
  ```
  `apps/web/src/session.ts` ส่งออก `useSession` ที่ชื่อและรูปร่างเหมือนของเดิมเป๊ะ

- [ ] **Step 1: เขียนเทสต์ที่ยังล้ม**

`packages/web-kit/src/session-store.test.ts` — เทสต์เฉพาะเส้นทาง "ไม่มี persistence" ซึ่งเป็นของใหม่ที่หลังร้านจะใช้ (เส้นทางที่มี persistence ยังถูกคุ้มโดยเทสต์เดิมของ `apps/web`):

```ts
/**
 * The session store WITHOUT a persistence adapter — the shape the back office
 * uses.
 *
 * The till caches its identity so a tablet that reloads on dead wifi still has
 * a till. The back office must not: it has no local database, and an identity
 * sitting in a browser after the server said no is a session that outlives its
 * own revocation.
 */

import { describe, expect, it, vi } from 'vitest';
import { Role } from '@pos/shared';
import { createSessionStore } from './session-store.js';

const user = { staffId: 's1', branchId: 'b1', role: Role.OWNER, fullName: 'หน่อย', nickname: null };
// ต้องครบทุกฟิลด์ของ MeResponse['branch'] ไม่งั้น typecheck ไม่ผ่าน — ตอนเขียน
// แผนใส่มาแค่ 4 ตัว ของจริงมี 11 (เพิ่ม vatEnabled, vatRateBp, priceIncludesVat,
// vatEffectiveDate, timezone, dayCutoffHour, promptPayConfigured)
const branch: MeResponse['branch'] = {
  id: 'b1', name: 'ร้าน', branchCode: 'HQ', businessType: 'RESTAURANT',
  vatEnabled: false, vatRateBp: 0, priceIncludesVat: true, vatEffectiveDate: null,
  timezone: 'Asia/Bangkok', dayCutoffHour: 4, promptPayConfigured: false,
};

function apiStub(over: Partial<Parameters<typeof createSessionStore>[0]['api']> = {}) {
  return {
    me: vi.fn().mockResolvedValue({ ok: true, data: { user, permissions: [], branch } }),
    login: vi.fn().mockResolvedValue({ ok: true, data: { user } }),
    logout: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    ...over,
  };
}

describe('createSessionStore without persistence', () => {
  it('authenticates from /auth/me', async () => {
    const store = createSessionStore({ api: apiStub() });
    await store.getState().refresh();
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().user?.staffId).toBe('s1');
  });

  it('goes anonymous when the network is down instead of resurrecting a cached identity', async () => {
    // The till would fall back to its cache here. The back office has none, so
    // a dead connection must read as "not logged in", not as "still the owner".
    const api = apiStub({
      me: vi.fn().mockResolvedValue({ ok: false, error: 'offline', offline: true }),
    });
    const store = createSessionStore({ api });
    await store.getState().refresh();
    expect(store.getState().status).toBe('anonymous');
    expect(store.getState().offline).toBe(true);
  });

  it('logs out without asking about an unsent queue that cannot exist', async () => {
    const api = apiStub();
    const store = createSessionStore({ api });
    await store.getState().refresh();
    const result = await store.getState().logout();
    expect(result.ok).toBe(true);
    expect(api.logout).toHaveBeenCalled();
    expect(store.getState().status).toBe('anonymous');
  });

  it('answers can() from the same matrix the API enforces', async () => {
    const store = createSessionStore({ api: apiStub() });
    await store.getState().refresh();
    // OWNER has VIEW_PAYROLL; nobody else does.
    expect(store.getState().can('VIEW_PAYROLL')).toBe(true);
  });

  it('answers can() false before anyone has logged in', () => {
    const store = createSessionStore({ api: apiStub() });
    expect(store.getState().can('VIEW_PAYROLL')).toBe(false);
  });
});
```

- [ ] **Step 2: รันเทสต์ให้เห็นว่าล้ม**

```bash
pnpm --filter @pos/web-kit test
```

Expected: FAIL — `Failed to resolve import "./session-store.js"`

- [ ] **Step 3: เขียน `session-store.ts` ใน web-kit**

`packages/web-kit/src/session-store.ts`:

```ts
/**
 * Who is logged in — as a factory, not a ready-made store.
 *
 * THE CREDENTIAL IS STILL ONLY IN THE COOKIE. Nothing here holds a token and
 * nothing here can be replayed against the server; every request is authorised
 * by the httpOnly cookie the browser manages, which JavaScript cannot read.
 *
 * The two apps differ in exactly one capability, and it is injected rather
 * than branched on:
 *
 *   the till     passes `persistence`, so a tablet that reloads while the wifi
 *                is down still boots into a working till instead of a PIN
 *                screen it could never get past. It also refuses to log out
 *                while orders are queued — wiping local data then would delete
 *                food that has already been served.
 *
 *   the office   passes nothing. It has no local database and must not grow
 *                one: an identity cached in a browser is an identity that
 *                outlives its own revocation.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { can, type MeResponse, type Permission, type SessionUser } from '@pos/shared';
import type { ApiResult } from './http.js';

export interface CachedIdentity {
  user: SessionUser;
  permissions: Permission[];
  branch: MeResponse['branch'];
}

export interface SessionPersistence {
  save(identity: CachedIdentity): Promise<void>;
  load(): Promise<{ user: SessionUser; branch: MeResponse['branch'] } | null>;
  forget(): Promise<void>;
  clearAll(): Promise<void>;
  unsentCount(): Promise<number>;
}

export interface SessionApi {
  me(): Promise<ApiResult<MeResponse>>;
  login(staffId: string, pin: string, branchId?: string): Promise<ApiResult<{ user: SessionUser }>>;
  logout(): Promise<ApiResult<unknown>>;
}

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

export interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  branch: MeResponse['branch'] | null;
  /** True when the last call failed because the network is down, not the login. */
  offline: boolean;

  refresh: () => Promise<void>;
  login: (
    staffId: string,
    pin: string,
    branchId?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Same matrix the API enforces — this only decides whether to draw a button. */
  can: (permission: Permission) => boolean;
}

export function createSessionStore(deps: {
  api: SessionApi;
  persistence?: SessionPersistence;
}): UseBoundStore<StoreApi<SessionState>> {
  const { api, persistence } = deps;

  return create<SessionState>((set, get) => ({
    status: 'loading',
    user: null,
    branch: null,
    offline: false,

    refresh: async () => {
      const result = await api.me();
      if (result.ok) {
        set({
          status: 'authenticated',
          user: result.data.user,
          branch: result.data.branch,
          offline: false,
        });
        await persistence?.save({
          user: result.data.user,
          permissions: result.data.permissions,
          branch: result.data.branch,
        });
        return;
      }

      // A network failure is NOT a logout. Clearing the session here would
      // throw a cashier back to the PIN screen every time the wifi blinks.
      if (result.offline) {
        const cached = await persistence?.load();
        if (cached) {
          set({
            status: 'authenticated',
            user: cached.user,
            branch: cached.branch,
            offline: true,
          });
          return;
        }
        set({ offline: true, status: get().user ? 'authenticated' : 'anonymous' });
        return;
      }

      // The server answered and said no. That is a real logout — forget the
      // cached description too, or the next offline boot would resurrect it.
      await persistence?.forget();
      set({ status: 'anonymous', user: null, branch: null, offline: false });
    },

    login: async (staffId, pin, branchId) => {
      const result = await api.login(staffId, pin, branchId);
      if (!result.ok) return { ok: false, error: result.error };
      await get().refresh();
      return { ok: true };
    },

    logout: async () => {
      const unsent = (await persistence?.unsentCount()) ?? 0;
      if (unsent > 0) {
        return {
          ok: false,
          error: `ยังมี ${unsent} รายการที่ยังไม่ได้ส่งเข้าระบบ — ต่อเน็ตให้ส่งครบก่อนออกจากระบบ`,
        };
      }

      await api.logout();
      await persistence?.clearAll();
      set({ status: 'anonymous', user: null, branch: null });
      return { ok: true };
    },

    can: (permission) => {
      const { user } = get();
      return user ? can(user.role, permission) : false;
    },
  }));
}
```

> ระวังจุดเดียว: `set({ offline: true, status: get().user ? ... })` ต้องคงไว้เหมือนเดิมเป๊ะ ตรงนี้คือกรณี "เน็ตหลุดแต่ยังไม่เคยแคชอะไร" ซึ่งเทสต์ข้อสองข้างบนจับอยู่

- [ ] **Step 4: ส่งออกจาก `index.ts`**

```ts
export * from './http.js';
export * from './routes.js';
export * from './session-store.js';
```

- [ ] **Step 5: รันเทสต์ web-kit ให้ผ่าน**

```bash
pnpm --filter @pos/web-kit build && pnpm --filter @pos/web-kit test
```

Expected: PASS 12 เทสต์ (7 จาก http + 5 จาก session-store)

- [ ] **Step 6: สร้าง store ของหน้าร้าน**

`apps/web/src/session.ts` — ไฟล์ใหม่ที่ผูก persistence เข้ากับ IndexedDB:

```ts
/**
 * The till's session: the shared store plus the one capability only this app
 * has — a local database.
 *
 * Caching the identity is what makes a reload on dead wifi survivable. It
 * grants nothing: the moment a real request goes out, the httpOnly cookie is
 * still the only thing that decides. The cache is capped at the session's own
 * lifetime and wiped on logout.
 */

import { createSessionStore, type SessionPersistence } from '@pos/web-kit';
import { api } from './api-client.js';
import { forgetIdentity, loadIdentity, saveIdentity } from './offline/catalog.js';
import { clearLocalData } from './offline/db.js';
import { totalUnsent } from './offline/outbox.js';

const persistence: SessionPersistence = {
  save: saveIdentity,
  load: async () => {
    const cached = await loadIdentity();
    return cached ? { user: cached.user, branch: cached.branch } : null;
  },
  forget: forgetIdentity,
  clearAll: clearLocalData,
  unsentCount: totalUnsent,
};

export const useSession = createSessionStore({ api, persistence });
```

- [ ] **Step 7: ลบไฟล์เดิมแล้วชี้ import ใหม่**

```bash
git rm apps/web/src/session-store.ts
```

```bash
node -e "
const fs=require('fs'),cp=require('child_process');
const files=cp.execSync('git grep -l \"session-store.js\" -- apps/web/src',{encoding:'utf8'}).trim().split('\n').filter(Boolean);
for(const f of files){
  const before=fs.readFileSync(f,'utf8');
  const after=before.replace(/from '((?:\.\.\/)*)(?:\.\/)?session-store\.js'/g, (_m,up)=>\`from '\${up||'./'}session.js'\`);
  if(before!==after){fs.writeFileSync(f,after);console.log('patched',f);}
}
"
```

> **ผิดตอนเขียนแผน แก้แล้วตอนลงมือ:** regex ข้างบนยึดกับ `from '...'` ซึ่ง**ไม่ครอบคลุม** `vi.mock('...')` — เทสต์ 10 ไฟล์เข้าถึงโมดูลนี้ผ่าน `vi.mock` ทั้งนั้น จึงจะถูกข้ามไปเงียบ ๆ ต้องจับที่ตัวสตริงในเครื่องหมายคำพูดตรง ๆ: `/'((?:\.\.\/)*)(?:\.\/)?session-store\.js'/g`

ตรวจด้วยตาอีกรอบ:

```bash
git grep -n "session-store" -- apps/web/src
```

Expected: ไม่มีผลลัพธ์

- [ ] **Step 8: รันเทสต์ทั้ง workspace**

```bash
pnpm test
```

Expected: `@pos/web` **364 ผ่าน** · `@pos/web-kit` 12 ผ่าน

ถ้าเทสต์ไหนล้มเพราะ mock ไม่ตรง ให้แก้ **เฉพาะบรรทัด `vi.mock`** ห้ามแตะ `expect`

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "refactor: turn the session store into a factory with injected persistence"
```

---

## Task 5: ย้าย `business-day.ts` และ `route-guards.tsx` เข้า `web-kit`

**Files:**
- Create: `packages/web-kit/src/business-day.ts`
- Create: `packages/web-kit/src/route-guards.tsx`
- ~~Delete~~ **เขียนทับ**: `apps/web/src/business-day.ts`, `apps/web/src/route-guards.tsx` — ไม่ได้ลบ ทั้งสองไฟล์เหลืออยู่เป็นตัวห่อบาง ๆ ที่คงชื่อ export เดิม ผู้เรียก 12 ไฟล์จึงไม่ต้องแก้อะไรเลย (Step 4 พูดถูก บรรทัดนี้ในหัวข้อเขียนผิดตอนร่างแผน)
- Modify: `packages/web-kit/src/index.ts`
- Modify: ไฟล์ที่ import ทั้งสอง (10 และ 2 ไฟล์ตามลำดับ)

**Interfaces:**
- Consumes: `SessionState` จาก Task 4 · `path` จาก Task 3
- Produces:
  - `function createUseBusinessToday(useSession: UseBoundStore<StoreApi<SessionState>>): () => string`
  - `function RequireAuth({ useSession, loginPath }: { useSession: ...; loginPath: string }): React.ReactElement`
  - `function RequirePermission({ useSession, permission, fallback }: { useSession: ...; permission: Permission; fallback: string }): React.ReactElement`

- [ ] **Step 1: เขียน `business-day.ts` ใน web-kit**

`packages/web-kit/src/business-day.ts` — ต้องเป็นโรงงานเหมือนกัน เพราะ store ไม่ใช่ของ global อีกแล้ว:

```ts
/**
 * "วันนี้คือวันไหน" in the shop's terms.
 *
 * NOT the browser's calendar day. At 00:30 the shop is still trading yesterday
 * (rule #4), so the answer comes from the branch's timezone and cutoff hour
 * cached in the session. Getting this wrong opens the daily report on an empty
 * tomorrow every night after midnight, and files a late bill under the wrong
 * day's takings.
 *
 * A factory, because each app owns its own session store now.
 */

import type { StoreApi, UseBoundStore } from 'zustand';
import { toBusinessDate } from '@pos/shared';
import type { SessionState } from './session-store.js';

export function createUseBusinessToday(
  useSession: UseBoundStore<StoreApi<SessionState>>,
): () => string {
  return function useBusinessToday(): string {
    const branch = useSession((state) => state.branch);
    return toBusinessDate(new Date(), {
      timezone: branch?.timezone ?? 'Asia/Bangkok',
      dayCutoffHour: branch?.dayCutoffHour ?? 4,
    });
  };
}
```

- [ ] **Step 2: เขียน `route-guards.tsx` ใน web-kit**

`packages/web-kit/src/route-guards.tsx` — `fallback` กลายเป็น prop เพราะปลายทางต่างกันคนละแอป:

```tsx
/**
 * The two route guards.
 *
 * These are a COURTESY, not the boundary. They stop someone who types a URL
 * from landing on a screen they cannot use; the boundary is the permission
 * check on every endpoint behind it, which runs whatever the browser believes.
 *
 * `fallback` is a prop rather than a constant because the two apps are now
 * different sites: sending an office visitor to the till's floor plan would be
 * a redirect to another origin.
 */

import { Navigate, Outlet } from 'react-router-dom';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Permission } from '@pos/shared';
import type { SessionState } from './session-store.js';

type SessionHook = UseBoundStore<StoreApi<SessionState>>;

export function RequireAuth({
  useSession,
  loginPath,
}: {
  useSession: SessionHook;
  loginPath: string;
}): React.ReactElement {
  const status = useSession((state) => state.status);
  return status === 'authenticated' ? <Outlet /> : <Navigate to={loginPath} replace />;
}

export function RequirePermission({
  useSession,
  permission,
  fallback,
}: {
  useSession: SessionHook;
  permission: Permission;
  fallback: string;
}): React.ReactElement {
  const allowed = useSession((state) => state.can(permission));
  return allowed ? <Outlet /> : <Navigate to={fallback} replace />;
}
```

- [ ] **Step 3: ส่งออกและ build**

`packages/web-kit/src/index.ts`:

```ts
export * from './http.js';
export * from './routes.js';
export * from './session-store.js';
export * from './business-day.js';
export * from './route-guards.js';
```

```bash
pnpm --filter @pos/web-kit build
```

Expected: ผ่าน

- [ ] **Step 4: สร้างตัวห่อในฝั่งหน้าร้าน**

`apps/web/src/business-day.ts` — แทนที่เนื้อเดิมทั้งไฟล์ด้วย:

```ts
import { createUseBusinessToday } from '@pos/web-kit';
import { useSession } from './session.js';

/** Today in the branch's terms: its timezone, its cutoff hour. */
export const useBusinessToday = createUseBusinessToday(useSession);
```

`apps/web/src/route-guards.tsx` — แทนที่เนื้อเดิมทั้งไฟล์ด้วย:

```tsx
import {
  RequireAuth as SharedRequireAuth,
  RequirePermission as SharedRequirePermission,
  path,
} from '@pos/web-kit';
import type { Permission } from '@pos/shared';
import { useSession } from './session.js';

export function RequireAuth(): React.ReactElement {
  return <SharedRequireAuth useSession={useSession} loginPath={path.login} />;
}

export function RequirePermission({ permission }: { permission: Permission }): React.ReactElement {
  return (
    <SharedRequirePermission useSession={useSession} permission={permission} fallback={path.tables} />
  );
}
```

ทั้งสองไฟล์คงชื่อ export เดิม ผู้เรียกทั้งหมดจึงไม่ต้องแก้อะไรเลย

- [ ] **Step 5: รันเทสต์**

```bash
pnpm typecheck && pnpm test && pnpm lint
```

Expected: `@pos/web` 364 ผ่าน · `@pos/web-kit` 12 ผ่าน · typecheck และ lint ผ่าน

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: move business-day and route guards into @pos/web-kit"
```

---

## Task 6: แยก endpoint ของหลังร้านออกจาก `api-client.ts`

**Files:**
- Create: `apps/web/src/api-office.ts` (ที่พักชั่วคราว ย้ายไป `apps/office` ใน Task 9)
- Modify: `apps/web/src/api-client.ts`
- Modify: ไฟล์หลังร้านที่เรียก endpoint เหล่านั้น

**Interfaces:**
- Consumes: `http` จาก Task 2
- Produces: `export const officeApi` ที่มีเมธอดของหลังร้านทั้งหมด โดยชื่อเมธอด **เหมือนเดิมทุกตัว** (เช่น `officeApi.payroll(month)` ไม่ใช่ `officeApi.getPayroll`)

- [ ] **Step 1: แยกไฟล์**

`api.*` เดิมมี **101 เมธอด** แบ่งได้สามกอง ยกบล็อกมาทั้งชุดพร้อมคอมเมนต์เดิม อย่าเปลี่ยนชื่อเมธอดแม้แต่ตัวเดียว

**กอง A — ย้ายไป `api-office.ts` (53 เมธอด):**

```
manageMenu createCategory updateCategory deleteCategory moveCategory
createMenuItem updateMenuItem moveMenuItem setMenuItemAvailability deleteMenuItem
saveMenuItemRecipe createIngredient updateIngredient deleteIngredient
createModifierGroup updateModifierGroup deleteModifierGroup
createModifier updateModifier deleteModifier saveModifierRecipe
manageTables createTable updateTable deleteTable moveTable rotateTableQr setQrOrdering
dailyReport pnl voidReport
expenses createExpense updateExpense deleteExpense
staff createStaff updateStaff setStaffPin deleteStaff
deductions createDeduction deleteDeduction
payroll generatePayroll updatePayrollLine payPayroll unpayPayroll discardPayroll
branches createBranch updateBranch allBranches
```

**กอง B — คัดลอกไปทั้งสองไฟล์ (5 เมธอด):** `loginBranches` `staffList` `login` `logout` `me`

ทั้งสองแอปต้องล็อกอินเอง และ `createSessionStore` ต้องการครบทั้ง `me`/`login`/`logout`
· นี่เป็นการซ้ำที่ตั้งใจและอายุสั้น — **แผนที่ 2 จะแทนที่ทั้งห้าตัวในฝั่ง office ด้วยล็อกอินอีเมล**

**กอง C — อยู่ใน `api-client.ts` ต่อไป (43 เมธอด):** ที่เหลือทั้งหมด — `call` `health` `dbHealth` `menu` `tables` orders shifts kitchen print promptpay qr `paidBills` `issueTaxInvoice` `issueCreditNote`

> ระวังคู่ที่ชื่อคล้ายกันแต่คนละกอง: `tables` (ผังโต๊ะที่แคชเชียร์แตะ — กอง C) กับ `manageTables` (ตัวแก้ผัง — กอง A) · `moveBillToTable` (ย้ายบิล — กอง C) กับ `moveTable` (สลับลำดับโต๊ะ — กอง A)

โครงไฟล์ `apps/web/src/api-office.ts`:

```ts
/**
 * The back office's endpoints.
 *
 * Split from the till's client so neither app ships the other's surface: the
 * office has no business holding a "pay this bill" call, and the till has no
 * business holding "pay this month's wages".
 *
 * The five auth methods are duplicated rather than shared. They are the one
 * place the two apps genuinely do the same thing today — and the one place
 * they are about to stop: plan 2 replaces this file's copy with an email
 * login while the till keeps its PIN. Sharing them now would have to be
 * unpicked then.
 */

import { createHttp } from '@pos/web-kit';
import type { MeResponse, SessionUser, BranchChoiceList, StaffPublic /* …และ type ของกอง A ตามที่ tsc ฟ้อง… */ } from '@pos/shared';

const API_BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001/api';
const { request, post, put, del } = createHttp(API_BASE);

export const officeApi = {
  /* กอง B: ยกมาจาก api-client.ts ตรง ๆ ทั้งห้าตัว */
  /* กอง A: ยกมาจาก api-client.ts ตรง ๆ ทั้ง 53 ตัว */
};
```

> วิธีที่เร็วและพลาดยากที่สุดคือ **ตัดบล็อกจาก `api-client.ts` แล้ววาง** ทีละกอง แล้วให้ `tsc` เป็นคนบอกว่าขาด type ตัวไหน — อย่าไล่พิมพ์ import เอง

- [ ] **Step 2: ชี้ import ของหน้าจอหลังร้านไปที่ไฟล์ใหม่**

```bash
node -e "
const fs=require('fs'),cp=require('child_process');
const files=cp.execSync('git grep -l \"api-client.js\" -- apps/web/src/pages/office apps/web/src/components/office apps/web/src/manage-store.ts',{encoding:'utf8'}).trim().split('\n').filter(Boolean);
for(const f of files){
  const depth=f.split('/').length-3;
  const up='../'.repeat(depth)||'./';
  const before=fs.readFileSync(f,'utf8');
  const after=before
    .replace(/from '(?:\.\.\/)*(?:\.\/)?api-client\.js'/g, \`from '\${up}api-office.js'\`)
    .replace(/\bapi\./g,'officeApi.')
    .replace(/\{ api \}/g,'{ officeApi }');
  if(before!==after){fs.writeFileSync(f,after);console.log('patched',f);}
}
"
```

- [ ] **Step 3: แก้ mock ในเทสต์หลังร้าน**

เทสต์หลังร้าน 12 ไฟล์ `vi.mock('../../api-client.js', ...)` ต้องชี้ไป `api-office.js` และเปลี่ยนชื่อ export ใน mock จาก `api` เป็น `officeApi` — **นี่คือการแก้บรรทัด import/mock ซึ่งอนุญาต** แต่ `expect` ห้ามแตะ

```bash
git grep -n "api-client" -- apps/web/src/pages/office apps/web/src/components/office
```

Expected: ไม่มีผลลัพธ์

- [ ] **Step 4: รันเทสต์**

```bash
pnpm typecheck && pnpm test
```

Expected: `@pos/web` **364 ผ่าน** — จำนวนต้องไม่เปลี่ยน

- [ ] **Step 5: ตรวจว่าไม่มี endpoint ตกหล่นหรือซ้ำ**

```bash
node -e "
const fs=require('fs');
const grab=f=>[...fs.readFileSync(f,'utf8').matchAll(/['\`](\/[a-z][^'\`\$]*)['\`\$]/g)].map(m=>m[1]);
const a=new Set(grab('apps/web/src/api-client.ts')), b=new Set(grab('apps/web/src/api-office.ts'));
const both=[...a].filter(p=>b.has(p));
console.log('ซ้ำสองไฟล์:', both.length?both:'ไม่มี');
"
```

Expected: `ไม่มี`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: split the back office endpoints out of the till's api client"
```

---

## Task 7: สร้าง `apps/office` ที่ build ผ่าน (ยังไม่มีหน้า)

**Files:**
- Create: `apps/office/package.json` · `tsconfig.json` · `vite.config.ts` · `index.html` · `.env.example`
- Create: `apps/office/src/main.tsx` · `App.tsx` (ชั่วคราว) · `index.css` · `test-setup.ts`
- Modify: `package.json` (root) — เพิ่ม `dev:office`

**Interfaces:**
- Consumes: `@pos/web-kit` ทั้งหมด
- Produces: แอปที่ `pnpm --filter @pos/office build` ผ่าน และเปิดที่ `:5174` ได้

- [ ] **Step 1: `package.json`**

`apps/office/package.json` — เหมือน `apps/web` แต่ **ไม่มี `dexie`, ไม่มี `vite-plugin-pwa`**:

```json
{
  "name": "@pos/office",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@pos/shared": "workspace:*",
    "@pos/web-kit": "workspace:*",
    "qrcode.react": "^4.2.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.18.1",
    "zustand": "^5.0.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.0.7",
    "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^26.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.3",
    "vite": "^6.0.7",
    "vitest": "^3.0.5"
  }
}
```

`qrcode.react` ตามมาด้วยเพราะ `ManageTablesPage` พิมพ์สติกเกอร์ QR

- [ ] **Step 2: `tsconfig.json`**

`apps/office/tsconfig.json` — เหมือน `apps/web` แต่ตัด `vite-plugin-pwa/client` ออก:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "allowImportingTsExtensions": false,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src/**/*", "vite.config.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: `vite.config.ts`**

`apps/office/vite.config.ts` — **ไม่มี `VitePWA` และไม่มี `manualChunks`** โดยตั้งใจ:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The back office. A plain SPA, deliberately.
 *
 * NO service worker and NO precache. This site is always online by definition,
 * and a worker holding a stale payroll screen is a class of bug nobody wants
 * to chase. The till is the app that needs to survive dead wifi; this one has
 * a browser error page and that is the correct answer.
 *
 * bundle-boundary.test.ts asserts the built output contains no service worker,
 * so adding one here fails the build rather than quietly landing on a tablet.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, host: true },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 4: ไฟล์ประกอบ**

`apps/office/index.html` — ลอกจาก `apps/web/index.html` แล้วเปลี่ยน `<title>` เป็น `หลังร้าน` และเอาแท็กที่เกี่ยวกับ PWA/manifest ออกให้หมด

`apps/office/.env.example`:

```
# Copy to apps/office/.env
VITE_API_URL="http://localhost:3001/api"
```

`apps/office/src/test-setup.ts` — ลอกจาก `apps/web/src/test-setup.ts` แต่ **ตัดทุกบรรทัดที่เกี่ยวกับ `fake-indexeddb`** ออก (หลังร้านไม่มีฐานข้อมูลบนเครื่อง)

`apps/office/src/index.css` — ลอกจาก `apps/web/src/index.css`

> `session.ts` · `business-day.ts` · `route-guards.tsx` **ยังไม่สร้างใน task นี้** — ทั้งสามต้องการ `api-office.ts` ซึ่งยังอยู่ใน `apps/web` จนถึง Task 8 · task นี้ทำแค่โครงที่ build ผ่านโดยไม่พึ่งอะไรเลย

- [ ] **Step 5: `App.tsx` และ `main.tsx` ชั่วคราว**

`apps/office/src/App.tsx` — ชั่วคราว จะถูกแทนที่ใน Task 8:

```tsx
export function App(): React.ReactElement {
  return <p>หลังร้าน</p>;
}
```

`apps/office/src/main.tsx` — ลอกจาก `apps/web/src/main.tsx` แล้ว **ลบทุกบรรทัดที่ลงทะเบียน service worker** ออก

- [ ] **Step 6: เพิ่มสคริปต์ที่ root**

`package.json` (root) — เพิ่มใน `scripts` ต่อจาก `dev:web`:

```json
    "dev:office": "pnpm build:shared && pnpm --filter @pos/office dev",
```

และแก้ `build:shared` ให้ build `web-kit` ด้วย:

```json
    "build:shared": "pnpm --filter @pos/shared build && pnpm --filter @pos/web-kit build",
```

- [ ] **Step 7: ติดตั้งและ build**

```bash
pnpm install && pnpm --filter @pos/office build
```

Expected: สร้าง `apps/office/dist/` โดยไม่มี error และ **ไม่มีไฟล์ `sw.js`**

```bash
ls apps/office/dist
```

Expected: มี `index.html` และ `assets/` เท่านั้น ไม่มี `sw.js` ไม่มี `manifest.webmanifest`

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold the back office as its own app"
```

---

## Task 8: ย้ายหน้าและเทสต์หลังร้านเข้า `apps/office`

**Files:**
- Move: 34 ไฟล์ (ดูรายการใน File Structure)
- Create: `apps/office/src/session.ts` · `business-day.ts` · `route-guards.tsx` · `pages/LoginPage.tsx`
- Modify: `apps/office/src/App.tsx`
- Delete: `apps/web/src/office-gate.tsx` + `.test.tsx`

**Interfaces:**
- Consumes: โครงจาก Task 7 · `officeApi` จาก Task 6
- Produces: `apps/office` ที่รัน **112 เทสต์ผ่าน** และ `apps/web` เหลือ 252 ผ่าน

- [ ] **Step 1: ย้ายไฟล์**

```bash
mkdir -p apps/office/src/pages apps/office/src/components
git mv apps/web/src/pages/office/* apps/office/src/pages/
git mv apps/web/src/components/office/* apps/office/src/components/
git mv apps/web/src/api-office.ts apps/office/src/api-office.ts
git mv apps/web/src/manage-store.ts apps/office/src/manage-store.ts
git mv apps/web/src/manage-store.test.ts apps/office/src/manage-store.test.ts
rmdir apps/web/src/pages/office apps/web/src/components/office
```

- [ ] **Step 2: แก้ความลึกของ import**

หน้าเดิมอยู่ลึก 2 ชั้น (`pages/office/X.tsx` → `../../api-office.js`) ตอนนี้ลึกชั้นเดียว:

```bash
node -e "
const fs=require('fs'),cp=require('child_process');
const files=cp.execSync('git ls-files apps/office/src',{encoding:'utf8'}).trim().split('\n').filter(Boolean);
const local=['api-office','session','business-day','route-guards','manage-store'];
for(const f of files){
  if(!/\.(ts|tsx)$/.test(f))continue;
  const depth=f.split('/').length-3;               // src/X.ts = 0, src/pages/X.tsx = 1
  const before=fs.readFileSync(f,'utf8');
  let after=before;
  for(const name of local){
    after=after.replace(new RegExp(\"'(?:\\\\.\\\\./)*(?:\\\\./)?\"+name+\"\\\\.js'\",'g'), \"'\"+('../'.repeat(depth)||'./')+name+\".js'\");
  }
  // components/office/X -> components/X, pages/office/X -> pages/X
  after=after.replace(/'((?:\.\.\/)*)components\/office\//g,\"'\$1components/\");
  if(before!==after){fs.writeFileSync(f,after);console.log('patched',f);}
}
"
```

- [ ] **Step 3: สร้างตัวเชื่อมสามไฟล์**

ตอนนี้ `api-office.ts` อยู่ใน `apps/office` แล้ว จึงสร้างสามไฟล์นี้ได้

`apps/office/src/session.ts`:

```ts
/**
 * The back office's session: the shared store with NO persistence.
 *
 * Nothing is cached on the device. A dead connection reads as "not logged in",
 * which is correct here — an identity cached in a browser is an identity that
 * outlives its own revocation, and this site is on the open internet.
 */

import { createSessionStore } from '@pos/web-kit';
import { officeApi } from './api-office.js';

export const useSession = createSessionStore({ api: officeApi });
```

`apps/office/src/business-day.ts`:

```ts
import { createUseBusinessToday } from '@pos/web-kit';
import { useSession } from './session.js';

export const useBusinessToday = createUseBusinessToday(useSession);
```

`apps/office/src/route-guards.tsx`:

```tsx
import {
  RequireAuth as SharedRequireAuth,
  RequirePermission as SharedRequirePermission,
  path,
} from '@pos/web-kit';
import type { Permission } from '@pos/shared';
import { useSession } from './session.js';

export function RequireAuth(): React.ReactElement {
  return <SharedRequireAuth useSession={useSession} loginPath={path.login} />;
}

/** Denied lands on the menu, not the till's floor plan — that is another site now. */
export function RequirePermission({ permission }: { permission: Permission }): React.ReactElement {
  return (
    <SharedRequirePermission useSession={useSession} permission={permission} fallback={path.menu} />
  );
}
```

- [ ] **Step 4: หน้าล็อกอินของหลังร้าน (ชั่วคราว)**

หน้าจอเดียวที่แผนนี้สร้างใหม่ · จำเป็นเพราะคุกกี้ของ `shop.*` ไม่ถูกส่งไป `office.*`
ซึ่งเป็นผลที่ตั้งใจของการแยกโดเมน — ถ้าไม่มีหน้านี้ แยกเสร็จแล้วไม่มีใครเข้าหลังร้านได้เลย

**แผนที่ 2 จะลบไฟล์นี้ทิ้งแล้วเขียนใหม่เป็นอีเมล+รหัสผ่าน** ทำให้เล็กที่สุดเท่าที่ใช้ได้
ไม่ต้องลอก `LoginPage` ของหน้าร้านมา (277 บรรทัด พร้อม Keypad ที่ออกแบบมาสำหรับนิ้วบนแท็บเล็ต) —
หลังร้านเปิดบนคอมที่มีคีย์บอร์ด

> **ไฟล์นี้จงใจไม่มีเทสต์** ซึ่งขัดกับวัฒนธรรมของโปรเจกต์ และเป็นการยกเว้นที่บันทึกไว้ตรงนี้:
> มันจะถูกลบทิ้งในแผนที่ 2 · **แผนที่ 2 ต้องมีเทสต์ให้หน้าล็อกอินตัวจริงครบ** —
> ล็อกอินผิดแล้วล้างรหัส · บัญชีถูกล็อกแล้วขึ้นข้อความ · สำเร็จแล้วไปหน้าเมนู ·
> และที่สำคัญที่สุด: หน้านี้ต้องไม่มีรายชื่อพนักงานให้เลือก

`apps/office/src/pages/LoginPage.tsx`:

```tsx
/**
 * The back office login — deliberately minimal and deliberately temporary.
 *
 * Still the till's PIN, because plan 1 changes nothing about how the API
 * authenticates. Plan 2 replaces this whole file with an email and password
 * form, so nothing here is worth polishing.
 *
 * It exists at all because the two sites no longer share a cookie: that is the
 * point of splitting them, and it means the office needs its own door.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { path } from '@pos/web-kit';
import type { StaffPublic } from '@pos/shared';
import { officeApi } from '../api-office.js';
import { useSession } from '../session.js';

export function LoginPage(): React.ReactElement {
  const [staff, setStaff] = useState<StaffPublic[]>([]);
  const [staffId, setStaffId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const login = useSession((state) => state.login);
  const navigate = useNavigate();

  useEffect(() => {
    void officeApi.staffList().then((result) => {
      if (result.ok) setStaff(result.data.staff);
      else setError(result.error);
    });
  }, []);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    const result = await login(staffId, pin);
    if (result.ok) navigate(path.menu, { replace: true });
    else {
      setError(result.error);
      setPin('');
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-80 space-y-4">
      <h1 className="text-xl font-medium">หลังร้าน</h1>

      <label className="block">
        <span className="text-sm text-slate-600">ชื่อ</span>
        <select
          aria-label="ชื่อ"
          value={staffId}
          onChange={(event) => setStaffId(event.target.value)}
          className="h-11 w-full rounded-xl border border-slate-300 px-2"
        >
          <option value="">— เลือกชื่อ —</option>
          {staff.map((person) => (
            <option key={person.id} value={person.id}>
              {person.nickname ?? person.fullName}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm text-slate-600">PIN 4 หลัก</span>
        <input
          aria-label="PIN 4 หลัก"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
          className="tnum h-11 w-full rounded-xl border border-slate-300 px-2"
        />
      </label>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={staffId === '' || pin.length !== 4}
        className="h-11 w-full rounded-xl bg-slate-900 text-white disabled:bg-slate-300"
      >
        เข้าสู่ระบบ
      </button>
    </form>
  );
}
```

- [ ] **Step 5: เขียน `App.tsx` ของหลังร้าน**

`apps/office/src/App.tsx` — ยกเนื้อจาก `apps/web/src/pages/office/routes.tsx` เดิม (ตอนนี้อยู่ที่ `apps/office/src/pages/routes.tsx`) มาห่อด้วย router และ session boot:

```tsx
/**
 * The back office app shell.
 *
 * One world, unlike the till's three: there is no customer route and no sync
 * loop, because there is nothing on this device to sync. The session is
 * checked once on boot and a failure means the login screen — there is no
 * cached identity to fall back to, on purpose.
 *
 * The permissions below are the ones these screens have always had. They are
 * repeated per group rather than hoisted because they are NOT the same
 * permission — a manager who may price the menu may not read a wage, and
 * flattening them into one gate would be a real widening.
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Permission } from '@pos/shared';
import { path } from '@pos/web-kit';
import { RequireAuth, RequirePermission } from './route-guards.js';
import { useSession } from './session.js';
import { LoginPage } from './pages/LoginPage.js';
import { AllBranchesPage } from './pages/AllBranchesPage.js';
import { BranchesPage } from './pages/BranchesPage.js';
import { DailyReportPage } from './pages/DailyReportPage.js';
import { DeductionsPage } from './pages/DeductionsPage.js';
import { ExpensesPage } from './pages/ExpensesPage.js';
import { ManageIngredientsPage } from './pages/ManageIngredientsPage.js';
import { ManageMenuPage } from './pages/ManageMenuPage.js';
import { ManageOptionsPage } from './pages/ManageOptionsPage.js';
import { ManageTablesPage } from './pages/ManageTablesPage.js';
import { PayrollPage } from './pages/PayrollPage.js';
import { PnlPage } from './pages/PnlPage.js';
import { StaffListPage } from './pages/StaffListPage.js';
import { VoidReportPage } from './pages/VoidReportPage.js';

export function App(): React.ReactElement {
  const status = useSession((state) => state.status);
  const refresh = useSession((state) => state.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (status === 'loading') return <p className="p-8 text-slate-500">กำลังโหลด…</p>;

  return (
    <Routes>
      {/* Outside the guard, or logging in would redirect to itself forever. */}
      <Route path={path.login} element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route index element={<Navigate to={path.menu} replace />} />

        <Route element={<RequirePermission permission={Permission.MANAGE_MENU} />}>
          <Route path={path.menu} element={<ManageMenuPage />} />
          <Route path={path.options} element={<ManageOptionsPage />} />
          <Route path={path.ingredients} element={<ManageIngredientsPage />} />
        </Route>

        <Route element={<RequirePermission permission={Permission.MANAGE_TABLES} />}>
          <Route path={path.manageTables} element={<ManageTablesPage />} />
        </Route>

        <Route element={<RequirePermission permission={Permission.VIEW_REPORTS} />}>
          <Route path={path.reportDaily} element={<DailyReportPage />} />
          <Route path={path.reportExpenses} element={<ExpensesPage />} />
          <Route path={path.reportPnl} element={<PnlPage />} />
          <Route path={path.reportVoids} element={<VoidReportPage />} />
        </Route>

        <Route element={<RequirePermission permission={Permission.VIEW_PAYROLL} />}>
          <Route path={path.staffPeople} element={<StaffListPage />} />
          <Route path={path.staffDeductions} element={<DeductionsPage />} />
          <Route path={path.staffPayroll} element={<PayrollPage />} />
        </Route>

        <Route element={<RequirePermission permission={Permission.MANAGE_BRANCH} />}>
          <Route path={path.settingsBranches} element={<BranchesPage />} />
        </Route>
        <Route element={<RequirePermission permission={Permission.VIEW_ALL_BRANCHES} />}>
          <Route path={path.settingsAllBranches} element={<AllBranchesPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to={path.menu} replace />} />
    </Routes>
  );
}
```

```bash
git rm apps/office/src/pages/routes.tsx
```

- [ ] **Step 6: รันเทสต์ของหลังร้าน**

```bash
pnpm --filter @pos/office test
```

Expected: **12 ไฟล์ · 112 เทสต์ผ่าน**

ถ้าล้มเพราะหา module ไม่เจอ ให้ตามแก้ path · ถ้าล้มที่ `expect` ให้หยุดแล้วรายงาน

- [ ] **Step 7: ลบ `OfficeGate` และเส้นทางหลังร้านออกจาก `apps/web`**

```bash
git rm apps/web/src/office-gate.tsx apps/web/src/office-gate.test.tsx
```

ใน `apps/web/src/App.tsx` ลบ:
- `const OfficeRoutes = lazy(() => import('./pages/office/routes.js')...)`
- `import { OfficeGate } from './office-gate.js';`
- `<Route path="/office/*" ...>` ทั้งบล็อก
- redirect ของ URL เก่าที่ชี้ไป `/office/*` (`/manage/*` `/reports/*` `/staff/*` `/settings/*`)
- `import { lazy } from 'react'` ถ้าไม่มีที่ใช้แล้ว

แล้วแก้คอมเมนต์หัวไฟล์ให้ตรงกับความจริงใหม่: เหลือสองโลก (`/t/:token` กับ `/pos/*`) ไม่ใช่สาม

- [ ] **Step 8: รันเทสต์ทั้ง workspace**

```bash
pnpm typecheck && pnpm test
```

Expected: `@pos/web` **252 ผ่าน** (364 − 112) · `@pos/office` 112 ผ่าน · `@pos/web-kit` 12 ผ่าน · `@pos/shared` 405 ผ่าน

> `bundle-boundary.test.ts` จะล้มตรงนี้ เพราะมันยังตรวจของที่ไม่มีแล้ว — Task 9 เขียนใหม่ · ถ้าอยากให้ขั้นนี้เขียว ให้ `it.skip` ไว้ทั้งไฟล์ก่อนแล้วปลดใน Task 9

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: move the back office screens into apps/office"
```

---

## Task 9: เขียนเทสต์ขอบเขตชุดใหม่

**Files:**
- Rewrite: `apps/web/src/bundle-boundary.test.ts`

**Interfaces:**
- Consumes: `apps/web/dist` และ `apps/office/dist` ที่ build แล้ว
- Produces: เทสต์ 5 ตัวที่พิสูจน์ 4 เงื่อนไขใน spec §6.3

- [ ] **Step 1: build ทั้งสองแอปเพื่อให้มีของให้ตรวจ**

```bash
pnpm build
```

Expected: ผ่านทั้ง 4 workspace

- [ ] **Step 2: เขียนไฟล์เทสต์ใหม่ทั้งไฟล์**

`apps/web/src/bundle-boundary.test.ts`:

```ts
/**
 * The boundary between the two sites, checked against what actually shipped.
 *
 * This reads the BUILT output, not the source, because the mistake it exists
 * to catch is a build-config mistake: a payroll screen that lands on the till's
 * disk looks completely normal in the source tree and completely normal on a
 * desk with wifi. It only shows up at 12:30 when the tablet is full of code it
 * has no business holding.
 *
 * Run `pnpm build` first. The tests skip themselves rather than fail when
 * dist/ is missing, so a fresh clone running `pnpm test` is not greeted by a
 * red suite it cannot fix by writing code.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TILL_DIST = join(__dirname, '../dist');
const OFFICE_DIST = join(__dirname, '../../office/dist');
const OFFICE_PKG = join(__dirname, '../../office/package.json');

const built = existsSync(TILL_DIST) && existsSync(OFFICE_DIST);
const suite = built ? describe : describe.skip;

/**
 * Walked by hand rather than with readdirSync({ recursive: true }), whose
 * `parentPath` on the returned entries only exists from Node 20.12 — and this
 * repo's floor is 20.11.
 */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const readAllJs = (dist: string): string =>
  filesUnder(dist)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

suite('the till bundle', () => {
  it('carries no back-office screen', () => {
    // Names that exist only in apps/office. If one of these turns up here,
    // something imported across the line and the tablet is carrying wages.
    const officeOnly = ['ManageMenuPage', 'PayrollPage', 'DeductionsPage', 'AllBranchesPage'];
    const js = readAllJs(TILL_DIST);
    for (const name of officeOnly) expect(js).not.toContain(name);
  });

  it('precaches the screens that must open with the wifi down', () => {
    const sw = readFileSync(join(TILL_DIST, 'sw.js'), 'utf8');
    // The shell answers any route from cache; without this a reload onto
    // /pos/order/<uuid> — where the tablet lands after every reload — asks the
    // server for a page it cannot reach.
    expect(sw).toContain('index.html');
    const precachedJs = [...sw.matchAll(/assets\/[^"']+\.js/g)].map((m) => m[0]);
    expect(precachedJs.length).toBeGreaterThan(0);
  });

  it('still ships a service worker at all', () => {
    // The inverse mistake: making this file pass by breaking the PWA.
    expect(existsSync(join(TILL_DIST, 'sw.js'))).toBe(true);
    expect(existsSync(join(TILL_DIST, 'manifest.webmanifest'))).toBe(true);
  });
});

suite('the office bundle', () => {
  it('ships no service worker and no manifest', () => {
    // A worker here would cache a payroll figure and serve it after the number
    // changed, and nothing on screen would say so.
    expect(existsSync(join(OFFICE_DIST, 'sw.js'))).toBe(false);
    expect(existsSync(join(OFFICE_DIST, 'manifest.webmanifest'))).toBe(false);
    expect(readAllJs(OFFICE_DIST)).not.toContain('serviceWorker');
  });

  it('declares no local-database dependency', () => {
    // Checked against the manifest rather than by grepping the bundle for
    // "indexedDB": that string turns up inside unrelated vendor code and the
    // false positive would get the whole test deleted by whoever hits it.
    const pkg = JSON.parse(readFileSync(OFFICE_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(declared)).not.toContain('dexie');
    expect(Object.keys(declared)).not.toContain('fake-indexeddb');
    expect(Object.keys(declared)).not.toContain('vite-plugin-pwa');
  });

  it('does not reach across into the till`s offline layer', () => {
    // The office is a separate package, so this cannot compile — but a relative
    // path that climbs out of apps/office would, and this is the cheap guard.
    const offlineOnly = ['outbox', 'IDENTITY_KEY', 'clearLocalData'];
    const js = readAllJs(OFFICE_DIST);
    for (const name of offlineOnly) expect(js).not.toContain(name);
  });
});
```

- [ ] **Step 3: รันเทสต์**

```bash
pnpm --filter @pos/web test src/bundle-boundary.test.ts
```

Expected: PASS 5 เทสต์

- [ ] **Step 4: พิสูจน์ว่ามันจับได้จริง**

เทสต์ที่ไม่เคยเห็นสีแดงคือเทสต์ที่ยังไม่รู้ว่าตัวเองทำงานไหม ลองทำให้พังทีละอย่างแล้วยืนยันว่าล้ม:

1. เพิ่ม `import { PayrollPage } from '@pos/office/src/pages/PayrollPage.js'` เข้า `apps/web/src/App.tsx` ชั่วคราว → `pnpm build && pnpm --filter @pos/web test src/bundle-boundary.test.ts` → ต้องล้มข้อ "carries no back-office screen" → ถอดออก
2. เพิ่ม `VitePWA({})` เข้า `apps/office/vite.config.ts` ชั่วคราว → build แล้วรัน → ต้องล้มข้อ "ships no service worker" → ถอดออก

บันทึกผลทั้งสองข้อไว้ใน commit message

- [ ] **Step 5: รันทุกอย่างให้เขียว**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Expected: ผ่านหมด · `@pos/web` 252 · `@pos/office` 112 · `@pos/web-kit` 12 · `@pos/shared` 405 · `@pos/print-agent` 15

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test: rewrite the bundle boundary checks for two apps

Proved both directions fail: importing an office page into the till trips
'carries no back-office screen', and adding VitePWA to the office config trips
'ships no service worker'."
```

---

## Task 10: วัดผลและอัปเดตเอกสาร

**Files:**
- Modify: `README.md` (หัวข้อ "หน้าร้าน กับ หลังร้าน" · "โครงสร้างโปรเจกต์" · "รันระบบ" · "เทสต์")
- Modify: `.claude/launch.json`

**Interfaces:**
- Consumes: ผลลัพธ์ทุก task ก่อนหน้า
- Produces: README ที่ตรงกับความจริงใหม่ และตัวเลขขนาดบันเดิลก่อน/หลัง

- [ ] **Step 1: วัดขนาดบันเดิล**

```bash
pnpm build
```

```bash
node -e "
const fs=require('fs'),p=require('path');
for(const [name,dir] of [['till','apps/web/dist/assets'],['office','apps/office/dist/assets']]){
  const total=fs.readdirSync(dir).filter(f=>f.endsWith('.js'))
    .reduce((n,f)=>n+fs.statSync(p.join(dir,f)).size,0);
  console.log(name, total.toLocaleString(), 'bytes');
}
"
```

บันทึกตัวเลขไว้ · **ฝั่ง till ต้องน้อยกว่า 296,843 bytes ที่เป็นฐานเดิม** ถ้ามากกว่า แปลว่ามีอะไรข้ามเส้นมา ให้หยุดแล้วหา

- [ ] **Step 2: เพิ่ม office เข้า `launch.json`**

`.claude/launch.json` — เพิ่มใน `configurations`:

```json
    {
      "name": "office",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dev:office"],
      "port": 5174
    }
```

- [ ] **Step 3: แก้ README**

แก้สี่จุดให้ตรงกับความจริง:

1. **"โครงสร้างโปรเจกต์"** — เพิ่ม `apps/office/` และ `packages/web-kit/` ในผัง
2. **"รันระบบ"** — เพิ่ม `pnpm dev:office` และ `http://localhost:5174`
3. **"หน้าร้าน กับ หลังร้าน — `/pos` กับ `/office`"** — เขียนใหม่ทั้งหัวข้อ · เดิมอธิบายการแยกด้วย lazy chunk + `globIgnores` ซึ่ง**ไม่มีอยู่แล้ว** · ของใหม่คือแยกด้วยแอปและโดเมน · **เก็บย่อหน้า "lazy กับ precache เป็นสิ่งตรงข้ามกัน" ไว้เป็นบันทึกว่าเคยทำแบบนั้นและทำไมถึงเลิก** ไม่ใช่ลบทิ้ง
4. **"เทสต์"** — แก้ตัวเลขเป็น `@pos/web` 252 · `@pos/office` 112 · `@pos/web-kit` 12 และเพิ่มบรรทัดของ `web-kit` ในตาราง

- [ ] **Step 4: ยืนยันครั้งสุดท้าย**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
```

Expected: ผ่านทั้งหมด

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: update README and launch config for the two-app layout"
```

---

## เสร็จแล้วได้อะไร

- `apps/web` เหลือเฉพาะหน้าร้าน · 252 เทสต์ · ยังเป็น PWA ที่ทำงานตอนเน็ตหลุดเหมือนเดิมทุกอย่าง
- `apps/office` เป็นแอปของตัวเอง · 112 เทสต์ · ไม่มี service worker ไม่มี IndexedDB
- `packages/web-kit` · 12 เทสต์
- บันเดิลที่แท็บเล็ตแคชเล็กลงจากฐานเดิม
- เทสต์ขอบเขต 5 ตัวที่พิสูจน์แล้วว่าจับได้จริงทั้งสองทาง

**ยังทำไม่ได้:** เจ้าของยังล็อกอินหลังร้านด้วยอีเมลไม่ได้ (ยังเป็น PIN) และยังไม่ได้ deploy — สองเรื่องนี้อยู่ในแผนที่ 2 และ 3

## แผนถัดไป

| แผน | เรื่อง | สร้างเมื่อ |
|---|---|---|
| 1 | **แยกแอป** | ← เอกสารนี้ |
| 2 | auth ใหม่ — ตาราง `Session` · อีเมล+รหัสผ่าน · ปิด endpoint ที่เปิดโล่ง · หน้าล็อกอินหลังร้าน | หลังแผน 1 ผ่าน |
| 3 | deploy — Caddy · VPS · backup ที่ทดสอบกู้คืนแล้ว · CI · แก้เทสต์ flaky | หลังแผน 2 ผ่าน |
