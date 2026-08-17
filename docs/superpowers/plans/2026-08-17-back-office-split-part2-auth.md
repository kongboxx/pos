# แยกหลังร้านออกจากหน้าร้าน — แผนที่ 2: การเข้าสู่ระบบ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้ `office.<domain>` มีประตูของตัวเอง (อีเมล + รหัสผ่าน) · ทำให้ logout ฆ่าเซสชันได้จริงด้วยตาราง `Session` · และปิด `/auth/staff` กับ `/auth/branches` ที่ตอนนี้ใครเปิด URL ก็อ่านได้

**Architecture:** เพิ่มตาราง `Session` แล้วให้ JWT พก `jti` ชี้มาที่แถวนั้น ทุก request ตรวจว่าแถวยังมีชีวิต — นี่คือสิ่งที่ปิดช่องที่ README ยอมรับไว้เองว่า "JWT ที่ถูกก๊อปไว้ก่อนหน้ายังใช้ได้จนหมดอายุ" · หน้าร้านยังเป็น PIN ไม่เปลี่ยนอะไรเลย หลังร้านได้ endpoint ใหม่ `POST /auth/office/login` ที่รับอีเมล+รหัสผ่าน · ฝั่งเว็บ `createSessionStore` เปลี่ยนจากรับ `(staffId, pin, branchId)` เป็นรับ credentials ที่เป็น generic เพื่อให้สองแอปส่งกุญแจคนละชนิดเข้าไปได้โดยไม่มี `if`

**Tech Stack:** Fastify 5 · Prisma 6 + PostgreSQL · @fastify/jwt · bcryptjs · zod · vitest 3 · React 19 · zustand 5

**Spec:** [`docs/superpowers/specs/2026-08-06-back-office-split-design.md`](../specs/2026-08-06-back-office-split-design.md) §5 เป็นหลัก · §4.2 สำหรับ CORS และ Host

**แผนก่อนหน้า:** [`2026-08-06-back-office-split-part1-apps.md`](2026-08-06-back-office-split-part1-apps.md) — เสร็จแล้ว merge เข้า `main` ที่ `18c1fee`

---

## Global Constraints

- **เทสต์ต้องเขียวครบทุกขั้น** — ทุก task จบด้วย `pnpm test` ที่ผ่านทั้ง workspace ไม่มีขั้นไหนที่ยอมให้แดงค้างไว้
- **`@pos/api` ต้องมี Postgres** — `pnpm db:up && pnpm db:seed:demo` ก่อนเริ่ม แผนนี้แตะ API หนักจึงข้ามไม่ได้เหมือนแผนที่ 1
- **หน้าร้านห้ามเปลี่ยนพฤติกรรมการล็อกอิน** — PIN 4 หลัก · รายชื่อให้เลือก · ล็อก 5 นาทีหลังผิด 5 ครั้ง · แคชตัวตนลงเครื่องได้ตอนออฟไลน์ · ทั้งหมดนี้เหมือนเดิมทุกอย่าง สิ่งเดียวที่เพิ่มคือแถว `Session` และ `jti`
- **`packages/shared` ห้าม import React / react-router / zustand / `node:*`** — กฎเดิม · `TextEncoder` ใช้ได้ (มีทั้งใน Node และเบราว์เซอร์)
- **รหัสผ่านจริงของเจ้าของร้านห้ามอยู่ในโค้ด ในเทสต์ ใน commit หรือในบทสนทนา** — เจ้าของพิมพ์เองตอน seed ผ่าน `OWNER_PASSWORD` ในไฟล์ `.env` ที่ `.gitignore` กันไว้แล้ว
- **ห้าม log รหัสผ่าน PIN หรือ token** ไม่ว่าระดับไหน — ที่มีอยู่แล้วในโค้ดคือกฎนี้ อย่าทำให้เสีย
- **เงินเป็น `Int` สตางค์เสมอ** ESLint แบน `parseFloat` อยู่แล้ว อย่าปลด
- **ทุกตารางมี `branchId`** (กฎข้อ 1 ของโปรเจกต์) — `Session` ก็ด้วย
- **ทุกการเขียนที่เปลี่ยนสิทธิ์ต้องมี `AuditLog`** (กฎข้อ 8)
- Node ≥ 20.11 · pnpm 11.18.0 · TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (ทุก import ภายในลงท้าย `.js`)

**สถานะฐาน วัดไว้ 2026-08-17 ที่ `18c1fee` (ต้องไม่ต่ำกว่านี้ตอนจบทุก task):**

| ชุด                | เทสต์          |
| ------------------ | -------------- |
| `@pos/shared`      | 405 ผ่าน       |
| `@pos/api`         | 328 ผ่าน       |
| `@pos/web`         | 249 ผ่าน       |
| `@pos/office`      | 112 ผ่าน       |
| `@pos/print-agent` | 15 ผ่าน        |
| `@pos/web-kit`     | 12 ผ่าน        |
| **รวม**            | **1,121 ผ่าน** |

`pnpm typecheck` · `npx eslint .` · `npx prettier --check .` ต้องผ่านสะอาดตอนจบทุก task

> **ตัวเลข "คาดหวัง: N ผ่าน" ในทุก task เป็นการนับด้วยมือจากเทสต์ที่แผนนี้เขียนไว้ ไม่ใช่ค่าที่วัดมา** — แผนที่ 1 ทายตัวเลขพลาดสองครั้งด้วยเหตุผลแบบนี้ · ถ้าตัวเลขจริงไม่ตรงแต่**สูงกว่าหรือเท่ากับ**ฐานและไม่มีอะไรแดง ให้เดินต่อแล้วแก้ตัวเลขในแผน · ถ้า**ต่ำกว่า**ฐาน แปลว่ามีเทสต์หายไป ให้หยุด

---

## สามเรื่องที่แผนนี้ตัดสินเพิ่มจากสเปก

สเปก §5 เขียนไว้ก่อนลงมือ พอมาอ่านโค้ดจริงเจอสามเรื่องที่สเปกไม่ได้พูดถึงและต้องตัดสิน บันทึกไว้ตรงนี้เพื่อให้คนอ่านแผนไม่ต้องเดาว่าทำไมโค้ดไม่ตรงสเปกเป๊ะ

### ก. CORS ตอนนี้พัง — หลังร้านล็อกอินไม่ได้เลยตั้งแต่แผนที่ 1

`apps/api/src/app.ts:57` เขียนว่า `origin: [env.WEB_ORIGIN]` และ `env.WEB_ORIGIN` รับค่าเดียว default `http://localhost:5173` · `apps/office` รันที่ `:5174` และยิงตรงไป `http://localhost:3001/api` (ไม่มี vite proxy — ดู `apps/office/.env.example`) เบราว์เซอร์จึงบล็อกทุก request ของหลังร้านตั้งแต่ preflight

แผนที่ 1 ไม่เจอเพราะเทสต์ของ `apps/office` ทั้ง 112 ตัว stub `officeApi` ไว้หมด ไม่มีตัวไหนยิงข้ามพอร์ตจริง · **Task 1 แก้เรื่องนี้ก่อนเรื่องอื่น** เพราะถ้าไม่แก้ ทุก task หลังจากนี้ทดสอบด้วยมือไม่ได้เลย

### ข. คุกกี้ต้องคนละชื่อ ไม่ใช่ชื่อเดียวกันสองโดเมน

สเปกไม่ได้พูดถึงชื่อคุกกี้ · ปัญหาคือ **คุกกี้ไม่สนใจพอร์ต** — `localhost:5173` กับ `localhost:5174` ใช้คุกกี้ jar เดียวกัน ถ้าทั้งสองฝั่งเซ็ต `pos_session` เหมือนกัน การล็อกอินหลังร้านตอน dev จะเตะเซสชันหน้าร้านทิ้งทุกครั้ง และกลับกัน · บน production ไม่เจอ (คนละ host) แต่ตอน dev จะเจอวันละสิบรอบ

แผนนี้จึงแยกเป็น `pos_session` (POS) และ `office_session` (OFFICE) · ได้ผลพลอยได้ที่ตรงกับเจตนาของการแยกเว็บอยู่แล้ว: คุกกี้ของหลังร้านไม่ใช่คุกกี้ของหน้าร้าน จริงในระดับเบราว์เซอร์ ไม่ใช่แค่ในความตั้งใจ

ราคา: `@fastify/jwt` ตั้งชื่อคุกกี้ได้ชื่อเดียว จึงต้องเลิกใช้ `request.jwtVerify()` แล้วอ่านคุกกี้เองสองชื่อ (Task 4)

### ค. `ipHash` ต้องเป็น HMAC ไม่ใช่ sha256 เปล่า ๆ

สเปกเขียนว่า `ipHash // sha256 ของ IP ไม่เก็บ IP ดิบ` · sha256 ของ IPv4 **ไม่ใช่การปกปิด** — IPv4 มีแค่ 4 พันล้านค่า ทำตารางย้อนกลับทั้งช่องบนโน้ตบุ๊กใช้เวลาไม่กี่นาที · เก็บ sha256 เปล่ากับเก็บ IP ดิบต่างกันแค่ความรู้สึก

แผนนี้ใช้ `HMAC-SHA256` โดยมี `JWT_SECRET` เป็นกุญแจ · ยังเทียบ IP เดียวกันข้ามแถวได้เหมือนเดิม แต่ย้อนกลับไม่ได้ถ้าไม่มีกุญแจ

---

## File Structure

### สร้างใหม่

| ไฟล์                                                   | รับผิดชอบอะไร                                            |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `apps/api/src/rate-limit.ts`                           | `RateLimiter` (ย้ายมาจาก `modules/qr/`) ใช้ร่วมกันสองที่ |
| `apps/api/src/rate-limit.test.ts`                      | เทสต์เดิมของ RateLimiter ย้ายตามมา                       |
| `apps/api/src/modules/auth/session.service.ts`         | ออก · ตรวจ · เพิกถอน · ล้างแถว `Session`                 |
| `apps/api/src/modules/auth/session.service.test.ts`    | เทสต์วงจรชีวิตเซสชัน                                     |
| `apps/api/src/modules/auth/office-auth.service.ts`     | ล็อกอินด้วยอีเมล+รหัสผ่าน พร้อมล็อกบัญชี                 |
| `apps/api/src/modules/auth/office-auth.routes.test.ts` | เทสต์ `/auth/office/login` ทั้งสำเร็จและล้มเหลว          |
| `apps/api/src/modules/auth/host-guard.ts`              | `tillOnly()` — 404 ให้คำขอที่ไม่ได้มาจากโดเมนหน้าร้าน    |
| `apps/api/src/modules/auth/host-guard.test.ts`         | เทสต์ตัวตัดสินโดเมน (แยกจาก route เพราะเป็นตรรกะล้วน)    |
| `apps/api/scripts/purge-sessions.ts`                   | ลบเซสชันหมดอายุเกิน 90 วัน (cron อยู่แผนที่ 3)           |
| `apps/office/src/pages/OfficeLoginPage.tsx`            | หน้าล็อกอินจริงของหลังร้าน                               |
| `apps/office/src/pages/OfficeLoginPage.test.tsx`       | เทสต์หน้าล็อกอิน — สิ่งที่แผนที่ 1 ติดหนี้ไว้            |

### แก้

| ไฟล์                                              | แก้อะไร                                                        |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `apps/api/prisma/schema.prisma`                   | เพิ่ม `Session` + `SessionSurface` + 5 คอลัมน์บน `Staff`       |
| `apps/api/src/env.ts` · `env.test.ts`             | `WEB_ORIGIN` รับหลายค่า · `TILL_HOSTS` ใหม่                    |
| `apps/api/src/app.ts`                             | CORS หลายต้นทาง                                                |
| `apps/api/src/modules/auth/guards.ts`             | อ่านคุกกี้สองชื่อ · ตรวจ `jti` กับตาราง `Session`              |
| `apps/api/src/modules/auth/auth.routes.ts`        | ออก `jti` · logout เพิกถอนจริง · endpoint ใหม่ 2 ตัว           |
| `apps/api/src/modules/auth/auth.routes.test.ts`   | เทสต์ใหม่สำหรับการเพิกถอน                                      |
| `apps/api/src/modules/qr/qr.routes.ts`            | import `RateLimiter` จากที่ใหม่                                |
| `apps/api/src/modules/staff/staff.routes.ts`      | ตั้งอีเมล · ตั้งรหัสผ่าน · เพิกถอนเซสชันตอนไล่ออก              |
| `apps/api/src/new-shop.ts` · `new-shop.test.ts`   | `OWNER_EMAIL` · `OWNER_PASSWORD`                               |
| `apps/api/prisma/seed-core.ts` · `seed.ts`        | เขียนอีเมล+รหัสผ่านของเจ้าของ                                  |
| `packages/shared/src/auth.ts`                     | ค่าคงที่ใหม่ · `officeLoginRequestSchema` · `passwordSchema`   |
| `packages/shared/src/payroll.ts`                  | `StaffDto` เพิ่ม `email` · `hasOfficeAccess` · `isLoginLocked` |
| `packages/web-kit/src/session-store.ts`           | `createSessionStore<C>` รับ credentials เป็น generic           |
| `apps/web/src/session.ts` · `pages/LoginPage.tsx` | เรียก `login({ staffId, pin, branchId })`                      |
| `apps/office/src/session.ts` · `api-office.ts`    | เรียก `login({ email, password })` · ทิ้ง `staffList`          |

### ลบ

- `apps/office/src/pages/LoginPage.tsx` — หน้า PIN ชั่วคราวจากแผนที่ 1 ที่จงใจไม่มีเทสต์
- `apps/api/src/modules/qr/rate-limit.ts` + `rate-limit.test.ts` — `git mv` ขึ้นไป `src/`

---

## ลำดับ task และเหตุผลของลำดับ

```
1  CORS หลายต้นทาง            ← แก้ของที่พังอยู่ ต้องมาก่อนเพราะทุก task หลังนี้ต้องทดสอบด้วยมือ
2  schema: Session + คอลัมน์   ← migration เดียว ทุก task หลังนี้ต้องมีตารางก่อน
3  SessionService              ← ตรรกะล้วน เทสต์ได้โดยไม่ต้องมี route
4  ต่อ jti เข้ากับ POS + guards ← จุดที่ปิดช่อง "JWT ที่ถูกก๊อปยังใช้ได้"
5  revoke-all + purge          ← ต่อยอดจาก 3 และ 4
6  ตรรกะล็อกอินหลังร้าน         ← ตรรกะล้วนอีกชั้น ยังไม่มี route
7  POST /auth/office/login     ← ประกอบ 3 + 6 เข้าเป็น endpoint
8  ปิด /auth/staff + rate limit ← ปิดช่องที่เปิดโล่ง
9  seed อีเมล + รหัสผ่าน        ← ต้องมี 2 และ 6 ก่อนถึงจะ seed ได้
10 จัดการอีเมล/รหัสผ่านหน้าเว็บ  ← ต้องมี 2 และ 6
11 web-kit generic credentials ← ฝั่งเว็บเริ่มตรงนี้ ไม่แตะ API อีก
12 หน้าล็อกอินหลังร้านจริง       ← ต้องมี 7 และ 11
13 เอกสาร                      ← ปิดท้าย
```

---

## Task 1: ให้ API รับได้สองต้นทาง (แก้ของที่พังอยู่)

**Files:**

- Modify: `apps/api/src/env.ts:22-32`
- Modify: `apps/api/src/env.test.ts:16,32-33`
- Modify: `apps/api/src/app.ts:54-59`
- Modify: `apps/api/.env.example:16-17`

**Interfaces:**

- Consumes: ไม่มี
- Produces: `Env['WEB_ORIGIN']` เปลี่ยนชนิดจาก `string` เป็น `readonly string[]` — Task อื่นไม่ได้ใช้ค่านี้ แต่ typecheck จะพังทันทีถ้าเผลอใช้แบบเดิม

> **ทำไมเป็น task แรก:** ตอนนี้ `apps/office` ยิง API ไม่ได้เลย เบราว์เซอร์บล็อกที่ preflight เพราะ CORS อนุญาตแค่ `:5173` · ทุก task หลังจากนี้ต้องเปิดหน้าเว็บทดสอบด้วยมือ ถ้าไม่แก้ก่อนจะทดสอบไม่ได้สักอัน

- [x] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

แก้ `apps/api/src/env.test.ts` — บรรทัดที่ 16 เดิมคือ `expect(env.WEB_ORIGIN).toBe('http://localhost:5173');` เปลี่ยนเป็น และเพิ่มเทสต์ใหม่ต่อท้าย describe เดิม:

```ts
expect(env.WEB_ORIGIN).toEqual(['http://localhost:5173', 'http://localhost:5174']);
```

```ts
it('accepts several origins so the till and the back office can both reach the API', () => {
  const env = loadEnv({
    ...VALID,
    WEB_ORIGIN: 'https://shop.example.com,https://office.example.com',
  });
  expect(env.WEB_ORIGIN).toEqual(['https://shop.example.com', 'https://office.example.com']);
});

it('tolerates spaces around the commas, because a human types this into a .env', () => {
  const env = loadEnv({ ...VALID, WEB_ORIGIN: 'http://a.test , http://b.test' });
  expect(env.WEB_ORIGIN).toEqual(['http://a.test', 'http://b.test']);
});

it('rejects the whole list when ONE entry is malformed', () => {
  // The dangerous failure is the quiet one: a typo in the second origin that
  // leaves CORS working for the till and silently broken for the office.
  expect(() => loadEnv({ ...VALID, WEB_ORIGIN: 'http://a.test,office.example.com' })).toThrow(
    /WEB_ORIGIN/,
  );
});

it('rejects an empty WEB_ORIGIN rather than allowing nothing at all', () => {
  expect(() => loadEnv({ ...VALID, WEB_ORIGIN: '  ' })).toThrow(/WEB_ORIGIN/);
});
```

- [x] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/api test -- src/env.test.ts
```

คาดหวัง: FAIL — `expected 'http://localhost:5173' to deeply equal [ 'http://localhost:5173', ... ]`

- [x] **Step 3: แก้ `env.ts`**

แทนที่ `apps/api/src/env.ts` บรรทัด 19–32 ทั้งบล็อก:

```ts
  /**
   * Every origin allowed to send credentialed requests, comma-separated.
   *
   * TWO now, not one. The till runs on :5173 and the back office on :5174, and
   * both talk to this API cross-origin in dev with no vite proxy in between. A
   * single value here is precisely why the office could not reach the API at
   * all after plan 1 split it out — the browser refused the preflight and the
   * app never got as far as a login.
   *
   * In production both sites sit behind the reverse proxy and are same-origin
   * with the API, so no browser sends an Origin that needs allowing and this
   * can be left at its default.
   *
   * zod's .url() is not enough: it only checks that `new URL()` parses, and it
   * happily accepts "localhost:5173" (protocol "localhost:"). The protocol is
   * checked explicitly, on every entry — a typo in the SECOND origin is the
   * dangerous one, because CORS keeps working for the till and fails only for
   * the office, which reads like an office bug for as long as it takes to find.
   */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    )
    .refine((list) => list.length > 0, 'WEB_ORIGIN must list at least one origin')
    .refine(
      (list) => list.every(isHttpOrigin),
      'WEB_ORIGIN must be full http(s) origins separated by commas, e.g. http://localhost:5173,http://localhost:5174',
    ),
```

แล้วเพิ่มฟังก์ชันช่วยไว้เหนือ `const envSchema`:

```ts
function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
```

- [x] **Step 4: แก้ `app.ts`**

`apps/api/src/app.ts` บรรทัด 54–59 — คอมเมนต์เดิมพูดถึง "PWA" เอกพจน์ ซึ่งไม่จริงอีกแล้ว:

```ts
// Two PWAs on two different origins in dev, both holding their session in an
// httpOnly cookie, so credentials must be allowed explicitly. `env.WEB_ORIGIN`
// is a list — see env.ts for why one value was not enough.
await app.register(cors, {
  origin: [...env.WEB_ORIGIN],
  credentials: true,
});
```

- [x] **Step 5: แก้ `.env.example`**

`apps/api/.env.example` บรรทัด 16–17:

```
# Origins of the two web apps, for CORS. Comma-separated, no spaces needed.
# The till is :5173 and the back office is :5174 — BOTH must be listed or the
# office cannot reach the API at all. In production they are same-origin with
# the API behind the reverse proxy, so this can be left alone.
WEB_ORIGIN="http://localhost:5173,http://localhost:5174"
```

- [x] **Step 6: รันเทสต์**

```bash
pnpm --filter @pos/api test -- src/env.test.ts
```

คาดหวัง: PASS ทุกตัว

- [x] **Step 7: พิสูจน์ด้วยมือว่าหลังร้านยิง API ได้จริงแล้ว**

เปิดสามเทอร์มินัล: `pnpm dev:api` · `pnpm dev:web` · `pnpm dev:office` แล้วเปิด `http://localhost:5174` ดู DevTools → Network

คาดหวัง: request ไป `/api/auth/me` ตอบ 401 (ยังไม่ล็อกอิน) — **ไม่ใช่** CORS error สีแดง · ก่อนแก้จะเห็น `blocked by CORS policy` ใน console

บันทึกสิ่งที่เห็นลงในแผนใต้ task นี้ ถ้าไม่ตรงให้หยุดแล้วรายงาน

> **ผลจริง 2026-08-17** — เปิด `http://localhost:5174` แล้วดู Network:
>
> ```
> GET http://localhost:3001/api/auth/me    → 401 Unauthorized
> GET http://localhost:3001/api/auth/staff → 200 OK
> ```
>
> ตรงตามที่คาด · console ไม่มี `blocked by CORS policy` เหลืออยู่ · `/auth/staff` ที่ตอบ 200 ให้คนที่ยังไม่ล็อกอินคือช่องที่ Task 8 ปิด
>
> **เพิ่มจากแผน:** `apps/api/.env` ในเครื่อง (gitignored แผนจึงมองไม่เห็น) ยังตั้ง `WEB_ORIGIN` เป็นค่าเดียว ต้องแก้ด้วย ไม่งั้น dev server ยังบล็อกอยู่แม้โค้ดถูกแล้ว

- [x] **Step 8: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,125 ผ่าน (`@pos/api` 328 → 332 จากเทสต์ใหม่ 4 ตัว)

```bash
git add apps/api/src/env.ts apps/api/src/env.test.ts apps/api/src/app.ts apps/api/.env.example
git commit -m "fix: let the API accept both web origins

The back office moved to its own vite server on :5174 in plan 1 and has not
been able to reach the API since — CORS allowed one origin and it was the
till's. Nothing caught it because every office test stubs the api client."
```

---

## Task 2: ตาราง `Session` และคอลัมน์ล็อกอินบน `Staff`

**Files:**

- Modify: `apps/api/prisma/schema.prisma` (model `Branch`, model `Staff`, ท้ายไฟล์)
- Create: `apps/api/prisma/migrations/<timestamp>_step11_office_auth/migration.sql` (prisma สร้างให้)
- Create: `apps/api/src/modules/auth/schema.test.ts`

**Interfaces:**

- Consumes: ไม่มี
- Produces: `prisma.session` · `SessionSurface.POS` / `.OFFICE` · `Staff.email`, `Staff.passwordHash`, `Staff.totpSecret`, `Staff.failedLoginAttempts`, `Staff.loginLockedUntil` — Task 3 ถึง 10 ใช้ทั้งหมดนี้

- [x] **Step 1: เพิ่ม enum และ model ท้ายไฟล์ schema**

ต่อท้าย `apps/api/prisma/schema.prisma` (หลัง model สุดท้าย):

```prisma
// ---------------------------------------------------------------------------
// Sessions (plan 2)
// ---------------------------------------------------------------------------

enum SessionSurface {
  POS
  OFFICE
}

/// One row per login that is still worth honouring.
///
/// The JWT carries this row's id as its `jti` and every request checks the row
/// is neither revoked nor expired. That one extra indexed query per request is
/// what turns logout from "stop sending the cookie" into "this token is dead",
/// and it is what lets an owner cut off a phone that walked out of the shop
/// without waiting twelve hours for the token to lapse on its own.
///
/// Expired rows are KEPT for 90 days (scripts/purge-sessions.ts) so "who was
/// logged in on the night the till came up short" is a question with an answer.
model Session {
  id       String @id @default(uuid())
  branchId String
  staffId  String

  /// Which door this came through. Set by the route, never guessed from a
  /// header — that is the whole reason the two logins are separate endpoints.
  surface SessionSurface

  createdAt DateTime  @default(now())
  expiresAt DateTime
  revokedAt DateTime?

  userAgent String?
  /// HMAC-SHA256 of the caller's IP, keyed with JWT_SECRET — never the raw IP,
  /// and never a bare sha256 either: IPv4 has only four billion values, so an
  /// unkeyed digest is a lookup table away from being the address itself.
  ipHash String?

  branch Branch @relation(fields: [branchId], references: [id], onDelete: Cascade)
  staff  Staff  @relation(fields: [staffId], references: [id], onDelete: Cascade)

  @@index([staffId, revokedAt])
  @@index([expiresAt])
  @@map("sessions")
}
```

- [x] **Step 2: เพิ่มคอลัมน์บน `Staff`**

ใน `model Staff` — เพิ่มต่อจากบล็อก PIN brute-force protection (หลังบรรทัด `lastLoginAt DateTime?`):

```prisma
  /// --- back office login (plan 2) ---
  /// The username for office.<domain>. UNIQUE ACROSS THE WHOLE TABLE, not per
  /// branch: the office login screen has no branch picker, so an email must
  /// resolve to exactly one row and the branch comes from that row.
  email String? @unique

  /// bcrypt cost 12. NULL means this person cannot reach the back office at
  /// all, whatever they know — which is the state every cashier stays in.
  passwordHash String?

  /// Reserved for TOTP (design doc D8). Nothing reads it yet. It exists now so
  /// turning 2FA on later is a feature, not a migration on a live database.
  totpSecret String?

  /// The password twins of failedPinAttempts/pinLockedUntil. Separate counters
  /// on purpose: locking someone out of the till because a bot is guessing at
  /// their office password would take a working cashier off the floor.
  failedLoginAttempts Int       @default(0)
  loginLockedUntil    DateTime?
```

แล้วเพิ่มความสัมพันธ์ในบล็อก relation ของ `Staff` (ต่อจาก `creditNotesApproved`):

```prisma
  sessions            Session[]
```

- [x] **Step 3: เพิ่มความสัมพันธ์บน `Branch`**

ใน `model Branch` หาบล็อกที่ list relation ทั้งหมด แล้วเพิ่ม:

```prisma
  sessions Session[]
```

> หาไม่เจอให้ `grep -n "auditLogs" apps/api/prisma/schema.prisma` — `Branch` มีบรรทัดนั้นอยู่แล้ว ใส่ถัดจากมัน

- [x] **Step 4: สร้าง migration**

```bash
pnpm --filter @pos/api exec prisma migrate dev --name step11_office_auth
```

คาดหวัง: สร้างโฟลเดอร์ `apps/api/prisma/migrations/<timestamp>_step11_office_auth/` และรันสำเร็จ · เปิด `migration.sql` แล้วตรวจว่ามีทั้งหมดนี้และ **ไม่มี `DROP`** อะไรเลย:

```sql
CREATE TYPE "SessionSurface" AS ENUM ('POS', 'OFFICE');
ALTER TABLE "staff" ADD COLUMN "email" TEXT;
ALTER TABLE "staff" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "staff" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "staff" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "staff" ADD COLUMN "loginLockedUntil" TIMESTAMP(3);
CREATE TABLE "sessions" (...);
CREATE UNIQUE INDEX "staff_email_key" ON "staff"("email");
CREATE INDEX "sessions_staffId_revokedAt_idx" ON "sessions"("staffId", "revokedAt");
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");
```

**ถ้าเห็น `DROP TABLE` หรือ `DROP COLUMN` ให้หยุดทันที** — แปลว่า schema ถูกแก้เกินที่แผนบอก

> **ผลจริง 2026-08-17** — `prisma migrate dev` ใช้ไม่ได้ในเชลล์ที่ไม่ interactive: มันขึ้นคำเตือน "A unique constraint covering the columns `[email]` ... will be added" แล้วรอคำตอบ พอไม่มีคนตอบก็ตายด้วย `Prisma Migrate has detected that the environment is non-interactive`
>
> ทางที่ใช้แทนแล้วได้ผลเหมือนกัน:
>
> ```bash
> pnpm --filter @pos/api exec prisma migrate diff \
>   --from-schema-datasource prisma/schema.prisma \
>   --to-schema-datamodel prisma/schema.prisma --script
> # เอา SQL ที่ได้ไปวางใน prisma/migrations/20260817120000_step11_office_auth/migration.sql
> pnpm --filter @pos/api exec prisma migrate deploy
> ```
>
> SQL ที่ออกมาตรงกับที่แผนคาดไว้ทุกบรรทัด ไม่มี `DROP` · task หลัง ๆ ที่ต้องสร้าง migration ให้ใช้วิธีนี้

- [x] **Step 5: เขียนเทสต์ที่พิสูจน์ว่า constraint จริง ไม่ใช่แค่ในไฟล์**

สร้าง `apps/api/src/modules/auth/schema.test.ts`:

```ts
/**
 * The two database guarantees the office login rests on.
 *
 * Both are the kind of rule that is easy to write in schema.prisma and easy to
 * lose in a hand-edited migration, and both fail silently if lost: duplicate
 * emails make "which row does this email mean" ambiguous, and a session that
 * survives its staff row is a session pointing at nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { Role } from '@pos/shared';
import { prisma } from '../../db.js';

let branchId: string;
const created: string[] = [];

beforeAll(async () => {
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;
});

afterAll(async () => {
  await prisma.staff.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

async function makeStaff(email: string | null): Promise<string> {
  const staff = await prisma.staff.create({
    data: {
      branchId,
      fullName: `ทดสอบ อีเมล ${created.length}`,
      role: Role.STAFF,
      pinHash: await bcrypt.hash(String(1000 + created.length), 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
      email,
    },
  });
  created.push(staff.id);
  return staff.id;
}

describe('the email column', () => {
  it('refuses a second row with the same email', async () => {
    await makeStaff('duplicate@test.local');
    await expect(makeStaff('duplicate@test.local')).rejects.toThrow();
  });

  it('allows many rows with no email at all', async () => {
    // Every cashier is one of these. A unique constraint that treated NULLs as
    // equal would mean the shop could only ever have one person without an
    // office account.
    await makeStaff(null);
    await expect(makeStaff(null)).resolves.toBeTruthy();
  });
});

describe('the sessions table', () => {
  it('deletes a session when its staff row goes', async () => {
    const staffId = await makeStaff('cascade@test.local');
    await prisma.session.create({
      data: {
        branchId,
        staffId,
        surface: 'OFFICE',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.staff.delete({ where: { id: staffId } });
    created.splice(created.indexOf(staffId), 1);

    expect(await prisma.session.count({ where: { staffId } })).toBe(0);
  });
});
```

- [x] **Step 6: รันเทสต์**

```bash
pnpm --filter @pos/api test -- src/modules/auth/schema.test.ts
```

คาดหวัง: PASS 3 ตัว

- [x] **Step 7: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,128 ผ่าน

```bash
git add apps/api/prisma apps/api/src/modules/auth/schema.test.ts
git commit -m "feat: add the sessions table and the office login columns

Nothing reads them yet. The migration lands on its own so the columns exist
before any code depends on them, and so a bad migration is one revert away
from a working database rather than tangled up with a feature."
```

---

## Task 3: `SessionService` — ออก ตรวจ เพิกถอน ล้าง

**Files:**

- Create: `apps/api/src/modules/auth/session.service.ts`
- Create: `apps/api/src/modules/auth/session.service.test.ts`

**Interfaces:**

- Consumes: `prisma.session` จาก Task 2
- Produces:

  ```ts
  export const SESSION_RETENTION_DAYS = 90;
  export interface IssuedSession {
    id: string;
    expiresAt: Date;
  }
  export interface IssueInput {
    branchId: string;
    staffId: string;
    surface: 'POS' | 'OFFICE';
    ttlSeconds: number;
    userAgent?: string | undefined;
    ip?: string | undefined;
  }
  export class SessionService {
    constructor(db: PrismaClient, secret: string);
    issue(input: IssueInput, now?: Date): Promise<IssuedSession>;
    isLive(id: string, now?: Date): Promise<boolean>;
    revoke(id: string, now?: Date): Promise<void>;
    revokeAllFor(staffId: string, now?: Date): Promise<number>;
    purgeExpired(now?: Date): Promise<number>;
  }
  ```

  Task 4, 5, 7, 10 ใช้ทั้งหมดนี้

- [x] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

สร้าง `apps/api/src/modules/auth/session.service.test.ts`:

```ts
/**
 * The lifecycle of one login.
 *
 * `now` is a parameter on every method rather than a mock of the clock: these
 * run against the real database, and freezing Date globally in a file that
 * other files run beside is how a suite starts failing in ways nobody can
 * reproduce.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { Role } from '@pos/shared';
import { prisma } from '../../db.js';
import { SessionService } from './session.service.js';

const SECRET = 'test-jwt-secret-value-long-enough';

let service: SessionService;
let branchId: string;
let staffId: string;

beforeAll(async () => {
  service = new SessionService(prisma, SECRET);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;
  const staff = await prisma.staff.create({
    data: {
      branchId,
      fullName: 'ทดสอบ เซสชัน',
      role: Role.STAFF,
      pinHash: await bcrypt.hash('4242', 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
    },
  });
  staffId = staff.id;
});

afterEach(async () => {
  await prisma.session.deleteMany({ where: { staffId } });
});

afterAll(async () => {
  await prisma.staff.delete({ where: { id: staffId } });
  await prisma.$disconnect();
});

const base = { branchId: '', staffId: '', surface: 'POS' as const, ttlSeconds: 3600 };
const input = (): typeof base => ({ ...base, branchId, staffId });

describe('issuing', () => {
  it('returns an id and an expiry the caller can put in a cookie', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    const issued = await service.issue(input(), now);

    expect(issued.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.expiresAt.toISOString()).toBe('2026-08-17T11:00:00.000Z');
  });

  it('never stores the raw IP', async () => {
    const issued = await service.issue({ ...input(), ip: '203.0.113.9' });
    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.id } });

    expect(row.ipHash).not.toBeNull();
    expect(row.ipHash).not.toContain('203.0.113.9');
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same IP to the same value, so two logins can be compared', async () => {
    const a = await service.issue({ ...input(), ip: '203.0.113.9' });
    const b = await service.issue({ ...input(), ip: '203.0.113.9' });
    const c = await service.issue({ ...input(), ip: '198.51.100.4' });

    const rows = await prisma.session.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    const byId = new Map(rows.map((row) => [row.id, row.ipHash]));

    expect(byId.get(a.id)).toBe(byId.get(b.id));
    expect(byId.get(a.id)).not.toBe(byId.get(c.id));
  });

  it('keys the hash with the secret, so the digest is not a lookup away from the IP', async () => {
    const other = new SessionService(prisma, 'a-completely-different-secret');
    const mine = await service.issue({ ...input(), ip: '203.0.113.9' });
    const theirs = await other.issue({ ...input(), ip: '203.0.113.9' });

    const rows = await prisma.session.findMany({ where: { id: { in: [mine.id, theirs.id] } } });
    expect(rows[0]?.ipHash).not.toBe(rows[1]?.ipHash);
  });

  it('leaves ipHash null when there is no IP to hash', async () => {
    const issued = await service.issue(input());
    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.ipHash).toBeNull();
  });
});

describe('checking', () => {
  it('says a fresh session is live', async () => {
    const issued = await service.issue(input());
    expect(await service.isLive(issued.id)).toBe(true);
  });

  it('says an expired session is not, without anyone having to delete it', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    const issued = await service.issue({ ...input(), ttlSeconds: 60 }, now);

    expect(await service.isLive(issued.id, new Date('2026-08-17T10:00:30Z'))).toBe(true);
    expect(await service.isLive(issued.id, new Date('2026-08-17T10:01:01Z'))).toBe(false);
  });

  it('says a revoked session is not, even though it has not expired', async () => {
    const issued = await service.issue(input());
    await service.revoke(issued.id);
    expect(await service.isLive(issued.id)).toBe(false);
  });

  it('says an id that was never issued is not live', async () => {
    // A forged jti must read the same as a dead one.
    expect(await service.isLive('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('says a malformed id is not live instead of throwing', async () => {
    // Prisma rejects a non-uuid on a uuid column. This reaches the guard on
    // every request, so it has to answer false rather than 500 the API.
    expect(await service.isLive('not-a-uuid')).toBe(false);
  });
});

describe('revoking', () => {
  it('is quiet about an id that does not exist', async () => {
    await expect(service.revoke('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });

  it('keeps the first revocation time when revoked twice', async () => {
    const issued = await service.issue(input());
    await service.revoke(issued.id, new Date('2026-08-17T10:00:00Z'));
    await service.revoke(issued.id, new Date('2026-08-17T12:00:00Z'));

    const row = await prisma.session.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.revokedAt?.toISOString()).toBe('2026-08-17T10:00:00.000Z');
  });

  it('kills every live session a person has, and counts them', async () => {
    await service.issue(input());
    await service.issue({ ...input(), surface: 'OFFICE' });
    const already = await service.issue(input());
    await service.revoke(already.id);

    // Two live, not three: the already-revoked one must not be counted again
    // or "logged out of 3 devices" would be a lie the first time and right the
    // second.
    expect(await service.revokeAllFor(staffId)).toBe(2);
    expect(await prisma.session.count({ where: { staffId, revokedAt: null } })).toBe(0);
  });
});

describe('purging', () => {
  it('keeps an expired session inside the retention window', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    await service.issue({ ...input(), ttlSeconds: 60 }, now);

    // Expired for a day. Still the answer to "who was logged in yesterday".
    expect(await service.purgeExpired(new Date('2026-08-18T10:00:00Z'))).toBe(0);
  });

  it('deletes one that expired longer ago than the retention window', async () => {
    const now = new Date('2026-08-17T10:00:00Z');
    await service.issue({ ...input(), ttlSeconds: 60 }, now);

    expect(await service.purgeExpired(new Date('2026-11-20T10:00:00Z'))).toBe(1);
    expect(await prisma.session.count({ where: { staffId } })).toBe(0);
  });

  it('never touches a session that is still live', async () => {
    const issued = await service.issue({ ...input(), ttlSeconds: 3600 });
    expect(await service.purgeExpired()).toBe(0);
    expect(await service.isLive(issued.id)).toBe(true);
  });
});
```

- [x] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/api test -- src/modules/auth/session.service.test.ts
```

คาดหวัง: FAIL — `Cannot find module './session.service.js'`

- [x] **Step 3: เขียน `session.service.ts`**

สร้าง `apps/api/src/modules/auth/session.service.ts`:

```ts
/**
 * The row behind every token.
 *
 * Before this existed, logging out cleared the cookie and nothing else — the
 * README said so plainly: "JWT ที่ถูกก๊อปไว้ก่อนหน้ายังใช้ได้จนหมดอายุ". On a
 * shop LAN that was a small gap. On the open internet it is the gap, so the
 * JWT now carries this row's id as `jti` and every request checks the row.
 *
 * The cost is one indexed lookup per request. A shop with twelve tables will
 * never feel it, and it buys four things at once: a logout that actually ends
 * the session, "sign out everywhere", cutting off someone who left today
 * instead of in twelve hours, and an owner who can see how many devices are
 * still holding a session.
 */

import { createHmac } from 'node:crypto';
import type { PrismaClient, SessionSurface } from '@prisma/client';

/**
 * How long a dead session is kept before it is deleted.
 *
 * Not zero, because "who was logged in on the night the drawer came up short"
 * is a question that gets asked weeks later and has no other source.
 */
export const SESSION_RETENTION_DAYS = 90;

export interface IssuedSession {
  id: string;
  expiresAt: Date;
}

export interface IssueInput {
  branchId: string;
  staffId: string;
  surface: SessionSurface;
  ttlSeconds: number;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export class SessionService {
  constructor(
    private readonly db: PrismaClient,
    /** Keys the IP hash. The JWT secret, so there is one secret to rotate. */
    private readonly secret: string,
  ) {}

  async issue(input: IssueInput, now: Date = new Date()): Promise<IssuedSession> {
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

    const row = await this.db.session.create({
      data: {
        branchId: input.branchId,
        staffId: input.staffId,
        surface: input.surface,
        createdAt: now,
        expiresAt,
        // Truncated: a user-agent is attacker-controlled and unbounded, and
        // this column exists to say "Safari on an iPad", not to store an essay.
        userAgent: input.userAgent?.slice(0, 255) ?? null,
        ipHash: input.ip ? this.hashIp(input.ip) : null,
      },
      select: { id: true, expiresAt: true },
    });

    return row;
  }

  /**
   * Whether this id still authorises a request.
   *
   * Answers false for anything it does not recognise — a forged jti, a deleted
   * row, a string that is not a uuid at all. This runs on EVERY request, so
   * throwing here would turn a malformed cookie into a 500 instead of a 401.
   */
  async isLive(id: string, now: Date = new Date()): Promise<boolean> {
    if (!UUID.test(id)) return false;

    const row = await this.db.session.findUnique({
      where: { id },
      select: { expiresAt: true, revokedAt: true },
    });
    if (!row) return false;

    return row.revokedAt === null && row.expiresAt > now;
  }

  /**
   * Ends one session.
   *
   * `revokedAt: null` in the filter is what makes this idempotent: revoking
   * twice keeps the FIRST time, because the moment the session stopped being
   * valid is the fact worth keeping, not the moment someone asked again.
   */
  async revoke(id: string, now: Date = new Date()): Promise<void> {
    if (!UUID.test(id)) return;
    await this.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Ends every live session this person has. Returns how many actually died. */
  async revokeAllFor(staffId: string, now: Date = new Date()): Promise<number> {
    const result = await this.db.session.updateMany({
      where: { staffId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count;
  }

  /** Deletes sessions that expired longer ago than the retention window. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    return result.count;
  }

  /**
   * HMAC, not a bare digest.
   *
   * sha256 of an IPv4 address is not anonymisation — there are only four
   * billion of them, and building the whole reverse table takes minutes on a
   * laptop. Keyed with a secret, the digest still compares equal for the same
   * address (which is the entire point of storing it) but cannot be walked
   * backwards by anyone who does not already have the key.
   */
  private hashIp(ip: string): string {
    return createHmac('sha256', this.secret).update(ip).digest('hex');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

- [x] **Step 4: รันเทสต์**

```bash
pnpm --filter @pos/api test -- src/modules/auth/session.service.test.ts
```

คาดหวัง: PASS 16 ตัว

- [x] **Step 5: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,144 ผ่าน

```bash
git add apps/api/src/modules/auth/session.service.ts apps/api/src/modules/auth/session.service.test.ts
git commit -m "feat: add SessionService

Issue, check, revoke and purge. Nothing calls it yet — the guards pick it up
in the next task, where the behaviour change is visible and reviewable on its
own instead of buried under a new file."
```

---

## Task 4: ต่อ `jti` เข้ากับการล็อกอินหน้าร้านและ guards

**Files:**

- Modify: `packages/shared/src/auth.ts:20-29`
- Modify: `apps/api/src/app.ts:66-74,114`
- Modify: `apps/api/src/modules/auth/guards.ts` (เขียนใหม่ทั้งไฟล์)
- Modify: `apps/api/src/modules/auth/auth.routes.ts:35-38,63-108`
- Modify: `apps/api/src/modules/auth/auth.routes.test.ts:182-203`

**Interfaces:**

- Consumes: `SessionService` จาก Task 3
- Produces:
  - `OFFICE_SESSION_COOKIE_NAME = 'office_session'` · `OFFICE_SESSION_TTL_SECONDS = 8 * 60 * 60` ใน `@pos/shared`
  - `app.sessions: SessionService` — Task 5, 7, 10 ใช้
  - `request.user` เพิ่ม field `jti: string` — Task 5 ใช้
  - `issueSessionCookie(app, reply, ...)` ใน `auth.routes.ts` — Task 7 ใช้ตัวเดียวกัน

> **นี่คือ task ที่ปิดช่องจริง** ก่อน task นี้ logout แค่ลบคุกกี้ · หลัง task นี้ token ที่ถูกก๊อปไว้ก่อน logout ใช้ไม่ได้อีก
>
> **ผลข้างเคียงที่ตั้งใจ:** token เก่าทุกใบไม่มี `jti` จึงถูกปฏิเสธหมดตอน deploy — ทุกคนต้องล็อกอินใหม่หนึ่งครั้ง · ยอมรับได้และดีกว่าทางเลือกอื่น (ยอมรับ token ไม่มี `jti` ไปก่อน = เปิดช่องทิ้งไว้ 12 ชั่วโมงโดยไม่มีใครรู้ว่าปิดเมื่อไหร่)

- [ ] **Step 1: เพิ่มค่าคงที่ใน `@pos/shared`**

`packages/shared/src/auth.ts` — แทนที่บรรทัด 20–23:

```ts
/** How long a till session lasts. One long shift, so nobody re-logs in mid-service. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * How long a back office session lasts.
 *
 * Shorter than the till's on purpose. A cashier who is signed out mid-service
 * is a queue at the counter; an owner who is signed out is one password on a
 * machine that is not a tablet bolted to a counter — and this session can read
 * every wage in the shop from anywhere on the internet.
 */
export const OFFICE_SESSION_TTL_SECONDS = 8 * 60 * 60;

export const SESSION_COOKIE_NAME = 'pos_session';

/**
 * A DIFFERENT cookie for the back office, not the same name on another host.
 *
 * Cookies ignore the port. In dev the till is localhost:5173 and the office is
 * localhost:5174, which is one cookie jar — one name would mean logging into
 * the office kicks the till out, and back, all day. In production the hosts
 * differ so it would work either way, and it is still worth having: an office
 * cookie that cannot be presented as a till cookie is the split being true in
 * the browser rather than only in the design.
 */
export const OFFICE_SESSION_COOKIE_NAME = 'office_session';
```

- [ ] **Step 2: เขียนเทสต์ที่ยังไม่ผ่าน**

เพิ่มลงท้าย `apps/api/src/modules/auth/auth.routes.test.ts` (ใน describe `/auth/me` แทนที่เทสต์ `clears the session cookie on logout` เดิม — คอมเมนต์ยาวเหนือมันบรรยายช่องที่ task นี้เพิ่งปิด จึงต้องไปด้วย):

```ts
/**
 * Logging out now ends the session on the server, not just in the browser.
 *
 * The cleared cookie is still sent, because that is what stops the browser
 * presenting it. But the row is revoked too, so a copy of the token taken
 * before logout is dead the moment logout returns. That gap used to be a
 * known limitation written into this file; it is what plan 2 closed.
 */
it('clears the cookie AND kills the session behind it', async () => {
  const { cookie } = await loginAs(app, Role.MANAGER);

  const before = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  expect(before.statusCode).toBe(200);

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);

  const raw = response.headers['set-cookie'];
  const cleared = Array.isArray(raw) ? raw.join(';') : (raw ?? '');
  expect(cleared).toContain(SESSION_COOKIE_NAME);
  expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

  // The part that is new: the SAME cookie value, replayed by hand the way a
  // stolen token would be, no longer works.
  const replayed = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie },
  });
  expect(replayed.statusCode).toBe(401);
});

it('records the session row when someone logs in', async () => {
  const { staffId } = await loginAs(app, Role.STAFF);
  const row = await prisma.session.findFirst({
    where: { staffId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  expect(row).not.toBeNull();
  expect(row?.surface).toBe('POS');
  // Twelve hours, the till's TTL — not the office's eight.
  const life =
    (row as { expiresAt: Date; createdAt: Date }).expiresAt.getTime() -
    (row as { createdAt: Date }).createdAt.getTime();
  expect(Math.round(life / 1000)).toBe(SESSION_TTL_SECONDS);
});

it('refuses a token whose session row was revoked out from under it', async () => {
  const { staffId, cookie } = await loginAs(app, Role.STAFF);
  await prisma.session.updateMany({
    where: { staffId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  expect(response.statusCode).toBe(401);
});

it('refuses a validly signed token that carries no jti at all', async () => {
  // Every token issued before plan 2 looks like this. They must not be
  // honoured, or the hole stays open for as long as the longest old token
  // lives and nobody can say when it closed.
  const staff = await prisma.staff.findFirstOrThrow({ where: { role: Role.STAFF } });
  const token = app.jwt.sign({
    staffId: staff.id,
    branchId: staff.branchId,
    role: staff.role,
    fullName: staff.fullName,
    nickname: staff.nickname,
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  expect(response.statusCode).toBe(401);
});

it('accepts the office cookie name on the same endpoints', async () => {
  // The two sites use different cookie names; the API has to read both or
  // every office request after login is a 401.
  const { cookie } = await loginAs(app, Role.OWNER);
  const value = cookie.split('=').slice(1).join('=');

  const response = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: `${OFFICE_SESSION_COOKIE_NAME}=${value}` },
  });
  expect(response.statusCode).toBe(200);
});
```

แก้ import ที่หัวไฟล์ให้มี `OFFICE_SESSION_COOKIE_NAME` และ `SESSION_TTL_SECONDS`:

```ts
import {
  MAX_PIN_ATTEMPTS,
  OFFICE_SESSION_COOKIE_NAME,
  Permission,
  Role,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from '@pos/shared';
```

- [ ] **Step 3: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm build:shared && pnpm --filter @pos/api test -- src/modules/auth/auth.routes.test.ts
```

คาดหวัง: FAIL — `replayed.statusCode` เป็น 200 ไม่ใช่ 401 และ `prisma.session.findFirst` คืน null

- [ ] **Step 4: ให้ app ถือ `SessionService` หนึ่งตัว**

`apps/api/src/app.ts` — เพิ่ม import:

```ts
import { SessionService } from './modules/auth/session.service.js';
import { prisma } from './db.js';
```

เพิ่มการประกาศชนิดใต้ import ทั้งหมด (นอกฟังก์ชัน):

```ts
declare module 'fastify' {
  interface FastifyInstance {
    /** Shared by the guards and both login routes. See session.service.ts. */
    sessions: SessionService;
  }
}
```

แล้วใน `buildApp` ใส่ต่อจากบล็อก `await app.register(websocket);` และ **ก่อน** `app.setErrorHandler`:

```ts
// One instance for the whole app: the guards read it on every request and
// both login routes write through it. Keyed with the JWT secret because the
// only thing it needs a secret for is the IP hash, and one secret to rotate
// beats two.
app.decorate('sessions', new SessionService(prisma, env.JWT_SECRET));
```

- [ ] **Step 5: เขียน `guards.ts` ใหม่ทั้งไฟล์**

แทนที่ `apps/api/src/modules/auth/guards.ts` ทั้งไฟล์:

```ts
/**
 * Route guards.
 *
 * The permission matrix lives in @pos/shared and is used by BOTH sides: the
 * PWA hides the button, the API refuses the request. That is not duplication —
 * the UI check is a courtesy so a cashier is not shown a button that will fail,
 * and this one is the actual security boundary. Never rely on the first.
 *
 * Two things a request has to survive here, not one:
 *
 *   1. the JWT verifies — it is signed by us and has not expired;
 *   2. the session row named by its `jti` is still alive.
 *
 * The second is what makes logout real. Without it a token copied off a device
 * keeps working until it lapses on its own, whatever the owner does — which is
 * survivable on a shop LAN and not survivable on the open internet.
 *
 * The token is read from a cookie by hand rather than through
 * `request.jwtVerify()`, because @fastify/jwt can be told about exactly one
 * cookie name and the two sites deliberately use two (see @pos/shared).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  can,
  OFFICE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type Permission,
  type SessionUser,
} from '@pos/shared';

/**
 * What our token carries.
 *
 * `jti` is not optional in practice — a token without one is refused below —
 * but it is optional in the type because that is what an unverified payload
 * can actually look like, and pretending otherwise would move the check from
 * the code into a cast.
 */
export type SessionPayload = SessionUser & { jti?: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser & { jti: string };
  }
}

const COOKIE_NAMES = [SESSION_COOKIE_NAME, OFFICE_SESSION_COOKIE_NAME] as const;

function readToken(request: FastifyRequest): string | null {
  for (const name of COOKIE_NAMES) {
    const value = request.cookies[name];
    if (value) return value;
  }
  return null;
}

async function refuse(reply: FastifyReply): Promise<void> {
  // Never echo the jwt library's reason — "jwt expired" vs "invalid signature"
  // tells an attacker which half of the problem to work on. A revoked session
  // answers identically for the same reason.
  await reply.status(401).send({
    error: 'UNAUTHORIZED',
    message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  });
}

/**
 * Verifies the cookie and the session row behind it, and populates
 * `request.user`. Returns false when it has already answered the request.
 */
async function resolveSession(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const token = readToken(request);
  if (!token) {
    await refuse(reply);
    return false;
  }

  let payload: SessionPayload;
  try {
    payload = request.server.jwt.verify<SessionPayload>(token);
  } catch {
    await refuse(reply);
    return false;
  }

  // A token with no jti predates plan 2. There is no session row to check, so
  // there is no way to end it — refuse rather than honour it.
  if (!payload.jti || !(await request.server.sessions.isLive(payload.jti))) {
    await refuse(reply);
    return false;
  }

  request.user = { ...payload, jti: payload.jti };
  return true;
}

/** 401s unless a valid, unrevoked session is present. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await resolveSession(request, reply);
}

/** 401 without a session, 403 with a session that lacks the permission. */
export function requirePermission(
  permission: Permission,
  what: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (!(await resolveSession(request, reply))) return;

    if (!can(request.user.role, permission)) {
      await reply.status(403).send({
        error: 'FORBIDDEN',
        message: `บัญชีนี้ไม่มีสิทธิ์${what}`,
      });
    }
  };
}
```

- [ ] **Step 6: ให้ `/auth/login` ออกแถว `Session` แล้ว logout เพิกถอน**

`apps/api/src/modules/auth/auth.routes.ts` — เพิ่ม import:

```ts
import {
  loginRequestSchema,
  OFFICE_SESSION_COOKIE_NAME,
  ROLE_PERMISSIONS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  parsePromptPayId,
  uuidSchema,
  type MeResponse,
  type SessionUser,
} from '@pos/shared';
import type { SessionSurface } from '@prisma/client';
```

เพิ่มฟังก์ชันช่วยไว้เหนือ `export function registerAuthRoutes`:

```ts
/**
 * Signs a token for a fresh session row and puts it in the right cookie.
 *
 * Shared by both doors so the cookie flags cannot drift apart between them —
 * a `secure` that is set on one login and forgotten on the other is the kind
 * of difference nobody notices until a session is riding over plain http.
 */
async function issueSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  input: {
    user: SessionUser;
    surface: SessionSurface;
    ttlSeconds: number;
    isProduction: boolean;
    userAgent?: string | undefined;
    ip?: string | undefined;
  },
): Promise<void> {
  const session = await app.sessions.issue({
    branchId: input.user.branchId,
    staffId: input.user.staffId,
    surface: input.surface,
    ttlSeconds: input.ttlSeconds,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  // `jwtid` is jsonwebtoken's name for the `jti` claim. Getting this wrong is
  // silent: the token signs fine, carries no jti, and every request 401s.
  const token = app.jwt.sign(input.user, {
    expiresIn: input.ttlSeconds,
    jwtid: session.id,
  });

  const name = input.surface === 'OFFICE' ? OFFICE_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;

  reply.setCookie(name, token, {
    httpOnly: true,
    // The tablet talks to the API over plain http on the shop LAN, so a Secure
    // cookie would simply never be sent. It goes on in production.
    secure: input.isProduction,
    // Lax, not None: each site and the API are same-site in production. None
    // would require Secure and would open the cookie up to cross-site POSTs.
    sameSite: 'lax',
    path: '/',
    maxAge: input.ttlSeconds,
  });
}
```

เพิ่ม import ชนิดที่หัวไฟล์: `import type { FastifyInstance, FastifyReply } from 'fastify';`

แทนที่ท้าย handler ของ `/auth/login` (บรรทัด 89–103 เดิม):

```ts
await issueSessionCookie(app, reply, {
  user: result.user,
  surface: 'POS',
  ttlSeconds: SESSION_TTL_SECONDS,
  isProduction,
  userAgent: request.headers['user-agent'],
  ip: request.ip,
});

return reply.send({ user: result.user, permissions: ROLE_PERMISSIONS[result.user.role] });
```

แทนที่ `/auth/logout` ทั้งบล็อก:

```ts
/**
 * Ends the session, on the server and in the browser.
 *
 * `requireAuth` rather than open: logging out has to know WHICH session to
 * kill, and the only trustworthy answer is the one in the token. An open
 * endpoint could clear a cookie but never revoke a row.
 *
 * Both cookies are cleared regardless of which one arrived. They are on
 * different hosts in production so only one can be present, and clearing a
 * cookie that was not there costs nothing — while leaving one behind after a
 * dev session that hopped between :5173 and :5174 costs an hour of confusion.
 */
app.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
  await app.sessions.revoke(request.user.jti);

  return reply
    .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    .clearCookie(OFFICE_SESSION_COOKIE_NAME, { path: '/' })
    .send({ ok: true });
});
```

- [ ] **Step 7: รันเทสต์ auth**

```bash
pnpm build:shared && pnpm --filter @pos/api test -- src/modules/auth
```

คาดหวัง: PASS ทั้งหมด

> **ถ้า `logout` เทสต์อื่นแดงเพราะเดิมเรียกได้โดยไม่มีคุกกี้** — นั่นคือการเปลี่ยนพฤติกรรมที่ตั้งใจ (logout ต้องมีเซสชันถึงจะเพิกถอนได้) แก้เทสต์นั้นให้ล็อกอินก่อน แล้วบันทึกไว้ใต้ task นี้

- [ ] **Step 8: รันเทสต์ API ทั้งชุด — ที่นี่คือจุดที่จะเจอของพัง**

```bash
pnpm --filter @pos/api test
```

ทุก route ในระบบผ่าน guards ตัวนี้ ถ้ามีที่ไหนพึ่ง `request.jwtVerify()` ตรง ๆ จะโผล่ตรงนี้

```bash
grep -rn "jwtVerify" apps/api/src
```

คาดหวัง: ไม่เหลือที่ไหนนอกจากที่เพิ่งลบไป ถ้าเจอเพิ่มให้เปลี่ยนไปใช้ `requireAuth` แล้วบันทึกไว้

- [ ] **Step 9: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,148 ผ่าน (`@pos/api` +4 — เทสต์ logout เดิมถูกเขียนทับ ไม่ได้เพิ่มใหม่)

```bash
git add packages/shared/src/auth.ts apps/api/src
git commit -m "feat: make logout end the session instead of hiding the cookie

Every token now carries a jti pointing at a sessions row, and every request
checks that row is alive. Closes the gap the README admitted to: a token
copied before logout used to keep working until it expired.

Tokens issued before this change carry no jti and are refused, so everyone
signs in once more after deploy."
```

---

## Task 5: "ออกจากระบบทุกเครื่อง" และการล้างเซสชันเก่า

**Files:**

- Modify: `apps/api/src/modules/auth/auth.routes.ts` (เพิ่ม 1 endpoint)
- Modify: `apps/api/src/modules/auth/auth.routes.test.ts` (เพิ่ม describe ใหม่)
- Create: `apps/api/scripts/purge-sessions.ts`
- Modify: `apps/api/package.json` (เพิ่ม script)

**Interfaces:**

- Consumes: `app.sessions` จาก Task 4
- Produces: `POST /auth/sessions/revoke-all` · `pnpm --filter @pos/api sessions:purge`

- [ ] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

เพิ่ม describe ใหม่ท้าย `apps/api/src/modules/auth/auth.routes.test.ts`:

```ts
describe('signing out everywhere', () => {
  it('kills every session this person has, including the one that asked', async () => {
    // Two logins for the same person — a tablet and a phone, say.
    const first = await loginAs(app, Role.MANAGER);
    const second = await loginAs(app, Role.MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-all',
      headers: { cookie: second.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revoked).toBeGreaterThanOrEqual(2);

    // Including itself: "sign out everywhere" that leaves the asking device
    // signed in is not what the words say.
    for (const session of [first, second]) {
      const check = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: session.cookie },
      });
      expect(check.statusCode).toBe(401);
    }
  });

  it('401s without a session, because there is nobody to sign out', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/sessions/revoke-all' });
    expect(response.statusCode).toBe(401);
  });

  it('touches nobody else', async () => {
    const mine = await loginAs(app, Role.MANAGER);
    const theirs = await loginAs(app, Role.STAFF);

    await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-all',
      headers: { cookie: mine.cookie },
    });

    const check = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: theirs.cookie },
    });
    expect(check.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/api test -- src/modules/auth/auth.routes.test.ts
```

คาดหวัง: FAIL — 404 `ไม่พบเส้นทาง POST /api/auth/sessions/revoke-all`

- [ ] **Step 3: เพิ่ม endpoint**

ใน `apps/api/src/modules/auth/auth.routes.ts` ต่อจาก `/auth/logout`:

```ts
/**
 * Sign out of every device.
 *
 * The button for "I left my phone in a taxi", and the only honest answer to
 * it. Includes the session making the request — a version that spared the
 * caller would leave exactly one device signed in, which is the one case
 * where the person cannot check.
 *
 * No permission gate: this only ever ends the caller's own sessions, and
 * needing a permission to lock your own account is a rule that fires on the
 * day it is least welcome.
 */
app.post('/auth/sessions/revoke-all', { preHandler: requireAuth }, async (request, reply) => {
  const revoked = await app.sessions.revokeAllFor(request.user.staffId);

  return reply
    .clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    .clearCookie(OFFICE_SESSION_COOKIE_NAME, { path: '/' })
    .send({ ok: true, revoked });
});
```

- [ ] **Step 4: รันเทสต์**

```bash
pnpm --filter @pos/api test -- src/modules/auth/auth.routes.test.ts
```

คาดหวัง: PASS

- [ ] **Step 5: เขียนสคริปต์ล้างเซสชันเก่า**

สร้าง `apps/api/scripts/purge-sessions.ts`:

```ts
/**
 * Deletes sessions that expired more than SESSION_RETENTION_DAYS ago.
 *
 * Run from cron once a day — the schedule itself is deployment work and lands
 * in plan 3. Until then this is a command someone can run, which is enough:
 * the table grows by a handful of rows a day in a shop this size, so nothing
 * breaks if it is not run for a month.
 *
 * Deliberately NOT wired into the API's boot. A cleanup that runs on startup
 * is a cleanup that runs during a deploy, at the one moment nobody wants a
 * long-running DELETE competing with the first requests of the day.
 */

import { PrismaClient } from '@prisma/client';
import { SESSION_RETENTION_DAYS, SessionService } from '../src/modules/auth/session.service.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // The secret is only used for hashing new IPs, and this never issues a
  // session. Passing a placeholder is honest about that; reading JWT_SECRET
  // here would suggest this script needs it.
  const sessions = new SessionService(prisma, 'unused-by-purge');
  const removed = await sessions.purgeExpired();

  console.log(`ลบเซสชันที่หมดอายุเกิน ${SESSION_RETENTION_DAYS} วัน: ${removed} แถว`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
```

- [ ] **Step 6: เพิ่ม script ใน `apps/api/package.json`**

ใน `"scripts"` ต่อจาก `"db:studio"`:

```json
    "sessions:purge": "tsx scripts/purge-sessions.ts",
```

- [ ] **Step 7: รันสคริปต์จริงหนึ่งครั้ง**

```bash
pnpm --filter @pos/api sessions:purge
```

คาดหวัง: `ลบเซสชันที่หมดอายุเกิน 90 วัน: 0 แถว` (ฐานข้อมูล dev ยังไม่มีเซสชันเก่าขนาดนั้น) · ต้องจบด้วย exit code 0

- [ ] **Step 8: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,151 ผ่าน

```bash
git add apps/api/src/modules/auth apps/api/scripts apps/api/package.json
git commit -m "feat: add sign-out-everywhere and a session purge script

The purge is a command, not a cron job — scheduling it is deploy work and
belongs to plan 3. It is safe to not run: the table grows by a few rows a day."
```

---

## Task 6: ตรรกะล็อกอินหลังร้าน (อีเมล + รหัสผ่าน)

**Files:**

- Modify: `packages/shared/src/auth.ts` (ต่อจากที่เพิ่มใน Task 4)
- Create: `packages/shared/src/auth.test.ts` — **ตรวจก่อนว่ามีอยู่แล้วหรือยัง** ด้วย `ls packages/shared/src/auth.test.ts` ถ้ามีให้เพิ่มลงไปแทนที่จะสร้างใหม่
- Create: `apps/api/src/modules/auth/office-auth.service.ts`
- Create: `apps/api/src/modules/auth/office-auth.service.test.ts`

**Interfaces:**

- Consumes: คอลัมน์ `email` · `passwordHash` · `failedLoginAttempts` · `loginLockedUntil` จาก Task 2
- Produces:

  ```ts
  // @pos/shared
  export const PASSWORD_MIN_LENGTH = 12;
  export const PASSWORD_MAX_BYTES = 72;
  export const MAX_PASSWORD_ATTEMPTS = 10;
  export const PASSWORD_LOCKOUT_MS = 15 * 60 * 1000;
  export const emailSchema: z.ZodType<string>;
  export const passwordSchema: z.ZodType<string>;
  export const officeLoginRequestSchema: z.ZodObject<{ email; password }>;
  export type OfficeLoginRequest = { email: string; password: string };

  // apps/api
  export const PASSWORD_SALT_ROUNDS = 12;
  export function hashPassword(plain: string): Promise<string>;
  export type OfficeLoginResult =
    | { ok: true; user: SessionUser }
    | { ok: false; reason: 'BAD_CREDENTIALS' }
    | { ok: false; reason: 'LOCKED'; lockedUntil: Date; staffId: string; branchId: string };
  export class OfficeAuthService {
    constructor(db: PrismaClient);
    login(email: string, password: string, now?: Date): Promise<OfficeLoginResult>;
  }
  ```

  Task 7, 9, 10 ใช้ทั้งหมดนี้

- [ ] **Step 1: เขียนเทสต์ของ schema ที่ยังไม่ผ่าน**

เพิ่มใน `packages/shared/src/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { officeLoginRequestSchema, passwordSchema, PASSWORD_MIN_LENGTH } from './auth.js';

describe('the office password rules', () => {
  it('demands length and nothing else', () => {
    // NIST's advice, and the reason for it: rules about capitals and symbols
    // do not buy entropy, they buy Passw0rd! — a password that satisfies every
    // rule and is on every list.
    expect(passwordSchema.parse('ทุกอย่างที่ยาวพอก็ผ่าน')).toBeTruthy();
    expect(passwordSchema.parse('aaaaaaaaaaaa')).toBe('aaaaaaaaaaaa');
  });

  it(`refuses anything shorter than ${PASSWORD_MIN_LENGTH}`, () => {
    expect(() => passwordSchema.parse('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow();
  });

  it('refuses a password longer than bcrypt actually reads', () => {
    // bcrypt hashes the first 72 BYTES and silently ignores the rest. Accepting
    // 200 characters would tell the owner they have a long password when the
    // last 128 characters of it are decoration.
    expect(() => passwordSchema.parse('a'.repeat(73))).toThrow();
  });

  it('counts bytes, not characters, because Thai is three bytes each', () => {
    // 24 Thai characters is 72 bytes — the real ceiling. 25 is over it, even
    // though a length check on the string would say 25 is fine.
    expect(passwordSchema.parse('ก'.repeat(24))).toBeTruthy();
    expect(() => passwordSchema.parse('ก'.repeat(25))).toThrow();
  });

  it('does not trim the password', () => {
    // A trailing space is part of the secret. Trimming it here would mean a
    // password that works on one client and not another.
    expect(passwordSchema.parse('             ')).toBe('             ');
  });
});

describe('the office login request', () => {
  it('lowercases and trims the email so the unique index means what it looks like', () => {
    const parsed = officeLoginRequestSchema.parse({
      email: '  Owner@Example.COM ',
      password: 'a-long-enough-password',
    });
    expect(parsed.email).toBe('owner@example.com');
  });

  it('refuses something that is not an email', () => {
    expect(() =>
      officeLoginRequestSchema.parse({ email: 'owner', password: 'a-long-enough-password' }),
    ).toThrow();
  });

  it('refuses a short password before it reaches bcrypt', () => {
    expect(() => officeLoginRequestSchema.parse({ email: 'a@b.co', password: 'short' })).toThrow();
  });
});
```

- [ ] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/shared test -- src/auth.test.ts
```

คาดหวัง: FAIL — `passwordSchema` ยังไม่มี

- [ ] **Step 3: เพิ่ม schema ใน `@pos/shared`**

ต่อท้าย `packages/shared/src/auth.ts`:

```ts
/* ------------------------------------------------------------------ */
/* the back office door (plan 2)                                       */
/* ------------------------------------------------------------------ */

/**
 * Length, and only length.
 *
 * No rule about capitals or symbols, on purpose and following NIST: those
 * rules do not add entropy, they add Passw0rd! — a password that satisfies
 * every requirement and sits on every cracking list.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * bcrypt hashes the first 72 BYTES of its input and silently ignores whatever
 * follows. Accepting more would let someone set a 200-character password,
 * believe it is a 200-character password, and have the last 128 characters
 * count for nothing. Bytes, not characters: a Thai character is three of them,
 * so this is 24 Thai characters and 72 ASCII ones.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Wrong passwords allowed before the account freezes.
 *
 * Looser than the PIN's five, deliberately. A 12-character password is not
 * brute-forced in ten guesses or in ten million, so a tight lockout here buys
 * almost no protection — while handing anyone who knows the owner's email a
 * way to lock them out of their own accounts on payroll day. The per-IP limit
 * in the route is what actually holds; this is the backstop behind it.
 */
export const MAX_PASSWORD_ATTEMPTS = 10;
export const PASSWORD_LOCKOUT_MS = 15 * 60 * 1000;

/** Lowercased and trimmed, so the unique index means what a human means. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('อีเมลไม่ถูกต้อง')
  .max(160, 'อีเมลยาวเกินไป');

/**
 * NOT trimmed. A leading or trailing space is part of the secret, and trimming
 * it would make a password that works in one client fail in another.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`)
  .refine(
    (value) => new TextEncoder().encode(value).length <= PASSWORD_MAX_BYTES,
    `รหัสผ่านยาวเกินไป (ยาวได้ถึง ${PASSWORD_MAX_BYTES} ไบต์ — ภาษาไทยตัวละ 3 ไบต์)`,
  );

export const officeLoginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type OfficeLoginRequest = z.infer<typeof officeLoginRequestSchema>;
```

- [ ] **Step 4: รันเทสต์ shared**

```bash
pnpm --filter @pos/shared test -- src/auth.test.ts
```

คาดหวัง: PASS 8 ตัว

- [ ] **Step 5: เขียนเทสต์ของ service ที่ยังไม่ผ่าน**

สร้าง `apps/api/src/modules/auth/office-auth.service.test.ts`:

```ts
/**
 * The back office door.
 *
 * Its own throwaway staff row, like the PIN lockout test and for the same
 * reason: this file deliberately fails logins ten times in a row, and doing
 * that to a seeded account would lock out whatever another test file is doing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { MAX_PASSWORD_ATTEMPTS, Role, StaffStatus } from '@pos/shared';
import { prisma } from '../../db.js';
import { hashPassword, OfficeAuthService } from './office-auth.service.js';

const EMAIL = 'office-login-test@test.local';
const PASSWORD = 'a-password-long-enough';

let service: OfficeAuthService;
let staffId: string;
let branchId: string;

beforeAll(async () => {
  service = new OfficeAuthService(prisma);
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  branchId = branch.id;

  const staff = await prisma.staff.create({
    data: {
      branchId,
      fullName: 'ทดสอบ หลังร้าน',
      nickname: 'ทดสอบ',
      role: Role.OWNER,
      pinHash: await bcrypt.hash('5150', 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: StaffStatus.ACTIVE,
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  staffId = staff.id;
});

beforeEach(async () => {
  await prisma.staff.update({
    where: { id: staffId },
    data: { failedLoginAttempts: 0, loginLockedUntil: null, status: StaffStatus.ACTIVE },
  });
});

afterAll(async () => {
  await prisma.staff.delete({ where: { id: staffId } });
  await prisma.$disconnect();
});

describe('a correct password', () => {
  it('returns the session user, with the branch taken from the row', async () => {
    const result = await service.login(EMAIL, PASSWORD);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.staffId).toBe(staffId);
    // The office login screen has no branch picker. This is where the branch
    // comes from, and it is why the email has to be unique table-wide.
    expect(result.user.branchId).toBe(branchId);
    expect(result.user.role).toBe(Role.OWNER);
  });

  it('clears the failure counter and stamps the login time', async () => {
    await prisma.staff.update({ where: { id: staffId }, data: { failedLoginAttempts: 4 } });

    await service.login(EMAIL, PASSWORD);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(after.failedLoginAttempts).toBe(0);
    expect(after.lastLoginAt).not.toBeNull();
  });

  it('does not touch the PIN lockout', async () => {
    // The two counters are separate on purpose: a bot guessing at the office
    // password must not be able to take a cashier off the till.
    const until = new Date(Date.now() + 60_000);
    await prisma.staff.update({
      where: { id: staffId },
      data: { failedPinAttempts: 3, pinLockedUntil: until },
    });

    await service.login(EMAIL, PASSWORD);

    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(after.failedPinAttempts).toBe(3);
    expect(after.pinLockedUntil?.getTime()).toBe(until.getTime());

    await prisma.staff.update({
      where: { id: staffId },
      data: { failedPinAttempts: 0, pinLockedUntil: null },
    });
  });
});

describe('a wrong password', () => {
  it('is refused', async () => {
    const result = await service.login(EMAIL, 'not-the-right-password');
    expect(result).toEqual({ ok: false, reason: 'BAD_CREDENTIALS' });
  });

  it('counts up', async () => {
    await service.login(EMAIL, 'not-the-right-password');
    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
    expect(after.failedLoginAttempts).toBe(1);
  });

  it('freezes the account after enough of them, then refuses the right one too', async () => {
    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt += 1) {
      await service.login(EMAIL, 'not-the-right-password');
    }

    const result = await service.login(EMAIL, PASSWORD);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('LOCKED');
  });
});

describe('an email that cannot log in', () => {
  it('answers the same for an unknown address as for a wrong password', async () => {
    // Anything else turns this endpoint into a way to find out which addresses
    // belong to the shop, which is the first half of the attack.
    const unknown = await service.login('nobody@test.local', PASSWORD);
    const wrong = await service.login(EMAIL, 'not-the-right-password');
    expect(unknown).toEqual(wrong);
  });

  it('answers the same for someone with no password set at all', async () => {
    // Every cashier is in this state. Knowing the shop's email pattern must
    // not reveal which addresses have office access and which do not.
    const cashier = await prisma.staff.create({
      data: {
        branchId,
        fullName: 'ทดสอบ ไม่มีรหัส',
        role: Role.STAFF,
        pinHash: await bcrypt.hash('5151', 10),
        startDate: new Date('2026-01-01T00:00:00Z'),
        email: 'no-password@test.local',
      },
    });

    const result = await service.login('no-password@test.local', PASSWORD);
    expect(result).toEqual({ ok: false, reason: 'BAD_CREDENTIALS' });

    await prisma.staff.delete({ where: { id: cashier.id } });
  });

  it('refuses someone who has left, whatever they remember', async () => {
    await prisma.staff.update({ where: { id: staffId }, data: { status: StaffStatus.LEFT } });
    const result = await service.login(EMAIL, PASSWORD);
    expect(result).toEqual({ ok: false, reason: 'BAD_CREDENTIALS' });
  });

  it('spends real time on an unknown address, so timing does not answer either', async () => {
    // Returning early on "no such email" makes the miss measurably faster than
    // the hit, and that difference is itself the enumeration oracle this is
    // meant to close.
    const started = Date.now();
    await service.login('definitely-nobody@test.local', PASSWORD);
    expect(Date.now() - started).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 6: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm build:shared && pnpm --filter @pos/api test -- src/modules/auth/office-auth.service.test.ts
```

คาดหวัง: FAIL — `Cannot find module './office-auth.service.js'`

- [ ] **Step 7: เขียน `office-auth.service.ts`**

สร้าง `apps/api/src/modules/auth/office-auth.service.ts`:

```ts
/**
 * Email and password, for office.<domain>.
 *
 * The till keeps its PIN and this does not touch it. The two doors want
 * different things: a cashier hands the tablet to the next cashier twenty
 * times a shift and a long password on a screen by the till ends up on paper
 * taped to the monitor, which is worse than four digits behind a lockout. An
 * owner signs in once a day, from anywhere on the internet, to a screen that
 * shows every wage and every passport number in the shop.
 *
 * There is no staff list here and there must never be one. Picking your name
 * from a list is what makes the PIN flow work on a tablet; on a page anyone
 * can reach it is a directory of who works here and who the owner is.
 */

import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import {
  MAX_PASSWORD_ATTEMPTS,
  PASSWORD_LOCKOUT_MS,
  StaffStatus,
  type SessionUser,
} from '@pos/shared';

/**
 * Cost 12, up from the PIN's 10.
 *
 * ~0.6-1.2s on this hardware, which is invisible on a login that happens once
 * a day and expensive for anyone working through a list offline. Not argon2id,
 * though it is stronger: bcryptjs is pure JS with no build step, and argon2
 * would add a native dependency to install on a VPS for a gain that does not
 * matter at one login a day. Recorded as the upgrade path if that changes.
 */
export const PASSWORD_SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_SALT_ROUNDS);
}

export type OfficeLoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'BAD_CREDENTIALS' }
  | { ok: false; reason: 'LOCKED'; lockedUntil: Date; staffId: string; branchId: string };

/**
 * A real bcrypt hash of a string nobody knows, compared against when there is
 * no account to compare against.
 *
 * Without it, "no such email" returns in a millisecond and "wrong password"
 * returns in a second, and the difference tells anyone with a stopwatch which
 * addresses exist. Generated once and pasted here rather than computed at
 * boot, so the cost is paid by whoever wrote this file and not by every start.
 */
const ABSENT_ACCOUNT_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.a2t/qmGvB0kJnJ9hpZ8Zk3aVj4zHqDy';

export class OfficeAuthService {
  constructor(private readonly db: PrismaClient) {}

  async login(email: string, password: string, now: Date = new Date()): Promise<OfficeLoginResult> {
    const staff = await this.db.staff.findUnique({ where: { email } });

    // Four different ways to have no account here — unknown address, no
    // password set, left the shop — and they all have to look identical from
    // the outside, in wall-clock time as well as in the response.
    const usable =
      staff !== null && staff.passwordHash !== null && staff.status !== StaffStatus.LEFT;

    if (!usable) {
      await bcrypt.compare(password, ABSENT_ACCOUNT_HASH);
      return { ok: false, reason: 'BAD_CREDENTIALS' };
    }

    if (staff.loginLockedUntil && staff.loginLockedUntil > now) {
      // Do not even hash: a frozen account must cost an attacker a wait, not a
      // CPU cycle they can measure.
      return {
        ok: false,
        reason: 'LOCKED',
        lockedUntil: staff.loginLockedUntil,
        staffId: staff.id,
        branchId: staff.branchId,
      };
    }

    const matches = await bcrypt.compare(password, staff.passwordHash as string);

    if (!matches) {
      const attempts = staff.failedLoginAttempts + 1;
      const shouldLock = attempts >= MAX_PASSWORD_ATTEMPTS;
      const lockedUntil = shouldLock ? new Date(now.getTime() + PASSWORD_LOCKOUT_MS) : null;

      await this.db.staff.update({
        where: { id: staff.id },
        // The counter resets when the lock is set, so the wait buys a fresh
        // allowance rather than one attempt per lockout forever.
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          loginLockedUntil: lockedUntil,
        },
      });

      if (lockedUntil) {
        return {
          ok: false,
          reason: 'LOCKED',
          lockedUntil,
          staffId: staff.id,
          branchId: staff.branchId,
        };
      }
      // No attemptsLeft in the answer, unlike the PIN login. There the count is
      // shown to a cashier who mistyped on a keypad; here it would tell a bot
      // exactly how much budget it has left.
      return { ok: false, reason: 'BAD_CREDENTIALS' };
    }

    await this.db.staff.update({
      where: { id: staff.id },
      // Only the password counters. The PIN lockout is a separate fact about a
      // separate door and must not be cleared by getting in through this one.
      data: { failedLoginAttempts: 0, loginLockedUntil: null, lastLoginAt: now },
    });

    return {
      ok: true,
      user: {
        staffId: staff.id,
        branchId: staff.branchId,
        role: staff.role,
        fullName: staff.fullName,
        nickname: staff.nickname,
      },
    };
  }
}
```

> **`ABSENT_ACCOUNT_HASH` ต้องเป็น hash จริง** ถ้า bcrypt ปฏิเสธค่านี้เพราะ format ผิด เทสต์ `spends real time` จะแดง · สร้างใหม่ด้วย
> `node -e "console.log(require('bcryptjs').hashSync(require('crypto').randomBytes(32).toString('hex'), 12))"`
> แล้ววางทับ · **อย่าใช้รหัสผ่านจริงของใครสร้าง**

- [ ] **Step 8: รันเทสต์**

```bash
pnpm --filter @pos/api test -- src/modules/auth/office-auth.service.test.ts
```

คาดหวัง: PASS 11 ตัว

- [ ] **Step 9: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,170 ผ่าน (`@pos/shared` +8, `@pos/api` +11)

```bash
git add packages/shared/src/auth.ts packages/shared/src/auth.test.ts apps/api/src/modules/auth/office-auth.service.ts apps/api/src/modules/auth/office-auth.service.test.ts
git commit -m "feat: add email and password login for the back office

No route yet. The service is where every way of having no account has to look
identical from the outside — including in how long it takes — so it is worth
reviewing on its own before an endpoint is pointed at it."
```

---

## Task 7: `POST /auth/office/login`

**Files:**

- Modify: `apps/api/src/modules/auth/auth.routes.ts`
- Create: `apps/api/src/modules/auth/office-auth.routes.test.ts`

**Interfaces:**

- Consumes: `OfficeAuthService` จาก Task 6 · `issueSessionCookie` จาก Task 4
- Produces: `POST /auth/office/login` รับ `{ email, password }` ตอบ `{ user, permissions }` และเซ็ตคุกกี้ `office_session` — Task 12 เรียกตัวนี้

- [ ] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

สร้าง `apps/api/src/modules/auth/office-auth.routes.test.ts`:

```ts
/**
 * The office endpoint, end to end.
 *
 * The service tests cover who may log in; these cover what the HTTP surface
 * gives away — the cookie, the shape of a refusal, and the audit trail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import {
  OFFICE_SESSION_COOKIE_NAME,
  OFFICE_SESSION_TTL_SECONDS,
  Role,
  SESSION_COOKIE_NAME,
  StaffStatus,
} from '@pos/shared';
import { prisma } from '../../db.js';
import { buildTestApp } from '../../test-helpers.js';
import { hashPassword } from './office-auth.service.js';

const EMAIL = 'office-route-test@test.local';
const PASSWORD = 'a-password-long-enough';

let app: FastifyInstance;
let staffId: string;

beforeAll(async () => {
  app = await buildTestApp();
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  const staff = await prisma.staff.create({
    data: {
      branchId: branch.id,
      fullName: 'ทดสอบ เส้นทางหลังร้าน',
      role: Role.OWNER,
      pinHash: await bcrypt.hash('5152', 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: StaffStatus.ACTIVE,
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
  staffId = staff.id;
});

beforeEach(async () => {
  await prisma.staff.update({
    where: { id: staffId },
    data: { failedLoginAttempts: 0, loginLockedUntil: null },
  });
  await prisma.auditLog.deleteMany({ where: { entityType: 'SESSION', entityId: staffId } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityType: 'SESSION', entityId: staffId } });
  await prisma.session.deleteMany({ where: { staffId } });
  await prisma.staff.delete({ where: { id: staffId } });
  await app.close();
  await prisma.$disconnect();
});

function login(payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/auth/office/login', payload });
}

describe('signing in to the back office', () => {
  it('sets the OFFICE cookie, not the till cookie', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD });
    expect(response.statusCode).toBe(200);

    const raw = response.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw.join(';') : (raw ?? '');
    expect(cookies).toContain(`${OFFICE_SESSION_COOKIE_NAME}=`);
    expect(cookies).toContain('HttpOnly');
    // Sharing a name with the till would mean logging into one signs you out
    // of the other in dev, where both are localhost and cookies ignore ports.
    expect(cookies).not.toContain(`${SESSION_COOKIE_NAME}=`);
    expect(response.body).not.toContain('eyJ');
  });

  it('creates an OFFICE session that lasts eight hours, not twelve', async () => {
    await login({ email: EMAIL, password: PASSWORD });

    const row = await prisma.session.findFirstOrThrow({
      where: { staffId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.surface).toBe('OFFICE');
    const life = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(Math.round(life / 1000)).toBe(OFFICE_SESSION_TTL_SECONDS);
  });

  it('answers with the permissions the role carries', async () => {
    const response = await login({ email: EMAIL, password: PASSWORD });
    const body = response.json();
    expect(body.user.staffId).toBe(staffId);
    expect(body.permissions).toContain('VIEW_PAYROLL');
  });

  it('writes an audit row on the way in', async () => {
    await login({ email: EMAIL, password: PASSWORD });
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'SESSION', entityId: staffId, action: 'OFFICE_LOGIN' },
    });
    expect(rows.length).toBe(1);
    // The audit trail must never carry the credential itself.
    expect(JSON.stringify(rows[0])).not.toContain(PASSWORD);
  });

  it('writes an audit row on a failure too', async () => {
    await login({ email: EMAIL, password: 'not-the-right-password' });
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'SESSION', entityId: staffId, action: 'OFFICE_LOGIN_FAILED' },
    });
    expect(rows.length).toBe(1);
  });
});

describe('being refused', () => {
  it('401s with the same body for a wrong password and an unknown address', async () => {
    const wrong = await login({ email: EMAIL, password: 'not-the-right-password' });
    const unknown = await login({ email: 'nobody@test.local', password: PASSWORD });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    // Not "no such account", not "wrong password" — one message for both.
    expect(wrong.json().error).toBe('BAD_CREDENTIALS');
  });

  it('never says how many tries are left', async () => {
    // The PIN login tells a cashier who mistyped. Telling a bot is different.
    const response = await login({ email: EMAIL, password: 'not-the-right-password' });
    expect(response.json().attemptsLeft).toBeUndefined();
  });

  it('400s on a password too short to be one, before touching the database', async () => {
    const response = await login({ email: EMAIL, password: 'short' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('429s once the account is frozen, and says how long', async () => {
    await prisma.staff.update({
      where: { id: staffId },
      data: { loginLockedUntil: new Date(Date.now() + 10 * 60 * 1000) },
    });

    const response = await login({ email: EMAIL, password: PASSWORD });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe('LOGIN_LOCKED');
    expect(response.json().lockedUntil).toBeTruthy();
  });

  it('sets no cookie when it refuses', async () => {
    const response = await login({ email: EMAIL, password: 'not-the-right-password' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
```

- [ ] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm build:shared && pnpm --filter @pos/api test -- src/modules/auth/office-auth.routes.test.ts
```

คาดหวัง: FAIL — 404 `ไม่พบเส้นทาง POST /api/auth/office/login`

- [ ] **Step 3: เพิ่ม endpoint**

ใน `apps/api/src/modules/auth/auth.routes.ts` — เพิ่ม import:

```ts
import {
  officeLoginRequestSchema,
  OFFICE_SESSION_TTL_SECONDS,
  // ...ที่มีอยู่แล้ว
} from '@pos/shared';
import { OfficeAuthService } from './office-auth.service.js';
```

ใน `registerAuthRoutes` ต่อจาก `const service = new AuthService(prisma);`:

```ts
const officeService = new OfficeAuthService(prisma);
```

แล้วเพิ่ม handler ต่อจาก `/auth/login`:

```ts
/**
 * The back office door.
 *
 * A separate endpoint from the till's, not one endpoint that works out which
 * kind of credential it was handed. Two reasons, and both matter: `surface`
 * comes from the path that was called rather than from a header the caller
 * chose, and the two doors can be rate-limited on different terms without
 * one policy having to serve a tablet in a shop and a laptop on the internet.
 */
app.post('/auth/office/login', async (request, reply) => {
  const body = officeLoginRequestSchema.parse(request.body ?? {});
  const result = await officeService.login(body.email, body.password);

  if (!result.ok) {
    if (result.reason === 'LOCKED') {
      const seconds = Math.max(1, Math.ceil((result.lockedUntil.getTime() - Date.now()) / 1000));
      await writeLoginAudit(result.branchId, result.staffId, 'OFFICE_LOGIN_FAILED', 'บัญชีถูกล็อก');
      return reply.status(429).send({
        error: 'LOGIN_LOCKED',
        message: `ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกล็อก กรุณารออีก ${Math.ceil(seconds / 60)} นาที`,
        lockedUntil: result.lockedUntil.toISOString(),
      });
    }

    /**
     * A failure against an address we DO know gets an audit row; one against
     * an address we do not cannot have one, because AuditLog is keyed by
     * branch and there is no branch to key it to. That asymmetry is a fact
     * about the schema, not an oversight — the unknown-address case goes to
     * the request log instead, where it is still visible without inventing a
     * branch to file it under.
     */
    const known = await prisma.staff.findUnique({
      where: { email: body.email },
      select: { id: true, branchId: true },
    });
    if (known) {
      await writeLoginAudit(known.branchId, known.id, 'OFFICE_LOGIN_FAILED', 'รหัสผ่านไม่ถูกต้อง');
    } else {
      request.log.info({ email: body.email }, 'office login for an unknown address');
    }

    return reply.status(401).send({
      error: 'BAD_CREDENTIALS',
      message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
    });
  }

  await issueSessionCookie(app, reply, {
    user: result.user,
    surface: 'OFFICE',
    ttlSeconds: OFFICE_SESSION_TTL_SECONDS,
    isProduction,
    userAgent: request.headers['user-agent'],
    ip: request.ip,
  });

  await writeLoginAudit(result.user.branchId, result.user.staffId, 'OFFICE_LOGIN', null);

  return reply.send({ user: result.user, permissions: ROLE_PERMISSIONS[result.user.role] });
});
```

เพิ่มฟังก์ชันช่วยไว้ท้ายไฟล์ (นอก `registerAuthRoutes`):

```ts
/**
 * One audit row per office login attempt, successful or not.
 *
 * `entityId` is the staff id rather than a session id: the question this gets
 * asked for is "who has been trying to get into my reports", and that has to
 * be answerable for the attempts that never produced a session.
 *
 * Never carries the password, and never carries the token.
 */
async function writeLoginAudit(
  branchId: string,
  staffId: string,
  action: 'OFFICE_LOGIN' | 'OFFICE_LOGIN_FAILED',
  reason: string | null,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      branchId,
      staffId,
      action,
      entityType: 'SESSION',
      entityId: staffId,
      reason,
    },
  });
}
```

- [ ] **Step 4: รันเทสต์**

```bash
pnpm --filter @pos/api test -- src/modules/auth/office-auth.routes.test.ts
```

คาดหวัง: PASS 10 ตัว

- [ ] **Step 5: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,180 ผ่าน

```bash
git add apps/api/src/modules/auth
git commit -m "feat: add POST /auth/office/login

A separate endpoint from the till's rather than one that sniffs the payload:
the session surface comes from the path that was called, and the two doors can
be limited on different terms."
```

---

## Task 8: ปิด `/auth/staff` และ `/auth/branches` · จำกัดการลองผิดต่อ IP

**Files:**

- Move: `apps/api/src/modules/qr/rate-limit.ts` → `apps/api/src/rate-limit.ts` (`git mv`)
- Move: `apps/api/src/modules/qr/rate-limit.test.ts` → `apps/api/src/rate-limit.test.ts` (`git mv`)
- Modify: `apps/api/src/modules/qr/qr.routes.ts` (แก้ import)
- Create: `apps/api/src/modules/auth/host-guard.ts`
- Create: `apps/api/src/modules/auth/host-guard.test.ts`
- Modify: `apps/api/src/env.ts` · `env.test.ts` (เพิ่ม `TILL_HOSTS`)
- Modify: `apps/api/src/modules/auth/auth.routes.ts`
- Modify: `apps/api/src/modules/auth/auth.routes.test.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**

- Consumes: `RateLimiter` ที่มีอยู่แล้ว
- Produces: `tillOnly(hosts)` preHandler · `Env['TILL_HOSTS']: readonly string[]`

> **ข้อจำกัดที่ต้องพูดตรง ๆ:** การตรวจ `Host` เป็นกำแพงจริงก็ต่อเมื่อ API เข้าถึงตรง ๆ ไม่ได้ · ตอนนี้ API ฟังที่ `0.0.0.0:3001` ใครยิงตรงพร้อม header `Host:` ปลอมก็ผ่าน · **แผนที่ 3 คือคนที่ทำให้กำแพงนี้จริง** (bind localhost + reverse proxy) · สิ่งที่ task นี้ให้จริงตอนนี้คือ rate limit ต่อ IP ซึ่งไม่พึ่ง proxy · เขียนข้อจำกัดนี้ไว้ในคอมเมนต์ของ `host-guard.ts` ด้วย

- [ ] **Step 1: ย้าย `RateLimiter` ขึ้นมาให้สองโมดูลใช้ได้**

```bash
git mv apps/api/src/modules/qr/rate-limit.ts apps/api/src/rate-limit.ts
git mv apps/api/src/modules/qr/rate-limit.test.ts apps/api/src/rate-limit.test.ts
```

> ถ้า `rate-limit.test.ts` ไม่มีอยู่จริง ให้ข้ามคำสั่งที่สองแล้วบันทึกไว้

แก้ import ใน `apps/api/src/modules/qr/qr.routes.ts`:

```ts
import { RateLimiter } from '../../rate-limit.js';
```

แก้ import ใน `apps/api/src/rate-limit.test.ts` ให้ชี้ `./rate-limit.js`

- [ ] **Step 2: แก้คอมเมนต์หัวไฟล์ที่ตอนนี้ผิดแล้ว**

`apps/api/src/rate-limit.ts` — คอมเมนต์เดิมยืนยันว่า "KEYED BY TABLE TOKEN, NOT BY IP" ซึ่งจะกลายเป็นคำโกหกทันทีที่ auth ใช้มันแบบ keyed by IP · แทนที่บล็อกคอมเมนต์บรรทัด 1–17 ทั้งหมด:

```ts
/**
 * A small fixed-window counter, used by two callers that want opposite keys.
 *
 * THE QR ORDERING PAGE KEYS BY TABLE TOKEN. Everyone in the shop is behind one
 * router, so keying by IP there would let one phone stuck in a retry loop lock
 * every other customer out of ordering. The token is also the thing being
 * abused, so it is the thing worth counting.
 *
 * THE LOGIN ENDPOINTS KEY BY IP, for the mirror-image reason. Keying by account
 * is already done (the lockout columns on Staff) and it cannot see the attack
 * that matters here: one host on the internet working through a list of
 * addresses, one guess each, never tripping any single account's counter.
 *
 * Fixed windows are crude — a caller can spend a whole window's budget at the
 * end of one and again at the start of the next. That is fine for both uses.
 * This is not defending a bank; it is turning "unlimited guesses" into "a few
 * per minute", which is the difference between a weekend and a millennium.
 *
 * In memory, like the WebSocket hub, because this is one process on one box. A
 * shared store would be a moving part with nothing to move. The cost is that a
 * restart forgets every counter, which an attacker cannot cause on demand.
 */
```

- [ ] **Step 3: เขียนเทสต์ของ host guard ที่ยังไม่ผ่าน**

สร้าง `apps/api/src/modules/auth/host-guard.test.ts`:

```ts
/**
 * Which Host headers count as the till.
 *
 * Tested as a plain decision rather than through a route, because the thing
 * worth pinning down is the matching — ports, case, missing header — and going
 * through HTTP for each case would bury it.
 */

import { describe, expect, it } from 'vitest';
import { isTillHost } from './host-guard.js';

describe('isTillHost', () => {
  it('lets everything through when no hosts are configured', () => {
    // Dev: both apps talk to localhost:3001, so there is no Host that could
    // tell them apart. Configuring nothing has to mean "not enforced", not
    // "enforced and nothing matches" — the second locks the till out of its
    // own login screen the moment someone forgets the variable.
    expect(isTillHost([], 'anything.example.com')).toBe(true);
    expect(isTillHost([], undefined)).toBe(true);
  });

  it('matches the configured host', () => {
    expect(isTillHost(['shop.example.com'], 'shop.example.com')).toBe(true);
  });

  it('refuses the office host', () => {
    expect(isTillHost(['shop.example.com'], 'office.example.com')).toBe(false);
  });

  it('ignores the port, because a Host header may carry one', () => {
    expect(isTillHost(['shop.example.com'], 'shop.example.com:443')).toBe(true);
  });

  it('is case-insensitive, because host names are', () => {
    expect(isTillHost(['shop.example.com'], 'SHOP.Example.COM')).toBe(true);
  });

  it('refuses a missing Host once hosts are configured', () => {
    expect(isTillHost(['shop.example.com'], undefined)).toBe(false);
  });

  it('does not match a suffix', () => {
    // "evil-shop.example.com" ends with the configured host and must not pass.
    expect(isTillHost(['shop.example.com'], 'evil-shop.example.com')).toBe(false);
    expect(isTillHost(['shop.example.com'], 'shop.example.com.evil.test')).toBe(false);
  });

  it('accepts any of several hosts', () => {
    const hosts = ['shop.example.com', 'till.example.com'];
    expect(isTillHost(hosts, 'till.example.com')).toBe(true);
    expect(isTillHost(hosts, 'office.example.com')).toBe(false);
  });
});
```

- [ ] **Step 4: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/api test -- src/modules/auth/host-guard.test.ts
```

คาดหวัง: FAIL — `Cannot find module './host-guard.js'`

- [ ] **Step 5: เขียน `host-guard.ts`**

สร้าง `apps/api/src/modules/auth/host-guard.ts`:

```ts
/**
 * "This endpoint only exists on the till's domain."
 *
 * `/auth/staff` answers with every employee's name, nickname, role and id,
 * sorted with the owner first, to anyone who opens the URL. On the shop wifi
 * that was a list of colleagues on a device already inside the shop, and the
 * comment in auth.routes.ts said so. On the open internet it is the first half
 * of an attack: it hands over who the owner is and the staffId needed to start
 * guessing their PIN, in one unauthenticated request.
 *
 * WHAT THIS IS AND IS NOT. A Host header is chosen by whoever makes the
 * request. This is a real boundary only when the API cannot be reached
 * directly — when the reverse proxy is the sole way in and it matched the host
 * itself before proxying. Binding the API to localhost is plan 3's job, and
 * until that lands this narrows the target without sealing it. The per-IP
 * limiter on the login routes is the part that does not depend on the proxy.
 *
 * Refuses with 404, not 403: a 403 confirms the endpoint is there and that you
 * asked from the wrong place, which is more than a stranger needs to know.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * An EMPTY list means "not configured", which means everything passes.
 *
 * That is the right default and it is worth being explicit about why, because
 * the safe-looking alternative is the broken one: treating empty as "nothing
 * matches" would 404 the till's own login screen in every dev environment and
 * in any deployment where the variable was not set — a shop that cannot open.
 */
export function isTillHost(hosts: readonly string[], header: string | undefined): boolean {
  if (hosts.length === 0) return true;
  if (!header) return false;

  // Exact match on the name, port stripped. Never endsWith: that would let
  // evil-shop.example.com through.
  const name = header.split(':')[0]?.toLowerCase() ?? '';
  return hosts.some((host) => host.toLowerCase() === name);
}

export function tillOnly(
  hosts: readonly string[],
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (isTillHost(hosts, request.headers.host)) return;

    await reply.status(404).send({
      error: 'NOT_FOUND',
      message: `ไม่พบเส้นทาง ${request.method} ${request.url}`,
    });
  };
}
```

- [ ] **Step 6: เพิ่ม `TILL_HOSTS` ใน env**

`apps/api/src/env.ts` — เพิ่มใน `envSchema` ต่อจาก `WEB_ORIGIN`:

```ts
  /**
   * The host names the till is served on, comma-separated.
   *
   * `/auth/staff` and `/auth/branches` answer only to these. Leave it EMPTY in
   * development: both apps reach the API as localhost:3001, so there is no
   * Host that could tell them apart, and an empty list means the check does
   * not run rather than that nothing matches. See host-guard.ts.
   */
  TILL_HOSTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
```

เพิ่มเทสต์ใน `apps/api/src/env.test.ts`:

```ts
it('leaves TILL_HOSTS empty by default, which means the check does not run', () => {
  expect(loadEnv(VALID).TILL_HOSTS).toEqual([]);
});

it('splits TILL_HOSTS the same way as WEB_ORIGIN', () => {
  const env = loadEnv({ ...VALID, TILL_HOSTS: 'shop.example.com , till.example.com' });
  expect(env.TILL_HOSTS).toEqual(['shop.example.com', 'till.example.com']);
});
```

`apps/api/.env.example` — เพิ่มใต้ `WEB_ORIGIN`:

```
# Host names the till is served on. /auth/staff and /auth/branches answer only
# to these — the back office has no business listing who works here.
# LEAVE EMPTY IN DEV: both apps reach this API as localhost:3001, so there is
# no Host that tells them apart, and empty means the check is off.
# TILL_HOSTS="shop.example.com"
```

- [ ] **Step 7: ติดกำแพงและตัวนับเข้ากับ route**

`apps/api/src/modules/auth/auth.routes.ts` — เพิ่ม import:

```ts
import { RateLimiter } from '../../rate-limit.js';
import { tillOnly } from './host-guard.js';
```

ใน `registerAuthRoutes` ต่อจาก `const officeService = ...`:

```ts
const fromTill = tillOnly(options.env.TILL_HOSTS);

/**
 * Per-IP, on top of the per-account lockouts that already exist.
 *
 * The account counters cannot see the attack that matters once this is on
 * the internet: one host working through a list of accounts, a guess each,
 * never tripping any single counter. Twenty attempts a minute is far more
 * than a person who mistyped and far less than a script needs.
 *
 * Separate limiters for the two doors. A shop where every tablet is behind
 * one router shares an IP, so the till needs headroom the office does not —
 * and an office login is one person, once a day, from one machine.
 */
const tillLoginLimit = new RateLimiter(20, 60_000);
const officeLoginLimit = new RateLimiter(10, 60_000);
```

เพิ่ม `{ preHandler: fromTill }` ให้สอง endpoint ที่เปิดโล่ง:

```ts
  app.get('/auth/branches', { preHandler: fromTill }, async (_request, reply) => {
```

```ts
  app.get('/auth/staff', { preHandler: fromTill }, async (request, reply) => {
```

และแก้คอมเมนต์เหนือ `/auth/branches` ที่ตอนนี้อธิบายโลกที่ไม่มีอยู่แล้ว:

```ts
/**
 * The shops on the login screen (Step 10).
 *
 * Still open, but no longer to everyone: `fromTill` means it answers only on
 * the till's own domain (see host-guard.ts, including what that check is and
 * is not worth). It used to be justified as "a list of shop names on a device
 * already inside the shop's wifi" — that sentence stopped being true the day
 * the back office moved to the open internet.
 */
```

และเหนือ `/auth/staff`:

```ts
/** Names for the login screen. Till domain only — see /auth/branches above. */
```

เพิ่มการตรวจ rate limit เป็นบรรทัดแรกของ handler ทั้งสอง login:

```ts
  app.post('/auth/login', async (request, reply) => {
    const limit = tillLoginLimit.check(request.ip);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('Retry-After', String(limit.retryAfterSeconds))
        .send({ error: 'TOO_MANY_ATTEMPTS', message: 'ลองเข้าสู่ระบบถี่เกินไป กรุณารอสักครู่' });
    }

    const body = loginRequestSchema.parse(request.body ?? {});
```

```ts
  app.post('/auth/office/login', async (request, reply) => {
    const limit = officeLoginLimit.check(request.ip);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('Retry-After', String(limit.retryAfterSeconds))
        .send({ error: 'TOO_MANY_ATTEMPTS', message: 'ลองเข้าสู่ระบบถี่เกินไป กรุณารอสักครู่' });
    }

    const body = officeLoginRequestSchema.parse(request.body ?? {});
```

- [ ] **Step 8: เขียนเทสต์ของ route**

เพิ่มใน `apps/api/src/modules/auth/auth.routes.test.ts`:

```ts
describe('the endpoints that used to be open to everyone', () => {
  it('still answers on the till host when hosts are configured', async () => {
    const tillApp = await buildTestApp({ TILL_HOSTS: 'shop.example.com' });
    const response = await tillApp.inject({
      method: 'GET',
      url: '/api/auth/staff',
      headers: { host: 'shop.example.com' },
    });
    expect(response.statusCode).toBe(200);
    await tillApp.close();
  });

  it('404s on the office host, so the staff list is not on the internet', async () => {
    const tillApp = await buildTestApp({ TILL_HOSTS: 'shop.example.com' });
    for (const url of ['/api/auth/staff', '/api/auth/branches']) {
      const response = await tillApp.inject({
        method: 'GET',
        url,
        headers: { host: 'office.example.com' },
      });
      // 404, not 403: a 403 confirms it is there.
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toMatch(/fullName/);
    }
    await tillApp.close();
  });
});
```

`buildTestApp` ต้องรับ override — แก้ `apps/api/src/test-helpers.ts`:

```ts
export async function buildTestApp(
  overrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  const env = loadEnv({
    DATABASE_URL:
      process.env['DATABASE_URL'] ?? 'postgresql://pos:pos_dev_password@localhost:5432/pos_dev',
    JWT_SECRET: 'test-jwt-secret-value-long-enough',
    PRINT_AGENT_TOKEN: TEST_AGENT_TOKEN,
    NODE_ENV: 'test',
    ...overrides,
  });
  const app = await buildApp(env);
  await app.ready();
  return app;
}
```

- [ ] **Step 9: รันเทสต์ API ทั้งชุด**

```bash
pnpm --filter @pos/api test
```

คาดหวัง: PASS ทั้งหมด · **เทสต์ qr ต้องยังเขียว** — ถ้าแดงแปลว่า import ของ `RateLimiter` ยังไม่ครบ

- [ ] **Step 10: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,192 ผ่าน

```bash
git add apps/api
git commit -m "feat: close the open staff list and rate-limit both logins

/auth/staff handed over every name, role and staffId to anyone who opened the
URL — the owner sorted first. It now answers only on the till's own host.

That check is only a real wall once the API is unreachable directly, which is
plan 3's job; the per-IP limiter is the half that does not depend on a proxy."
```

---

## Task 9: ตั้งอีเมลและรหัสผ่านแรกตอน seed

**Files:**

- Modify: `apps/api/src/new-shop.ts`
- Modify: `apps/api/src/new-shop.test.ts`
- Modify: `apps/api/prisma/seed-core.ts`
- Modify: `apps/api/prisma/seed.ts`
- Modify: `apps/api/prisma/seed-demo.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**

- Consumes: `hashPassword` จาก Task 6 · คอลัมน์จาก Task 2
- Produces: `NewShopOwner` เพิ่ม `email: string` และ `password: string` · `NewShop` เพิ่ม `passwordWasGenerated: boolean` · `StaffSeed` เพิ่ม `email?` และ `password?`

> **กฎที่ห้ามพลาดใน task นี้:** รหัสผ่านห้ามโผล่ใน error message ห้ามโผล่ใน log ห้าม commit · เจ้าของพิมพ์เองใน `apps/api/.env` (มีใน `.gitignore` แล้ว) · ที่นี่รับได้แค่ "มีค่าอยู่" กับ "ยาวพอไหม" เท่านั้น

- [ ] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

เพิ่มใน `apps/api/src/new-shop.test.ts`:

```ts
describe('the owner email and password', () => {
  it('defaults the email to something obviously a placeholder', () => {
    const shop = resolveNewShop({}, pin);
    // Not a real-looking address: this shows up on the setup screen and it must
    // read as "change me", not as an address that might be someone's.
    expect(shop.owner.email).toBe('owner@localhost');
  });

  it('takes the email from the environment, lowercased', () => {
    const shop = resolveNewShop({ OWNER_EMAIL: '  Noi@Example.COM ' }, pin);
    expect(shop.owner.email).toBe('noi@example.com');
  });

  it('rejects something that is not an email', () => {
    expect(() => resolveNewShop({ OWNER_EMAIL: 'noi' }, pin)).toThrow(/OWNER_EMAIL/);
  });

  it('generates a password when none is given, and says it did', () => {
    const shop = resolveNewShop({}, pin);
    expect(shop.passwordWasGenerated).toBe(true);
    expect(shop.owner.password.length).toBeGreaterThanOrEqual(16);
  });

  it('takes the password from the environment without touching it', () => {
    // Not trimmed, not normalised. Whatever the owner typed IS the password.
    const shop = resolveNewShop({ OWNER_PASSWORD: 'correct horse battery ' }, pin);
    expect(shop.owner.password).toBe('correct horse battery ');
    expect(shop.passwordWasGenerated).toBe(false);
  });

  it('rejects a password too short to be one', () => {
    expect(() => resolveNewShop({ OWNER_PASSWORD: 'short' }, pin)).toThrow(/OWNER_PASSWORD/);
  });

  it('never puts the password in the error message', () => {
    // This error goes to a terminal that scrolls, into CI logs, into a
    // screenshot someone sends for help. Same rule the PIN already follows.
    const secret = 'hunter2-but-long-enough-to-pass';
    try {
      resolveNewShop({ OWNER_PASSWORD: secret, SHOP_CODE: 'ไม่ถูก' }, pin);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('generates a different password every time', () => {
    const a = resolveNewShop({}, pin).owner.password;
    const b = resolveNewShop({}, pin).owner.password;
    expect(a).not.toBe(b);
  });

  it('generates a password with no look-alike characters in it', () => {
    // This gets read off a terminal and typed into a browser, once, by someone
    // who cannot ask for it again. 0/O and 1/l/I are how that goes wrong.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(resolveNewShop({}, pin).owner.password).not.toMatch(/[0O1lI]/);
    }
  });
});
```

- [ ] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/api test -- src/new-shop.test.ts
```

คาดหวัง: FAIL — `shop.owner.email` เป็น undefined

- [ ] **Step 3: แก้ `new-shop.ts`**

`apps/api/src/new-shop.ts` — แก้ interface:

```ts
export interface NewShopOwner {
  fullName: string;
  nickname: string;
  pin: string;
  /** The username for office.<domain>. Unique across the whole staff table. */
  email: string;
  password: string;
}

export interface NewShop {
  name: string;
  branchCode: string;
  owner: NewShopOwner;
  /**
   * true when nobody supplied OWNER_PIN, so the seed has to print the PIN it
   * made up. A generated PIN that is never shown is a locked shop.
   */
  pinWasGenerated: boolean;
  /** Same, for the back office password. */
  passwordWasGenerated: boolean;
}
```

เพิ่มใน `SHOP_DEFAULTS`:

```ts
export const SHOP_DEFAULTS = {
  name: 'ร้านของฉัน',
  branchCode: 'HQ',
  ownerFullName: 'เจ้าของร้าน',
  /**
   * Deliberately not a real-looking address. It appears on the setup output
   * and has to read as "change this", not as an address that might belong to
   * a stranger who would then receive the shop's password reset one day.
   */
  ownerEmail: 'owner@localhost',
} as const;
```

เพิ่มตัวสร้างรหัสผ่านใต้ `generatePin`:

```ts
/**
 * Characters that survive being read off a terminal and typed into a browser.
 *
 * No 0/O, no 1/l/I. This string is shown exactly once, to someone who cannot
 * ask for it again, and "was that a one or an ell" is how a shop locks itself
 * out on setup day.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Long enough that nobody needs to think about whether it is long enough. */
const GENERATED_PASSWORD_LENGTH = 20;

/**
 * A random password for the back office.
 *
 * `randomInt`, not `Math.random`, for the same reason as the PIN: this opens
 * the screen with every wage and passport number in the shop on it.
 */
export function generatePassword(): string {
  let out = '';
  for (let index = 0; index < GENERATED_PASSWORD_LENGTH; index += 1) {
    out += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)];
  }
  return out;
}
```

แก้ signature และเนื้อของ `resolveNewShop`:

```ts
export function resolveNewShop(
  env: NodeJS.ProcessEnv = process.env,
  makePin: () => string = generatePin,
  makePassword: () => string = generatePassword,
): NewShop {
```

เพิ่มการตรวจต่อจากบล็อก `typedPin` (ก่อน `if (problems.length > 0)`):

```ts
const email = read(env, 'OWNER_EMAIL')?.toLowerCase() ?? SHOP_DEFAULTS.ownerEmail;
// Deliberately loose: one @, something either side, no spaces. A stricter
// pattern here would reject valid addresses, and the only thing this field
// does is identify one row — it is never posted to.
if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
  problems.push(`OWNER_EMAIL ต้องเป็นอีเมลที่ถูกต้อง (ได้ "${email}")`);
}

// NOT via read(): that trims, and a leading or trailing space is part of a
// password. Only "absent" and "present but empty" collapse together here.
const typedPassword = env['OWNER_PASSWORD'];
const hasPassword = typedPassword !== undefined && typedPassword !== '';
if (hasPassword && new TextEncoder().encode(typedPassword).length < PASSWORD_MIN_LENGTH) {
  // The password itself is never echoed back, exactly like the PIN above.
  problems.push(`OWNER_PASSWORD ต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`);
}
```

แล้วแก้ return:

```ts
return {
  name,
  branchCode,
  owner: {
    fullName,
    nickname,
    pin: typedPin ?? makePin(),
    email,
    password: hasPassword ? typedPassword : makePassword(),
  },
  pinWasGenerated: typedPin === undefined,
  passwordWasGenerated: !hasPassword,
};
```

เพิ่ม import ที่หัวไฟล์:

```ts
import { PASSWORD_MIN_LENGTH } from '@pos/shared';
```

> **หมายเหตุความยาว:** เทียบเป็นไบต์เหมือน `passwordSchema` ไม่ใช่ `.length` — รหัสผ่านภาษาไทย 12 ตัวคือ 36 ไบต์ ผ่านสบาย แต่ `.length` กับไบต์ต้องใช้เกณฑ์เดียวกันทั้งระบบ ไม่งั้นรหัสที่ seed รับ อาจล็อกอินไม่ผ่าน

- [ ] **Step 4: รันเทสต์**

```bash
pnpm build:shared && pnpm --filter @pos/api test -- src/new-shop.test.ts
```

คาดหวัง: PASS ทั้งหมด

- [ ] **Step 5: ให้ seed เขียนอีเมลและรหัสผ่านลงฐานข้อมูล**

`apps/api/prisma/seed-core.ts` — เพิ่มใน `StaffSeed`:

```ts
  /** Back office login. Both optional: a cashier has neither. */
  email?: string;
  password?: string;
```

ใน `upsertStaff` เพิ่มลงใน `data` ต่อจาก `pinHash`:

```ts
    email: person.email ?? null,
    passwordHash: person.password ? await hashPassword(person.password) : null,
```

เพิ่ม import:

```ts
import { hashPassword } from '../src/modules/auth/office-auth.service.js';
```

> **`upsertStaff` มี `overwrite` อยู่แล้วและกฎเดิมยังคุ้มครองรหัสผ่านโดยอัตโนมัติ** — `overwrite: false` คืนค่า `'kept'` ตั้งแต่ก่อนแตะ `data` ดังนั้นการรัน `pnpm db:seed` ซ้ำหกเดือนให้หลังจะไม่ทับรหัสผ่านที่เจ้าของเปลี่ยนไปแล้ว เหมือนที่มันไม่ทับ PIN

- [ ] **Step 6: แก้ `seed.ts` ให้ส่งค่าเข้าไปและพิมพ์ผลลัพธ์**

`apps/api/prisma/seed.ts` — ใน `upsertStaff(...)` เพิ่มสองบรรทัดใน object ของ person:

```ts
      email: shop.owner.email,
      password: shop.owner.password,
```

แทนที่บล็อก `if (outcome === 'created')`:

```ts
if (outcome === 'created') {
  console.log(`  เจ้าของ: ${shop.owner.fullName}`);
  console.log(`  อีเมลเข้าหลังร้าน: ${shop.owner.email}`);

  if (shop.pinWasGenerated || shop.passwordWasGenerated) {
    // The only time either of these is ever readable. Both are stored as
    // bcrypt hashes and there is no screen anywhere that can show them again.
    console.log('');
    console.log('  ================================================');
    if (shop.pinWasGenerated) {
      console.log(`  PIN หน้าร้าน:      ${shop.owner.pin}`);
    }
    if (shop.passwordWasGenerated) {
      console.log(`  รหัสผ่านหลังร้าน:  ${shop.owner.password}`);
    }
    console.log('  จดไว้ก่อนปิดหน้าต่างนี้ — ดูย้อนหลังไม่ได้');
    console.log('  เปลี่ยนได้ทีหลังที่หน้า "พนักงาน"');
    console.log('  ================================================');
  }
} else {
  console.log(`  เจ้าของ: ${shop.owner.fullName} (มีอยู่แล้ว — ไม่ได้แตะ PIN หรือรหัสผ่านเดิม)`);
}
```

แก้คอมเมนต์หัวไฟล์ให้ตรง — เพิ่มสองบรรทัดในรายการตัวแปร:

```
 *   OWNER_EMAIL     อีเมลเข้าหลังร้าน         (default owner@localhost)
 *   OWNER_PASSWORD  รหัสผ่านหลังร้าน          (default: สุ่มให้ แล้วพิมพ์บนจอครั้งเดียว)
```

- [ ] **Step 7: ให้ demo seed มีบัญชีหลังร้านที่รู้รหัส**

`apps/api/prisma/seed-demo.ts` — หา person ที่ role เป็น `OWNER` แล้วเพิ่ม:

```ts
    email: 'owner@demo.local',
    password: 'demo-password-1234',
```

> ค่านี้เป็นข้อมูล dev เหมือน PIN 1111/2222/3333 ที่มีอยู่แล้ว · Task 12 ใช้มันทดสอบด้วยมือ

เพิ่มใน `apps/api/src/test-helpers.ts` ใต้ `SEED_PINS`:

```ts
/** The back office account created by prisma/seed-demo.ts. Dev data only. */
export const SEED_OFFICE = {
  email: 'owner@demo.local',
  password: 'demo-password-1234',
} as const;
```

- [ ] **Step 8: แก้ `.env.example`**

`apps/api/.env.example` — เพิ่มท้ายบล็อก setup:

```
# OWNER_EMAIL="noi@example.com"
#
# The back office password. Type your own — 12 characters minimum, no rule
# about capitals or symbols. Leave it out and the seed generates one and prints
# it once, which is fine too.
#
# THIS FILE IS GITIGNORED. Never move this line into .env.example itself, and
# never paste the value into a chat, a ticket or a screenshot.
# OWNER_PASSWORD=""
```

- [ ] **Step 9: รันจริงกับฐานข้อมูลเปล่า**

```bash
pnpm --filter @pos/api exec prisma migrate reset --force --skip-seed
pnpm db:seed
```

คาดหวัง: เห็นกล่องที่มีทั้ง PIN และรหัสผ่านสุ่ม · ตรวจว่าไม่มีตัว `0` `O` `1` `l` `I` ในรหัสผ่าน

รันซ้ำอีกครั้ง:

```bash
pnpm db:seed
```

คาดหวัง: `เจ้าของ: ... (มีอยู่แล้ว — ไม่ได้แตะ PIN หรือรหัสผ่านเดิม)` และ **ไม่มีกล่องรหัสผ่าน** · ถ้ามีแปลว่ากฎ "seed ซ้ำไม่ทับของเดิม" พัง ให้หยุด

แล้วคืนฐานข้อมูล dev กลับ:

```bash
pnpm db:seed:demo
```

- [ ] **Step 10: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,201 ผ่าน

```bash
git add apps/api/src/new-shop.ts apps/api/src/new-shop.test.ts apps/api/prisma apps/api/src/test-helpers.ts apps/api/.env.example
git commit -m "feat: seed the owner an office email and password

Generated from a no-look-alike alphabet and printed once, like the PIN. A
re-run six months later still never overwrites either."
```

---

## Task 10: ตั้งอีเมลและรหัสผ่านให้คนอื่นจากหน้าพนักงาน

**Files:**

- Modify: `packages/shared/src/payroll.ts` (`staffDtoSchema`, `staffRequestSchema`, schema ใหม่)
- Modify: `apps/api/src/modules/staff/staff.service.ts` (`toStaffDto`, `staffAuditShape`)
- Modify: `apps/api/src/modules/staff/staff.routes.ts`
- Modify: `apps/api/src/modules/staff/staff.routes.test.ts`

**Interfaces:**

- Consumes: `hashPassword` จาก Task 6 · `app.sessions` จาก Task 4
- Produces:
  - `StaffDto` เพิ่ม `email: string | null` · `hasOfficeAccess: boolean` · `isLoginLocked: boolean`
  - `POST /staff/:id/password` รับ `{ password }`
  - `DELETE /staff/:id/password` — ถอนสิทธิ์เข้าหลังร้าน
  - Task 12 ไม่ได้ใช้ แต่หน้าพนักงานที่มีอยู่จะแสดงผลได้

- [ ] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

เพิ่มใน `apps/api/src/modules/staff/staff.routes.test.ts`:

```ts
describe('back office access', () => {
  it('reports who has it and who does not', async () => {
    const { cookie } = await loginAs(app, Role.OWNER);
    const response = await app.inject({ method: 'GET', url: '/api/staff', headers: { cookie } });

    const rows = response.json().staff as Array<{
      role: string;
      hasOfficeAccess: boolean;
      email: string | null;
    }>;
    const owner = rows.find((row) => row.role === Role.OWNER);
    expect(owner?.hasOfficeAccess).toBe(true);
    expect(owner?.email).toBe('owner@demo.local');
  });

  it('never returns the password hash', async () => {
    const { cookie } = await loginAs(app, Role.OWNER);
    const response = await app.inject({ method: 'GET', url: '/api/staff', headers: { cookie } });
    expect(response.body).not.toMatch(/\$2[aby]\$/);
    expect(response.body).not.toContain('passwordHash');
  });

  it('gives someone office access by setting a password', async () => {
    const { cookie } = await loginAs(app, Role.OWNER);
    const staff = await makeThrowawayStaff();

    const set = await app.inject({
      method: 'POST',
      url: `/api/staff/${staff.id}/password`,
      headers: { cookie },
      payload: { password: 'a-password-long-enough' },
    });
    expect(set.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/office/login',
      payload: { email: staff.email, password: 'a-password-long-enough' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses to set a password on someone with no email to log in with', async () => {
    // An account with a password and no username is not an account, it is a
    // hash nobody can ever present a credential against.
    const { cookie } = await loginAs(app, Role.OWNER);
    const staff = await makeThrowawayStaff({ email: null });

    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${staff.id}/password`,
      headers: { cookie },
      payload: { password: 'a-password-long-enough' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses an email another person already has', async () => {
    const { cookie } = await loginAs(app, Role.OWNER);
    const staff = await makeThrowawayStaff();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/staff/${staff.id}`,
      headers: { cookie },
      payload: { ...staffPayload(staff), email: 'owner@demo.local' },
    });
    // Unique across the whole table, not per branch — the office login has no
    // branch picker, so an email must point at exactly one row.
    expect(response.statusCode).toBe(409);
  });

  it('takes office access away and kills the sessions it was holding', async () => {
    const { cookie } = await loginAs(app, Role.OWNER);
    const staff = await makeThrowawayStaff();

    await app.inject({
      method: 'POST',
      url: `/api/staff/${staff.id}/password`,
      headers: { cookie },
      payload: { password: 'a-password-long-enough' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/office/login',
      payload: { email: staff.email, password: 'a-password-long-enough' },
    });
    const theirCookie = (login.headers['set-cookie'] as string[])[0]?.split(';')[0] as string;

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/staff/${staff.id}/password`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);

    // The point of the whole sessions table: cutting access off means NOW, not
    // when the token they are already holding happens to expire.
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: theirCookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('writes an audit row that does not contain the password', async () => {
    const { cookie } = await loginAs(app, Role.OWNER);
    const staff = await makeThrowawayStaff();

    await app.inject({
      method: 'POST',
      url: `/api/staff/${staff.id}/password`,
      headers: { cookie },
      payload: { password: 'a-password-long-enough' },
    });

    const rows = await prisma.auditLog.findMany({
      where: { entityId: staff.id, action: 'SET_STAFF_PASSWORD' },
    });
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain('a-password-long-enough');
  });

  it('needs MANAGE_STAFF, like every other write here', async () => {
    const { cookie } = await loginAs(app, Role.STAFF);
    const staff = await makeThrowawayStaff();

    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${staff.id}/password`,
      headers: { cookie },
      payload: { password: 'a-password-long-enough' },
    });
    expect(response.statusCode).toBe(403);
  });
});
```

พร้อม helper สองตัวที่หัวไฟล์ (**ตรวจก่อนว่ามีของเดิมอยู่แล้วไหม** ด้วย `grep -n "function make\|function staffPayload" apps/api/src/modules/staff/staff.routes.test.ts` — ถ้ามีให้ใช้ของเดิมแทน):

```ts
/**
 * A staff row this file owns and deletes again.
 *
 * Each one gets a unique email off a counter: the index is table-wide, so two
 * throwaways sharing an address would collide with each other rather than with
 * the thing under test, and the failure would read as a bug in the endpoint.
 */
const throwaways: string[] = [];

async function makeThrowawayStaff(
  over: { email?: string | null } = {},
): Promise<{ id: string; email: string }> {
  const branch = await prisma.branch.findFirstOrThrow({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  const email = over.email === undefined ? `throwaway-${throwaways.length}@test.local` : over.email;

  const staff = await prisma.staff.create({
    data: {
      branchId: branch.id,
      fullName: `ทดสอบ ชั่วคราว ${throwaways.length}`,
      nickname: 'ชั่วคราว',
      role: Role.STAFF,
      pinHash: await bcrypt.hash(String(6000 + throwaways.length), 10),
      startDate: new Date('2026-01-01T00:00:00Z'),
      status: StaffStatus.ACTIVE,
      email,
    },
  });
  throwaways.push(staff.id);
  return { id: staff.id, email: email ?? '' };
}

/** A body that satisfies staffRequestSchema, for the PUT tests. */
function staffPayload(staff: { id: string }): Record<string, unknown> {
  return {
    fullName: 'ทดสอบ ชั่วคราว แก้ไข',
    nickname: 'ชั่วคราว',
    position: null,
    role: Role.STAFF,
    phone: null,
    startDate: '2026-01-01',
    endDate: null,
    status: StaffStatus.ACTIVE,
    nationality: 'TH',
    passportNo: null,
    passportExpiry: null,
    workPermitNo: null,
    workPermitExpiry: null,
    wageType: 'DAILY',
    wageRateSatang: 40000,
    note: null,
  };
}
```

และใน `afterAll` ของไฟล์ (เพิ่มเข้าไปในตัวที่มีอยู่แล้ว):

```ts
await prisma.session.deleteMany({ where: { staffId: { in: throwaways } } });
await prisma.auditLog.deleteMany({ where: { entityId: { in: throwaways } } });
await prisma.staff.deleteMany({ where: { id: { in: throwaways } } });
```

> **`staffPayload` รับ `staff` แต่ไม่ได้ใช้** โดยตั้งใจ — เรียกด้วย `staffPayload(staff)` อ่านแล้วชัดกว่าว่ากำลังแก้ใคร · ถ้า ESLint บ่นเรื่อง parameter ที่ไม่ได้ใช้ ให้เปลี่ยนเป็นไม่รับพารามิเตอร์แล้วเรียก `staffPayload()`

- [ ] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/api test -- src/modules/staff/staff.routes.test.ts
```

คาดหวัง: FAIL — `hasOfficeAccess` undefined และ 404 บน `/password`

- [ ] **Step 3: แก้ shared**

`packages/shared/src/payroll.ts` — เพิ่มใน `staffDtoSchema` ต่อจาก `phone`:

```ts
  /** The back office username. null for everyone who does not have one. */
  email: z.string().nullable(),
  /** Whether a password is set. The hash itself never leaves the API. */
  hasOfficeAccess: z.boolean(),
  /** True while the password lockout is in force, so the screen can say so. */
  isLoginLocked: z.boolean(),
```

เพิ่มใน `staffRequestSchema` (หา object นั้นแล้วเพิ่ม field):

```ts
  /**
   * Optional and nullable: most people have none, and clearing it is how an
   * account stops being able to reach the back office by username.
   */
  email: emailSchema.nullable().optional(),
```

เพิ่ม schema ใหม่ท้ายบล็อก staff:

```ts
export const staffPasswordRequestSchema = z.object({ password: passwordSchema });
export type StaffPasswordRequest = z.infer<typeof staffPasswordRequestSchema>;
```

เพิ่ม import ที่หัวไฟล์: `import { emailSchema, passwordSchema } from './auth.js';`

> **ระวัง import วน:** ถ้า `auth.ts` import อะไรจาก `payroll.ts` อยู่แล้วจะเกิดวง · ตรวจด้วย `grep -n "payroll" packages/shared/src/auth.ts` — ถ้าเจอ ให้ย้าย `emailSchema`/`passwordSchema` ไป `schemas.ts` แทน แล้วบันทึกไว้

- [ ] **Step 4: แก้ `toStaffDto`**

`apps/api/src/modules/staff/staff.service.ts` — เพิ่มใน object ที่ return ต่อจาก `phone: row.phone,`:

```ts
    email: row.email,
    // The boolean, never the hash. A screen only needs to know whether the
    // door exists, and a hash on the wire is a hash in someone's devtools.
    hasOfficeAccess: row.passwordHash !== null,
    isLoginLocked: !!row.loginLockedUntil && row.loginLockedUntil > now,
```

เพิ่มใน `staffAuditShape` ต่อจาก `role`:

```ts
    email: row.email,
```

- [ ] **Step 5: แก้ `staff.routes.ts`**

เพิ่ม import:

```ts
import { staffPasswordRequestSchema } from '@pos/shared';
import { hashPassword } from '../auth/office-auth.service.js';
```

ใน `toStaffColumns` (ท้ายไฟล์) เพิ่ม `email: body.email ?? null,` — **ตรวจก่อนว่า `toStaffColumns` map field ทีละตัวจริง** ด้วย `grep -n "function toStaffColumns" -A 30 apps/api/src/modules/staff/staff.routes.ts` ถ้ามันสเปรด body ทั้งก้อนก็ไม่ต้องแก้

ห่อ `POST /staff` และ `PUT /staff/:id` ให้แปลง P2002 เป็น 409 — เพิ่มฟังก์ชันช่วยท้ายไฟล์:

```ts
/**
 * Turns a duplicate-email collision into something a screen can say.
 *
 * The unique index is table-wide, so the person already holding this address
 * may be at another branch and therefore invisible to whoever is typing. A
 * raw Prisma error would surface as a 500 and tell them nothing.
 */
function isDuplicateEmail(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002' &&
    JSON.stringify((error as { meta?: unknown }).meta ?? {}).includes('email')
  );
}
```

แล้วห่อสอง `prisma.staff.create` / `prisma.staff.update` ใน handler ทั้งสอง:

```ts
let created;
try {
  created = await prisma.staff.create({
    data: { branchId: branch.id, pinHash: await hashPin(body.pin), ...toStaffColumns(body) },
  });
} catch (error) {
  if (isDuplicateEmail(error)) throw conflict('อีเมลนี้มีคนใช้แล้ว');
  throw error;
}
```

(แบบเดียวกันกับ `update` ใน `PUT /staff/:id`)

เพิ่มสอง endpoint ต่อจาก `POST /staff/:id/pin`:

```ts
/**
 * Give someone the back office, or change their password.
 *
 * Its own endpoint for the same reason the PIN has one: editing a phone
 * number and deciding who can read every wage in the shop are different
 * acts, and only one of them should be possible by accident while tidying a
 * form. Setting a password also clears the lockout — being handed a new one
 * and still not being able to use it for fifteen minutes is exactly the
 * moment somebody is standing there waiting.
 */
app.post('/staff/:id/password', { preHandler: writeStaff }, async (request, reply) => {
  const { id } = idParams.parse(request.params);
  const { password } = staffPasswordRequestSchema.parse(request.body);
  const branch = await requireSessionBranch(prisma, request.user.branchId);
  const existing = await requireStaff(prisma, branch.id, id);

  // A password with no username is a hash nobody can ever present a
  // credential against — the office login screen asks for an email.
  if (!existing.email) {
    throw conflict('ต้องใส่อีเมลให้คนนี้ก่อน ถึงจะตั้งรหัสผ่านเข้าหลังร้านได้');
  }

  await prisma.staff.update({
    where: { id },
    data: {
      passwordHash: await hashPassword(password),
      failedLoginAttempts: 0,
      loginLockedUntil: null,
    },
  });

  // No before/after: the whole content of this change is a secret. That it
  // happened, to whom and by whom is the part worth keeping.
  await audit(branch.id, request.user.staffId, 'SET_STAFF_PASSWORD', id, {
    reason: `ตั้งรหัสผ่านหลังร้านให้ ${existing.fullName}`,
  });

  return reply.send(await roster(branch.id, branchBusinessDate(branch)));
});

/**
 * Take the back office away.
 *
 * Revokes their live sessions in the same breath. Clearing the hash alone
 * would stop the NEXT login and leave whatever they are already holding
 * working for hours — which is the exact failure the sessions table was
 * added to make impossible.
 */
app.delete('/staff/:id/password', { preHandler: writeStaff }, async (request, reply) => {
  const { id } = idParams.parse(request.params);
  const branch = await requireSessionBranch(prisma, request.user.branchId);
  const existing = await requireStaff(prisma, branch.id, id);

  await prisma.staff.update({
    where: { id },
    data: { passwordHash: null, failedLoginAttempts: 0, loginLockedUntil: null },
  });
  const revoked = await app.sessions.revokeAllFor(id);

  await audit(branch.id, request.user.staffId, 'REVOKE_STAFF_PASSWORD', id, {
    reason: `ปิดสิทธิ์เข้าหลังร้านของ ${existing.fullName} (ตัดเซสชัน ${revoked} เครื่อง)`,
  });

  return reply.send(await roster(branch.id, branchBusinessDate(branch)));
});
```

> `registerStaffRoutes(app)` ต้องเข้าถึง `app.sessions` ได้ — เข้าถึงได้อยู่แล้วเพราะ decorate ที่ root (Task 4) มองเห็นจาก plugin ลูก

- [ ] **Step 6: รันเทสต์**

```bash
pnpm build:shared && pnpm --filter @pos/api test -- src/modules/staff
```

คาดหวัง: PASS ทั้งหมด

- [ ] **Step 7: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,209 ผ่าน

> **`@pos/office` อาจแดงตรงนี้** — `StaffDto` เพิ่มสาม field และหน้า `StaffListPage` มี fixture ที่สร้าง DTO ด้วยมือ · เติมสาม field ลง fixture ให้ครบ **ห้ามแก้ `expect`** ถ้าต้องแก้ ให้หยุดแล้วรายงาน

```bash
git add packages/shared apps/api apps/office
git commit -m "feat: manage office access from the staff screen

Taking access away revokes the sessions it was holding, rather than waiting
for a token to lapse — which is what the sessions table was for."
```

---

## Task 11: ให้ `createSessionStore` รับกุญแจคนละชนิดได้

**Files:**

- Modify: `packages/web-kit/src/session-store.ts`
- Modify: `packages/web-kit/src/session-store.test.ts`
- Modify: `apps/web/src/session.ts`
- Modify: `apps/web/src/pages/LoginPage.tsx:92`
- Modify: `apps/office/src/session.ts`

**Interfaces:**

- Consumes: ไม่มีจาก task ก่อนหน้า (ฝั่งเว็บล้วน)
- Produces:
  ```ts
  export interface SessionApi<C> {
    me(): Promise<ApiResult<MeResponse>>;
    login(credentials: C): Promise<ApiResult<{ user: SessionUser }>>;
    logout(): Promise<ApiResult<unknown>>;
  }
  export interface SessionState<C> {
    /* ...เดิม... */ login: (
      credentials: C,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
  }
  export function createSessionStore<C>(deps: {
    api: SessionApi<C>;
    persistence?: SessionPersistence;
  }): UseBoundStore<StoreApi<SessionState<C>>>;
  export type PinCredentials = { staffId: string; pin: string; branchId?: string | undefined };
  export type OfficeCredentials = { email: string; password: string };
  ```
  Task 12 ใช้ `OfficeCredentials`

> **นี่คือการทำให้ความต่างมองเห็นได้ ไม่ใช่แค่ทำให้ compile ผ่าน** — ก่อนหน้านี้ store บังคับว่าทุกแอปล็อกอินด้วย `(staffId, pin)` ซึ่งเป็นสมมติฐานของหน้าร้านที่ฝังอยู่ในของกลาง · หลัง task นี้ ของกลางไม่รู้ว่ากุญแจหน้าตายังไง แต่ละแอปบอกเอง

- [ ] **Step 1: เขียนเทสต์ที่ยังไม่ผ่าน**

เพิ่มใน `packages/web-kit/src/session-store.test.ts`:

```ts
describe('credentials the store does not understand', () => {
  it('hands whatever the app passes straight to that app`s api', async () => {
    // The store used to insist on (staffId, pin) — a till assumption living in
    // shared code. It now carries the credential without opening it.
    const api = {
      me: vi.fn().mockResolvedValue({ ok: true, data: { user, permissions: [], branch } }),
      login: vi.fn().mockResolvedValue({ ok: true, data: { user } }),
      logout: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    };
    const store = createSessionStore<{ email: string; password: string }>({ api });

    await store.getState().login({ email: 'noi@example.com', password: 'a-long-password' });

    expect(api.login).toHaveBeenCalledWith({
      email: 'noi@example.com',
      password: 'a-long-password',
    });
  });

  it('reports the API`s message when the login is refused', async () => {
    const api = {
      me: vi.fn().mockResolvedValue({ ok: false, error: 'no', offline: false }),
      login: vi.fn().mockResolvedValue({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }),
      logout: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    };
    const store = createSessionStore<{ email: string; password: string }>({ api });

    const result = await store.getState().login({ email: 'a@b.co', password: 'x'.repeat(12) });

    expect(result).toEqual({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    // A refused login must not leave the store looking authenticated.
    expect(store.getState().status).not.toBe('authenticated');
  });
});
```

- [ ] **Step 2: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/web-kit test
```

คาดหวัง: FAIL — `api.login` ถูกเรียกด้วย `('noi@example.com', 'a-long-password', undefined)` ไม่ใช่ object เดียว

- [ ] **Step 3: แก้ `session-store.ts`**

`packages/web-kit/src/session-store.ts` — แก้สามจุด:

```ts
/**
 * The credential each app logs in with.
 *
 * Named here rather than inlined so both apps and the store agree on one
 * shape, and so reading this file tells you there are exactly two doors.
 */
export type PinCredentials = {
  staffId: string;
  pin: string;
  branchId?: string | undefined;
};
export type OfficeCredentials = { email: string; password: string };

export interface SessionApi<C> {
  me(): Promise<ApiResult<MeResponse>>;
  /**
   * The store never looks inside the credential. It came from the app and it
   * goes to that app's api client — which is why a PIN and an email+password
   * can share this file without a branch anywhere in it.
   */
  login(credentials: C): Promise<ApiResult<{ user: SessionUser }>>;
  logout(): Promise<ApiResult<unknown>>;
}
```

```ts
export interface SessionState<C> {
  status: SessionStatus;
  user: SessionUser | null;
  branch: MeResponse['branch'] | null;
  offline: boolean;

  refresh: () => Promise<void>;
  login: (credentials: C) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<{ ok: true } | { ok: false; error: string }>;
  can: (permission: Permission) => boolean;
}

export function createSessionStore<C>(deps: {
  api: SessionApi<C>;
  persistence?: SessionPersistence;
}): UseBoundStore<StoreApi<SessionState<C>>> {
  const { api, persistence } = deps;

  return create<SessionState<C>>((set, get) => ({
```

และใน body:

```ts
    login: async (credentials) => {
      const result = await api.login(credentials);
      if (!result.ok) return { ok: false, error: result.error };
      await get().refresh();
      return { ok: true };
    },
```

แก้คอมเมนต์หัวไฟล์ — บล็อกเดิมพูดถึงความต่างเรื่อง persistence อย่างเดียว เพิ่มย่อหน้า:

```
 * They now differ in a second injected way: the credential. The till hands in
 * a staff id and a PIN, the office an email and a password, and this file has
 * never heard of either — `C` is whatever the app says it is.
```

- [ ] **Step 4: แก้ผู้เรียกทั้งสองฝั่ง**

`apps/web/src/session.ts` — ระบุชนิดตอนสร้าง:

```ts
export const useSession = createSessionStore<PinCredentials>({ api, persistence });
```

พร้อม import `type PinCredentials` จาก `@pos/web-kit`

> **`api.login` ของหน้าร้านยังรับสามอาร์กิวเมนต์อยู่** — ต้องแก้ `apps/web/src/api-client.ts` ให้เป็น
> `login: (c: PinCredentials) => post('/auth/login', { staffId: c.staffId, pin: c.pin, ...(c.branchId ? { branchId: c.branchId } : {}) })`
> ตรวจว่ามีใครเรียก `api.login` ตรง ๆ อีกไหมด้วย `grep -rn "api.login" apps/web/src`

`apps/web/src/pages/LoginPage.tsx` บรรทัด 92:

```ts
const result = await login({ staffId, pin: candidate, branchId });
```

`apps/office/src/session.ts` — ยังไม่ต้องเปลี่ยน credential ใน task นี้ (Task 12 ทำ) แต่ต้องระบุชนิดให้ compile ผ่าน:

```ts
export const useSession = createSessionStore<PinCredentials>({ api: officeApi });
```

และ `apps/office/src/pages/LoginPage.tsx` บรรทัด 45:

```ts
const result = await login({ staffId, pin });
```

พร้อมแก้ `officeApi.login` ใน `apps/office/src/api-office.ts` ให้รับ object แบบเดียวกัน

- [ ] **Step 5: รันเทสต์ทั้ง workspace**

```bash
pnpm test
```

คาดหวัง: 1,211 ผ่าน · `pnpm typecheck` ต้องผ่านด้วย — จุดนี้คือที่ TypeScript จะจับผู้เรียกที่ตกหล่น

- [ ] **Step 6: commit**

```bash
git add packages/web-kit apps/web/src apps/office/src
git commit -m "refactor: let the session store carry a credential it does not understand

It used to insist on (staffId, pin) — a till assumption living in shared code.
The office is about to hand it an email and a password instead."
```

---

## Task 12: หน้าล็อกอินหลังร้านของจริง

**Files:**

- Delete: `apps/office/src/pages/LoginPage.tsx`
- Create: `apps/office/src/pages/OfficeLoginPage.tsx`
- Create: `apps/office/src/pages/OfficeLoginPage.test.tsx`
- Modify: `apps/office/src/api-office.ts`
- Modify: `apps/office/src/session.ts`
- Modify: `apps/office/src/App.tsx`

**Interfaces:**

- Consumes: `POST /auth/office/login` จาก Task 7 · `OfficeCredentials` จาก Task 11
- Produces: หน้าล็อกอินที่ `/login` ของ `apps/office`

> **นี่คือหนี้ที่แผนที่ 1 จดไว้** · คอมเมนต์หัวไฟล์ของ `LoginPage.tsx` เดิมเขียนไว้เองว่าตัวแทนของมันต้องทดสอบสี่อย่าง: รหัสผิดล้างช่อง · บัญชีถูกแช่แข็งต้องบอก · สำเร็จแล้วไปหน้าเมนู · และ**ห้ามมีรายชื่อพนักงาน** · เทสต์ในขั้นที่ 2 คือสี่ข้อนั้นตรง ๆ

- [ ] **Step 1: ตัด endpoint ที่หลังร้านไม่มีสิทธิ์เรียกอีกแล้วออกจาก api client**

`apps/office/src/api-office.ts` — ลบ `loginBranches` และ `staffList` ทิ้งทั้งสองตัว แล้วแทน `login`:

```ts
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
```

แก้คอมเมนต์หัวไฟล์ที่บอกว่า "The five auth methods are duplicated... plan 2 replaces this file's copy" — ตอนนี้เกิดขึ้นแล้ว เขียนใหม่:

```
 * The auth methods are no longer a copy of the till's. The office logs in with
 * an email and a password against its own endpoint, and does not have the two
 * pre-session lookups at all — the API refuses them on this host anyway.
```

`apps/office/src/session.ts` — เปลี่ยนชนิด:

```ts
export const useSession = createSessionStore<OfficeCredentials>({ api: officeApi });
```

- [ ] **Step 2: เขียนเทสต์ที่ยังไม่ผ่าน**

สร้าง `apps/office/src/pages/OfficeLoginPage.test.tsx`:

```tsx
/**
 * The back office door.
 *
 * The fourth test is the one that matters most and it is a negative: this page
 * must not list who works here. The till's login screen does, deliberately, on
 * a device already inside the shop. This one is on the open internet, where a
 * staff list is a directory of names, roles and the id needed to start
 * guessing a PIN.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OfficeLoginPage } from './OfficeLoginPage.js';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const login = vi.fn();
vi.mock('../session.js', () => ({
  useSession: (selector: (state: { login: unknown }) => unknown) => selector({ login }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <OfficeLoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockReset();
  login.mockReset();
  login.mockResolvedValue({ ok: true });
});

describe('the back office login screen', () => {
  it('asks for an email and a password, and nothing else', async () => {
    renderPage();
    expect(screen.getByLabelText('อีเมล')).toBeTruthy();
    expect(screen.getByLabelText('รหัสผ่าน')).toBeTruthy();
  });

  it('NEVER lists the staff', async () => {
    renderPage();
    // No dropdown, no roster, no request that could produce one. The till's
    // screen has a picker; this one must not, on the internet.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('sends what was typed and lands on the menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'a-password-long-enough');
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        email: 'noi@example.com',
        password: 'a-password-long-enough',
      });
    });
    expect(navigate).toHaveBeenCalledWith('/office/menu', { replace: true });
  });

  it('clears the password but keeps the email when it is refused', async () => {
    // Retyping the address after every slip is how a real person ends up
    // pasting their password into the email box.
    login.mockResolvedValue({ ok: false, error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));

    await screen.findByText('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    expect((screen.getByLabelText('รหัสผ่าน') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('อีเมล') as HTMLInputElement).value).toBe('noi@example.com');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the API`s own words when the account is frozen', async () => {
    // The lockout message carries how many minutes are left, and only the
    // server knows that. Rewriting it here would drop the number.
    login.mockResolvedValue({
      ok: false,
      error: 'ใส่รหัสผ่านผิดหลายครั้ง บัญชีถูกล็อก กรุณารออีก 15 นาที',
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'a-password-long-enough');
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));

    await screen.findByText(/บัญชีถูกล็อก/);
  });

  it('keeps the password out of the DOM as text', async () => {
    const user = userEvent.setup();
    renderPage();
    const field = screen.getByLabelText('รหัสผ่าน') as HTMLInputElement;
    await user.type(field, 'a-password-long-enough');
    expect(field.type).toBe('password');
  });

  it('will not submit with an empty field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
    expect(login).not.toHaveBeenCalled();
  });

  it('does not fire twice when the button is double-clicked', async () => {
    // bcrypt cost 12 takes about a second. Without a busy flag an impatient
    // click is two logins and two session rows.
    let release: (value: { ok: true }) => void = () => {};
    login.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('อีเมล'), 'noi@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'a-password-long-enough');
    const button = screen.getByRole('button', { name: /เข้าสู่ระบบ|กำลัง/ });
    await user.click(button);
    await user.click(button);

    expect(login).toHaveBeenCalledTimes(1);
    release({ ok: true });
  });
});
```

- [ ] **Step 3: รันแล้วดูให้แน่ใจว่าแดง**

```bash
pnpm --filter @pos/office test -- src/pages/OfficeLoginPage.test.tsx
```

คาดหวัง: FAIL — `Cannot find module './OfficeLoginPage.js'`

- [ ] **Step 4: เขียนหน้าจอ**

สร้าง `apps/office/src/pages/OfficeLoginPage.tsx`:

```tsx
/**
 * The back office door.
 *
 * An email typed from memory, not a name picked off a list. That difference is
 * the whole point of the screen: the till's login shows the roster because it
 * runs on a tablet already inside the shop, and this one is on the open
 * internet, where the same list would hand a stranger every name, every role,
 * and the id they need before they start guessing PINs.
 *
 * No keypad either. The till has one because a thumb on a tablet needs big
 * targets; the back office is opened on a machine with a keyboard.
 *
 * The error text comes from the API verbatim. It is the only side that knows
 * how many minutes are left on a lockout, and paraphrasing it here would throw
 * that number away.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { path } from '@pos/web-kit';
import { useSession } from '../session.js';

export function OfficeLoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const login = useSession((state) => state.login);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    // bcrypt at cost 12 takes about a second, which is long enough for an
    // impatient second click to become a second session row.
    if (busy) return;

    setBusy(true);
    setError(null);
    const result = await login({ email, password });
    setBusy(false);

    if (result.ok) {
      navigate(path.menu, { replace: true });
      return;
    }

    setError(result.error);
    // The password goes, the email stays. Retyping the address after every
    // slip is how someone ends up pasting their password into the email box.
    setPassword('');
  };

  const ready = email.trim() !== '' && password !== '';

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-80 space-y-4">
      <h1 className="text-xl font-medium">หลังร้าน</h1>

      <label className="block">
        <span className="text-sm text-slate-600">อีเมล</span>
        <input
          aria-label="อีเมล"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-11 w-full rounded-xl border border-slate-300 px-2"
        />
      </label>

      <label className="block">
        <span className="text-sm text-slate-600">รหัสผ่าน</span>
        <input
          aria-label="รหัสผ่าน"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="h-11 w-full rounded-xl border border-slate-300 px-2"
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!ready || busy}
        className="h-11 w-full rounded-xl bg-slate-900 text-white disabled:bg-slate-300"
      >
        {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </button>
    </form>
  );
}
```

- [ ] **Step 5: เปลี่ยน route แล้วลบหน้าเก่า**

`apps/office/src/App.tsx` — เปลี่ยน import และ element:

```tsx
import { OfficeLoginPage } from './pages/OfficeLoginPage.js';
```

```tsx
<Route path="/login" element={<OfficeLoginPage />} />
```

> เก็บ logic ที่เด้งคนที่ล็อกอินแล้วออกจาก `/login` ไว้เหมือนเดิม — มันมาจากแผนที่ 1 และยังถูกอยู่

```bash
git rm apps/office/src/pages/LoginPage.tsx
```

> ถ้าบ่นว่า "staged content different" ให้ใช้ `git rm -f` (เจอมาแล้วในแผนที่ 1)

- [ ] **Step 6: รันเทสต์ office**

```bash
pnpm --filter @pos/office test
```

คาดหวัง: PASS · 112 + 8 = 120 ตัว

- [ ] **Step 7: ล็อกอินจริงด้วยมือ**

```bash
pnpm db:seed:demo
```

เปิดสามเทอร์มินัล (`pnpm dev:api` · `pnpm dev:web` · `pnpm dev:office`) แล้วที่ `http://localhost:5174/login` ล็อกอินด้วย `owner@demo.local` / `demo-password-1234`

ตรวจให้ครบห้าข้อ:

1. เข้าได้ ไปโผล่ที่หน้าเมนู
2. DevTools → Application → Cookies เห็น **`office_session`** ไม่ใช่ `pos_session`
3. เปิด `http://localhost:5173` อีกแท็บ — เซสชันหน้าร้าน **ไม่ถูกเตะออก** (นี่คือเหตุผลที่แยกชื่อคุกกี้)
4. ใส่รหัสผิด — ช่องรหัสผ่านว่าง ช่องอีเมลยังอยู่ ข้อความผิดพลาดเป็นภาษาไทย
5. กด "ออกจากระบบ" แล้วกด back ในเบราว์เซอร์ — ต้องเด้งกลับหน้าล็อกอิน ไม่ใช่เห็นข้อมูลค้าง

บันทึกสิ่งที่เห็นใต้ task นี้

- [ ] **Step 8: เทสต์ทั้ง workspace แล้ว commit**

```bash
pnpm test
```

คาดหวัง: 1,219 ผ่าน

```bash
git add apps/office
git commit -m "feat: give the back office a real login

Email and password, with the tests plan 1 wrote down and deferred — including
the one that matters most, which is that this page never lists the staff."
```

---

## Task 13: เอกสาร

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-06-back-office-split-design.md` (§5 — บันทึกสิ่งที่ต่างจากที่เขียนไว้)
- Modify: `docs/superpowers/plans/2026-08-17-back-office-split-part2-auth.md` (ไฟล์นี้เอง)

- [ ] **Step 1: วัดตัวเลขจริงก่อนเขียน**

```bash
pnpm test 2>&1 | grep -E "Tests +[0-9]+ passed"
```

จดตัวเลขของแต่ละแพ็กเกจ **ห้ามลอกตัวเลขคาดหวังจากแผนนี้** — ทุก task ในแผนที่ 1 ที่ทำแบบนั้นผิดหมด

- [ ] **Step 2: แก้ README**

สิ่งที่ต้องเปลี่ยน:

| ส่วน                 | เปลี่ยนเป็น                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| ตารางการล็อกอิน      | สองประตู: หน้าร้าน PIN + รายชื่อ · หลังร้าน อีเมล+รหัสผ่าน ไม่มีรายชื่อ        |
| ข้อจำกัดที่ยอมรับไว้ | **ลบ** ประโยค "JWT ที่ถูกก๊อปไว้ก่อนหน้ายังใช้ได้จนหมดอายุ" — ไม่จริงอีกแล้ว   |
| ตาราง env            | `WEB_ORIGIN` รับหลายค่า · `TILL_HOSTS` ใหม่ · `OWNER_EMAIL` · `OWNER_PASSWORD` |
| ตาราง endpoint       | `/auth/office/login` · `/auth/sessions/revoke-all` · `/staff/:id/password`     |
| ตารางเทสต์           | ตัวเลขจากขั้นที่ 1                                                             |

เพิ่มหัวข้อใหม่ต่อจากหัวข้อ precache ของแผนที่ 1:

```markdown
### ทำไมทุก request ต้องแตะฐานข้อมูลหนึ่งครั้ง

JWT พก `jti` ชี้ไปที่แถวใน `sessions` และ guard ตรวจว่าแถวนั้นยังไม่ถูกเพิกถอน
ก่อนหน้านี้ logout แค่ลบคุกกี้ ซึ่งแปลว่า token ที่ถูกก๊อปไว้ก่อนกดออกจากระบบ
ยังใช้ได้ต่ออีกสิบสองชั่วโมง · ในวงแลนของร้านนั่นเป็นช่องเล็ก ๆ บนอินเทอร์เน็ตมันคือ**ช่อง**

ราคาคือ query ที่มี index หนึ่งครั้งต่อ request ซึ่งร้านสิบสองโต๊ะไม่รู้สึก
ได้กลับมาสี่อย่าง: logout ที่ฆ่าจริง · ปุ่มออกจากระบบทุกเครื่อง ·
ตัดสิทธิ์คนที่ลาออกวันนี้ได้วันนี้ · และเจ้าของเห็นว่ามีกี่เครื่องที่ยังค้างอยู่

**token ที่ออกก่อนแผนที่ 2 ไม่มี `jti` และถูกปฏิเสธทั้งหมด** — ทุกคนล็อกอินใหม่หนึ่งครั้งตอน deploy
เป็นผลข้างเคียงที่ตั้งใจ ทางเลือกอีกทางคือยอมรับ token ไม่มี `jti` ไปก่อน
ซึ่งแปลว่าเปิดช่องทิ้งไว้โดยไม่มีใครบอกได้ว่าปิดตอนไหน
```

- [ ] **Step 3: แก้สเปก §5**

เพิ่มบล็อกท้าย §5 บันทึกสามเรื่องที่ต่างจากที่เขียนไว้ (คัดจากหัวข้อ "สามเรื่องที่แผนนี้ตัดสินเพิ่มจากสเปก" ด้านบนของแผนนี้) — CORS ที่พังอยู่ · คุกกี้สองชื่อ · `ipHash` เป็น HMAC

- [ ] **Step 4: บันทึกทุกข้อผิดพลาดของแผนนี้ที่เจอตอนลงมือ**

ไล่ตั้งแต่ Task 1 ถึง 12 · ทุกที่ที่โค้ดจริงไม่ตรงกับที่แผนเขียน ให้แก้ในไฟล์แผนนี้ให้ตรงความจริง

แผนที่ 1 มีข้อผิดพลาด 13 จุดที่โผล่ตอนลงมือเท่านั้น · แผนนี้เขียนโดยไม่ได้รันอะไรเหมือนกัน จึงต้องสมมติว่ามีพอ ๆ กัน

- [ ] **Step 5: ตรวจทั้งหมดแล้ว commit**

```bash
pnpm test && pnpm typecheck && npx eslint . && npx prettier --check .
```

```bash
git add README.md docs
git commit -m "docs: record the two doors and the session table"
```

---

## Definition of Done

- [ ] `pnpm test` เขียวทั้ง 6 แพ็กเกจ
- [ ] `pnpm typecheck` · `npx eslint .` · `npx prettier --check .` สะอาด
- [ ] ล็อกอินหลังร้านด้วยอีเมล+รหัสผ่านได้จริงบนเบราว์เซอร์ และเซสชันหน้าร้านไม่ถูกเตะ
- [ ] `curl -H "Host: office.example.com" http://localhost:3001/api/auth/staff` ได้ 404 เมื่อตั้ง `TILL_HOSTS`
- [ ] กด logout แล้วเอาคุกกี้เดิมยิงซ้ำ ได้ 401
- [ ] `grep -rn "ยังใช้ได้จนหมดอายุ" README.md` ไม่เจออะไร
- [ ] ไม่มีรหัสผ่านจริงอยู่ในไฟล์ใดที่ถูก commit — ตรวจด้วย `git log -p | grep -i "OWNER_PASSWORD="`

## สิ่งที่แผนนี้จงใจไม่ทำ

| ไม่ทำ                               | ทำไม                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------- |
| 2FA / TOTP                          | คอลัมน์ `totpSecret` จองไว้แล้ว เปิดใช้ทีหลังได้โดยไม่ต้อง migrate      |
| ลืมรหัสผ่าน / ส่งอีเมลรีเซ็ต        | ต้องมี mail server ซึ่งเป็นงาน deploy · เจ้าของตั้งให้คนอื่นได้อยู่แล้ว |
| หน้าจอ "มีใครล็อกอินอยู่กี่เครื่อง" | ข้อมูลอยู่ในตารางแล้ว หน้าจอเป็นงานแยกที่ไม่มีอะไรมาบล็อก               |
| cron ล้างเซสชันเก่า                 | สคริปต์มีแล้ว ตารางเวลาเป็นงานแผนที่ 3                                  |
| bind API ที่ localhost + Caddy      | แผนที่ 3 — และเป็นสิ่งที่ทำให้การตรวจ `Host` เป็นกำแพงจริง              |
| เปลี่ยน URL `/office/*` → `/*`      | เหตุผลเดิมจากแผนที่ 1 ยังใช้ได้ · ทำทีหลังได้โดยไม่มีความเสี่ยง         |
