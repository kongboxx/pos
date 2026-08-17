# แยกหลังร้านออกจากหน้าร้าน — แผนที่ 3: ขึ้นเซิร์ฟเวอร์จริง

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เอาทั้งระบบขึ้น VPS จริง — `shop.<domain>` กับ `office.<domain>` มี https ของตัวเอง · API ถูกผูกไว้กับ `127.0.0.1` จนกำแพง `Host` ของแผนที่ 2 กลายเป็นกำแพงจริง · มี backup ที่**เคยกู้คืนสำเร็จแล้ว** · และมี CI ที่รันเทสต์ทุก push

**Architecture:** Caddy ตัวเดียวถือใบรับรองของสอง subdomain แล้วส่ง `/api/*` ของทั้งคู่ไป Node ตัวเดียวที่ `127.0.0.1:3001` (สเปก §4.2 D5) — ได้ same-origin, คุกกี้แยกกันตามโดเมนเอง, และ `sameSite: lax` เดิมยังใช้ได้ · ไฟล์ static ของสองเว็บถูก build แล้ว rsync ไปนอก git tree เพื่อให้ Caddy ไม่มีทางเสิร์ฟ `.git` หรือ `.env` · PostgreSQL 16 ลงบนเครื่องตรง ๆ ไม่ผ่าน Docker · backup, การทดสอบกู้คืน และการล้าง `sessions` เป็น cron สามบรรทัด

**Tech Stack:** Ubuntu 24.04 · Caddy 2 · systemd · PostgreSQL 16 (apt) · Node 22 + corepack/pnpm 11.18.0 · rclone → Backblaze B2 · GitHub Actions · Fastify 5 · Vite 6

**Spec:** [`docs/superpowers/specs/2026-08-06-back-office-split-design.md`](../specs/2026-08-06-back-office-split-design.md) §4.2 (การวางเครื่อง) · §7 (ปฏิบัติการ) · §8.1 (ความเสี่ยงที่รับไว้แล้ว)

**แผนก่อนหน้า:**

- [`2026-08-06-back-office-split-part1-apps.md`](2026-08-06-back-office-split-part1-apps.md) — เสร็จ merge เข้า `main` ที่ `18c1fee`
- [`2026-08-17-back-office-split-part2-auth.md`](2026-08-17-back-office-split-part2-auth.md) — เสร็จ merge เข้า `main` ที่ `b621194`

---

## Global Constraints

- **เทสต์ต้องเขียวครบทุกขั้น** — ทุก task ที่แตะโค้ดจบด้วย `pnpm test` ที่ผ่านทั้ง workspace · task ที่แตะแต่เครื่องเซิร์ฟเวอร์จบด้วยคำสั่งตรวจที่เขียนไว้ในขั้นสุดท้ายของ task นั้น
- **ความลับทุกชนิดห้ามเข้า git และห้ามเข้าบทสนทนา** — `JWT_SECRET` · `PRINT_AGENT_TOKEN` · รหัสผ่านฐานข้อมูล · รหัสผ่านหลังร้านของเจ้าของ · กุญแจ rclone · ทั้งหมดอยู่ใต้ `/etc/pos/` บนเครื่องเท่านั้น ในโปรเจกต์เก็บได้แค่ไฟล์ `.example` ที่ไม่มีค่าจริง
- **`deploy/` เก็บ "รูปร่าง" ไม่เก็บ "ค่า"** — ไฟล์คอนฟิกทุกไฟล์ commit ลง `deploy/` ได้ เพราะค่าจริงทุกตัวถูกดึงมาจาก environment file บนเครื่อง · ข้อยกเว้นเดียวคือชื่อโดเมน ซึ่งไม่ใช่ความลับแต่ยังไม่ถูกเลือก
- **`<domain>` · `<vps-ip>` · `<admin-email>` เป็นตัวแทน** — แทนด้วยค่าจริงตอนลงมือ (สเปก §4.2 บอกไว้แล้วว่าค่านี้ไม่กระทบดีไซน์)
- **ห้ามรัน `prisma migrate reset` · `prisma db push` · `dropdb` กับฐานข้อมูลจริง** — บนเครื่องจริงมีคำสั่งเดียวคือ `prisma migrate deploy` · script กู้คืนสร้างฐานข้อมูลชื่ออื่นเสมอ ไม่เคยแตะของจริง
- **ห้าม log รหัสผ่าน PIN token หรือ IP ดิบ** — กฎเดิมจากแผนที่ 2 ยังอยู่ · แผนนี้เพิ่มโอกาสผิดตรงที่ `request.ip` เพิ่งเริ่มมีค่าจริง (Task 1) จึงต้องระวังเป็นพิเศษ
- **ทุกอย่างที่รันเองต้องพังเสียงดัง** — script ทุกตัวขึ้นต้นด้วย `set -euo pipefail` และคืน exit code ที่ไม่ใช่ 0 เมื่อล้มเหลว · backup ที่ล้มเงียบคือ backup ที่ไม่มี
- Node ≥ 20.11 · pnpm 11.18.0 · TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (ทุก import ภายในลงท้าย `.js`)

**สถานะฐาน วัดไว้ 2026-08-17 ที่ `b621194` (ต้องไม่ต่ำกว่านี้ตอนจบทุก task):**

| ชุด                | เทสต์          |
| ------------------ | -------------- |
| `@pos/shared`      | 413 ผ่าน       |
| `@pos/api`         | 407 ผ่าน       |
| `@pos/web`         | 249 ผ่าน       |
| `@pos/office`      | 120 ผ่าน       |
| `@pos/print-agent` | 15 ผ่าน        |
| `@pos/web-kit`     | 14 ผ่าน        |
| **รวม**            | **1,218 ผ่าน** |

`pnpm typecheck` · `npx eslint .` · `npx prettier --check .` ต้องผ่านสะอาดตอนจบทุก task

> **ตัวเลข "คาดหวัง: N ผ่าน" เป็นการนับด้วยมือจากเทสต์ที่แผนนี้เขียนไว้ ไม่ใช่ค่าที่วัดมา** — แผนที่ 1 และ 2 ทายพลาดทั้งคู่ · ถ้าตัวเลขจริง**สูงกว่าหรือเท่ากับ**ฐานและไม่มีอะไรแดง ให้เดินต่อแล้วแก้ตัวเลขในแผน · ถ้า**ต่ำกว่า**ฐาน แปลว่ามีเทสต์หายไป ให้หยุด

> **`@pos/web` มีเทสต์ 2 ตัวที่ข้ามตัวเองถ้ายังไม่ได้ build** — `bundle-boundary.test.ts` อ่าน `dist/` จริง และเรียก `describe.skip` เมื่อไม่มี · Task 2 เพิ่มเข้าไปในไฟล์นี้อีก 2 ตัว · เวลานับเทสต์ของ `@pos/web` ให้รัน `pnpm build` ก่อนเสมอ ไม่งั้นตัวเลขจะต่ำลงโดยไม่มีอะไรพัง

---

## ของที่ต้องมีก่อนเริ่ม (ฝั่งคน ไม่ใช่ฝั่งโค้ด)

| ต้องมี                                                | ใช้ที่           | หมายเหตุ                                                       |
| ----------------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| โดเมนที่จดแล้ว                                        | Task 7           | ต้องแก้ DNS ได้เอง                                             |
| VPS ไทย/สิงคโปร์ · 2 vCPU · RAM 2–4 GB · Ubuntu 24.04 | Task 4 เป็นต้นไป | สเปก D3                                                        |
| อีเมลสำหรับ Let's Encrypt                             | Task 7           | ใช้แจ้งเตือนตอนใบรับรองมีปัญหา                                 |
| บัญชี Backblaze B2 (หรือ S3) + application key        | Task 9           | สเปก §7.1                                                      |
| รหัสผ่านหลังร้านของเจ้าของ ≥ 12 ตัวอักษร              | Task 8           | เจ้าของพิมพ์เอง **ห้ามผ่านมือคนเขียนโค้ดหรือผ่านบทสนทนานี้**   |
| เราเตอร์ 4G สำรอง                                     | หลัง Task 12     | สเปก §8.1 — ไม่ใช่งานเขียนโค้ด แต่เป็นเงื่อนไขก่อนเปิดร้านจริง |

**Task 1–3 ไม่ต้องรอของพวกนี้เลย** ทำบนเครื่องตัวเองได้ทันที และควรทำก่อน เพราะสองในสามเป็นการแก้บั๊กที่จะโผล่ตอนมี reverse proxy พอดี

---

## สามเรื่องที่แผนนี้ตัดสินเพิ่มจากสเปก

### ก. `request.ip` จะกลายเป็น `127.0.0.1` ทุกคำขอ ในวินาทีที่ Caddy ขึ้น

`apps/api/src/modules/auth/auth.routes.ts:147` และ `:202` ใช้ `request.ip` เป็นกุญแจของ `RateLimiter`
และ `:186`/`:264` ส่งค่าเดียวกันเข้าไปทำ `ipHash` ของแถว `Session`

Fastify ไม่เชื่อ `X-Forwarded-For` เว้นแต่จะสั่ง และตอนนี้ไม่ได้สั่ง แปลว่าเมื่อ Caddy มาอยู่ข้างหน้า
`request.ip` จะเป็นที่อยู่ของ Caddy เองทุกครั้ง ผลคือ:

- **ตัวจำกัดต่อ IP ตายทันที** — ทั้งอินเทอร์เน็ตใช้โควตาเดียวกัน บอตตัวเดียวกินครบ 10 ครั้ง/นาที
  แล้วเจ้าของร้านล็อกอินไม่ได้ · นี่แย่กว่าไม่มีตัวจำกัด เพราะมันกลายเป็นปุ่มปิดร้าน
- **`ipHash` กลายเป็นค่าคงที่** — คอลัมน์ที่มีไว้ตอบว่า "เครื่องเดิมไหม" ตอบว่า "Caddy" ทุกแถว

และการแก้แบบง่าย ๆ ก็ผิดอีกแบบ: `trustProxy: true` แปลว่าเชื่อทุก hop ซึ่งทำให้ `request.ip`
กลายเป็น**รายการซ้ายสุด**ของ `X-Forwarded-For` ซึ่งคนยิงเป็นคนเขียนเอง — สลับค่าหัวแถวไปเรื่อย ๆ
ก็ได้โควตาใหม่ทุกครั้ง Task 1 จึงแก้สองด้านพร้อมกัน: Fastify เชื่อ **1 hop** และ Caddy **เขียนทับ**
`X-Forwarded-For` แทนที่จะต่อท้าย

### ข. เว็บที่ build แล้วยังฝังที่อยู่ `http://localhost:3001/api` ติดไปด้วย

`apps/web/src/api-client.ts:54` และ `apps/office/src/api-office.ts:48` อ่าน `VITE_API_URL`
โดยมีค่าสำรองเป็น `http://localhost:3001/api` · ค่าสำรองนั้นถูกต้องสำหรับ clone ใหม่ที่ยังไม่มีไฟล์ `.env`
แต่ถ้าขึ้นเครื่องจริงโดยไม่ตั้งค่า เว็บจะยิงไปที่ localhost ของ**เครื่องผู้ใช้** และล้มเงียบ ๆ

Task 2 เพิ่ม `.env.production` ให้ทั้งสองแอป (ค่าเดียว: `VITE_API_URL="/api"`) และเพิ่มเทสต์ที่อ่าน
`dist/` จริงแล้วยืนยันว่าไม่มีคำว่า `localhost:3001` หลงเหลือ · **ทดลองแล้วว่าเทสต์นี้กัดจริง** —
build ด้วยค่าสำรอง แล้ว `assets/index-*.js` มีคำนั้น · build ด้วย `/api` แล้วไม่มี เพราะ esbuild
พับ `"/api" ?? "http://localhost:3001/api"` ทิ้งตอน minify

`.env.production` commit ลง git ได้และควร commit — ตัวแปรที่ขึ้นต้นด้วย `VITE_` ถูกฝังลงใน
JavaScript ที่ทุกคนดาวน์โหลดได้อยู่แล้ว มันจึงเป็นความลับไม่ได้โดยธรรมชาติ

### ค. PostgreSQL ลงตรง ๆ ไม่ผ่าน Docker ทั้งที่ตอน dev ใช้ Docker

เหตุผลสามข้อ เรียงตามน้ำหนัก:

1. **Docker เปิดพอร์ตทะลุ ufw** — `ports: '5432:5432'` ใน `docker-compose.yml` เขียนกฎ iptables
   ที่อยู่**ก่อน**กฎของ ufw คนที่ตั้ง `ufw deny 5432` แล้วนอนหลับสบายจะพบว่าฐานข้อมูลเปิดอยู่ทั้งคืน ·
   PostgreSQL ที่ลงจาก apt ฟังที่ `127.0.0.1` เป็นค่าตั้งต้น
2. **RAM 2 GB** — Docker daemon กินไปฟรี ๆ ~100 MB บนเครื่องที่ต้อง build vite สองแอป
3. **`pg_dump` อยู่บนเครื่องเลย** — script backup กับ script กู้คืนไม่ต้องมี `docker exec` คั่น
   ซึ่งเป็นชั้นที่จะพังเงียบเมื่อชื่อ container เปลี่ยน

Ubuntu 24.04 มี PostgreSQL 16 ใน repo ของตัวเอง เท่ากับที่ `docker-compose.yml` ใช้ตอน dev
· `docker-compose.yml` เดิมไม่ถูกแตะ มันยังเป็นวิธีรัน dev ที่ถูกต้อง

---

## ลำดับ

```
บนเครื่องตัวเอง (ไม่ต้องรอ VPS)
  1  request.ip ที่จริงหลัง reverse proxy
  2  เว็บที่ build แล้วยิงไปที่ /api ของตัวเอง
  3  CI

บนเครื่องจริง (แต่ละขั้นต้องผ่านก่อนไปต่อ)
  4  เตรียมเครื่อง
  5  PostgreSQL
  6  API เป็น systemd service ผูกกับ 127.0.0.1
  7  Caddy — https, สองเว็บ, /api ใต้ทั้งคู่
  8  deploy.sh + ขึ้นของจริงครั้งแรก

หลังร้านเปิดได้แล้ว
  9  backup + กู้คืนที่ทดสอบแล้ว
 10  cron
 11  Raspberry Pi และจอครัวออกอินเทอร์เน็ต
 12  เอกสาร
```

**6 ต้องมาก่อน 7** เพราะ Task 6 คือขั้นที่ผูก API ไว้กับ `127.0.0.1` และนั่นคือสิ่งที่ทำให้กำแพง `Host`
ของแผนที่ 2 กลายเป็นกำแพงจริง — ถ้าตั้ง Caddy ก่อนแล้วลืมย้อนกลับมาผูก API ระบบจะดูเหมือนทำงานถูกต้องทุกอย่าง
โดยที่ `:3001` ยังเปิดรับทั้งอินเทอร์เน็ตอยู่ข้าง ๆ

**9 อยู่หลัง 8 โดยตั้งใจ** — backup ที่ทำก่อนมีข้อมูลจริงคือ backup ของฐานข้อมูลเปล่า ซึ่งการกู้คืนสำเร็จ
ไม่ได้พิสูจน์อะไรเลย

---

## Task 1: `request.ip` ที่จริงหลัง reverse proxy

**Files:**

- Modify: `apps/api/src/env.ts` (เพิ่ม `TRUST_PROXY` ต่อจาก `TILL_HOSTS`)
- Modify: `apps/api/src/app.ts:47-61` (ตัวเลือกของ `Fastify({...})`)
- Modify: `apps/api/.env.example`
- Test: `apps/api/src/env.test.ts` (เพิ่ม 3 ตัว)
- Test: `apps/api/src/modules/auth/trust-proxy.test.ts` (สร้างใหม่ 3 ตัว)

**Interfaces:**

- Produces: `Env.TRUST_PROXY: boolean` — Task 6 เขียน `TRUST_PROXY=true` ลง `/etc/pos/api.env`
  และ Task 7 ตั้ง Caddy ให้เขียนทับ `X-Forwarded-For` ให้ตรงกับสมมติฐาน "1 hop" ของ task นี้

- [x] **Step 1: เขียนเทสต์ของ `loadEnv` ที่ยังไม่ผ่าน**

ต่อท้าย `describe('loadEnv', ...)` ใน `apps/api/src/env.test.ts` ก่อนวงเล็บปิด:

```ts
it('does not trust proxy headers unless told to', () => {
  expect(loadEnv(VALID).TRUST_PROXY).toBe(false);
});

it('trusts one hop when TRUST_PROXY is the string "true"', () => {
  expect(loadEnv({ ...VALID, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
});

it('rejects anything other than true or false, instead of quietly meaning true', () => {
  // z.coerce.boolean() would read "false" as true, because every non-empty
  // string is truthy. Getting this backwards turns the per-IP login limiter
  // into a single shared bucket for the whole internet, and nothing says so.
  expect(() => loadEnv({ ...VALID, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
});
```

- [x] **Step 2: รันเทสต์ให้เห็นว่ามันแดง**

```bash
pnpm --filter @pos/api test -- src/env.test.ts
```

Expected: FAIL 3 ตัว — สองตัวแรกได้ `undefined` ไม่ใช่ `false`/`true` และตัวที่สามไม่ throw

- [x] **Step 3: เพิ่ม `TRUST_PROXY` ลงใน schema**

ใน `apps/api/src/env.ts` ต่อท้าย block ของ `TILL_HOSTS` (ก่อน `});` ที่ปิด `envSchema`):

```ts
  /**
   * Whether an X-Forwarded-For header may be believed. ONE hop, never all.
   *
   * `request.ip` keys the per-IP login limiter and feeds the ipHash on every
   * Session row. Behind a reverse proxy and without this, every request in the
   * world arrives from 127.0.0.1: the limiter becomes one shared bucket that a
   * single bot empties, locking the owner out of their own shop, and the ipHash
   * column answers "which machine was this" with "the proxy" forever.
   *
   * Trusting ALL hops would be the other failure. proxy-addr would then take
   * the LEFTMOST entry of X-Forwarded-For, which is written by the caller — a
   * new value in that header buys a fresh quota. One hop takes the entry the
   * proxy itself appended, which is the real peer. Caddy is also configured to
   * overwrite rather than append (deploy/Caddyfile), so the two agree.
   *
   * An enum, not z.coerce.boolean(): coercion reads the string "false" as true,
   * because every non-empty string is truthy, and the mistake is silent.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'], {
      errorMap: () => ({ message: 'TRUST_PROXY must be exactly "true" or "false"' }),
    })
    .default('false')
    .transform((value) => value === 'true'),
```

- [x] **Step 4: รันเทสต์ให้ผ่าน**

```bash
pnpm --filter @pos/api test -- src/env.test.ts
```

Expected: PASS ทั้งไฟล์

- [x] **Step 5: เขียนเทสต์พฤติกรรมที่ยังไม่ผ่าน**

สร้าง `apps/api/src/modules/auth/trust-proxy.test.ts`:

```ts
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
```

- [x] **Step 6: รันเทสต์ให้เห็นว่ามันแดง**

```bash
pnpm --filter @pos/api test -- src/modules/auth/trust-proxy.test.ts
```

Expected: FAIL 1 ตัว จาก 3 (วัดแล้ว) — `gives two different clients two different budgets` ได้ 429
ตรงคำขอของ "ลูกค้าคนที่สอง" เพราะตอนนี้ทุกคำขอถูกนับเป็น `127.0.0.1`

อีกสองตัวผ่านอยู่แล้ว และผ่านคนละเหตุผลกัน · ตัวใน `with TRUST_PROXY off` ผ่านเพราะมันยืนยันว่า
พฤติกรรมเดิมไม่เปลี่ยน ซึ่งถูกต้อง · แต่ `ignores a forged first entry` ผ่านแบบว่างเปล่า — ตอนนี้ทุกคำขอ
เป็น IP เดียวกันอยู่แล้ว คำขอที่ 11 จึงโดน 429 ไม่ว่าหัวข้อความจะเขียนอะไร · มันไม่ได้แยกโค้ดวันนี้ออกจาก
โค้ดที่ถูก แต่มันแยก `trustProxy: 1` ออกจาก `trustProxy: true` ซึ่งเป็นทางแก้ที่ผิดอีกทางหนึ่ง
นั่นคือสิ่งที่เทสต์ตัวนี้มีไว้เฝ้า

- [x] **Step 7: ส่ง `trustProxy` เข้า Fastify**

ใน `apps/api/src/app.ts` ในตัวเลือกของ `Fastify({...})` เพิ่มต่อจาก `bodyLimit`:

```ts
    bodyLimit: 2 * 1024 * 1024,
    /**
     * ONE hop, or none. See TRUST_PROXY in env.ts for why `true` would be
     * worse than nothing: it makes request.ip the caller's own first
     * X-Forwarded-For entry, and a limiter keyed on a value the attacker
     * writes is not a limiter.
     */
    trustProxy: env.TRUST_PROXY ? 1 : false,
```

- [x] **Step 8: รันเทสต์ให้ผ่าน**

```bash
pnpm --filter @pos/api test -- src/modules/auth/trust-proxy.test.ts
```

Expected: PASS 3 ตัว

- [x] **Step 9: บันทึกลง `.env.example`**

ใน `apps/api/.env.example` ต่อท้ายบล็อกของ `TILL_HOSTS` (ก่อนเส้นคั่น `# ---`):

```bash
# Believe X-Forwarded-For? Only behind the reverse proxy, and only one hop.
# LEAVE FALSE IN DEV: nothing sits in front of this API, so an X-Forwarded-For
# arriving here was written by whoever sent the request. On the VPS this is
# "true" and Caddy overwrites the header — see deploy/Caddyfile.
TRUST_PROXY=false
```

- [x] **Step 10: กวาดทั้ง workspace**

```bash
pnpm test && pnpm typecheck && npx eslint . && npx prettier --check .
```

Expected: เขียวทั้งหมด · `@pos/api` **คาดหวัง: 413 ผ่าน** (407 + 6) · รวม **1,224**

- [x] **Step 11: commit**

```bash
git add apps/api/src/env.ts apps/api/src/env.test.ts apps/api/src/app.ts apps/api/src/modules/auth/trust-proxy.test.ts apps/api/.env.example
git commit -m "feat: let the API see the real client IP behind one proxy"
```

---

## Task 2: เว็บที่ build แล้วยิงไปที่ `/api` ของตัวเอง

**Files:**

- Create: `apps/web/.env.production`
- Create: `apps/office/.env.production`
- Modify: `.gitignore` (ยกเว้น `.env.production` ออกจากกฎ `.env.*`)
- Test: `apps/web/src/bundle-boundary.test.ts` (เพิ่ม suite ใหม่ 2 ตัว)

**Interfaces:**

- Produces: `dist/` ของทั้งสองแอปที่ยิง request แบบ relative ไปที่ `/api` — Task 7 พึ่งข้อนี้ตอนตั้ง
  Caddy ให้ `handle /api/*` ทำ reverse proxy ส่วนที่เหลือเสิร์ฟไฟล์ · และ `liveSocketUrl()`
  (`apps/web/src/api-client.ts:73`) แปลง `/api` เป็น `wss://shop.<domain>/api/live` ให้เองโดยไม่ต้องแก้อะไร

- [x] **Step 1: เปิดทางให้ `.env.production` เข้า git ได้**

ใน `.gitignore` แก้บล็อก `# env` ทั้งบล็อกเป็น:

```gitignore
# env
.env
.env.*
!.env.example
# ...except the production ones, which are checked in on purpose. Everything a
# VITE_ variable holds is compiled into JavaScript that every visitor
# downloads, so it cannot be a secret even if someone tries. The API's real
# secrets live in /etc/pos/api.env on the server and are never in this repo.
!.env.production
```

- [x] **Step 2: เขียนไฟล์ทั้งสอง**

`apps/web/.env.production`:

```bash
# Read by `vite build` (mode=production) and by nothing else. Beats a developer's
# own apps/web/.env, which vite gives lower priority in this mode.
#
# Relative on purpose: on the VPS the till and the API are the same origin —
# Caddy answers both https://shop.<domain>/ and https://shop.<domain>/api/*.
# An absolute address here would have to name the domain, which would mean this
# file could not be committed, which would mean the one thing standing between
# a deploy and a site that calls the visitor's own laptop is somebody's memory.
#
# The kitchen socket is derived from this, not configured separately — see
# liveSocketUrl() in src/api-client.ts. /api becomes wss://shop.<domain>/api/live.
VITE_API_URL="/api"
```

`apps/office/.env.production`:

```bash
# Read by `vite build` (mode=production) and by nothing else.
#
# Same origin as the API on the VPS: Caddy answers https://office.<domain>/ and
# https://office.<domain>/api/* from one site block. See apps/web/.env.production
# for the full reasoning — it applies identically here.
VITE_API_URL="/api"
```

- [x] **Step 3: เขียนเทสต์ที่ยังไม่ผ่าน**

ต่อท้าย `apps/web/src/bundle-boundary.test.ts`:

```ts
/**
 * Where the two built sites think the API is.
 *
 * The source has a fallback of http://localhost:3001/api, which is right for a
 * fresh clone with no .env and catastrophic on a server: the browser would
 * dial port 3001 on the machine of whoever opened the page. It fails with a
 * network error rather than a wrong answer, so it is survivable — but it is
 * invisible until someone opens the site, which on a shop's first morning is
 * the worst possible moment to find out.
 *
 * esbuild folds `"/api" ?? "http://localhost:3001/api"` away when minifying,
 * so the absence of that string in the output is a real signal that
 * .env.production was read. Verified by building both ways before this test
 * was written.
 */
suite('what the built sites dial', () => {
  it('the till carries no localhost API address', () => {
    expect(shippedJs(TILL_DIST)).not.toContain('localhost:3001');
  });

  it('the office carries no localhost API address', () => {
    expect(shippedJs(OFFICE_DIST)).not.toContain('localhost:3001');
  });
});
```

- [x] **Step 4: build แล้วรันเทสต์**

```bash
pnpm build && pnpm --filter @pos/web test -- src/bundle-boundary.test.ts
```

Expected: PASS ทั้งไฟล์ · ถ้า `dist/` ยังไม่มี ทั้ง suite จะข้ามตัวเองแล้วรายงานเป็น skipped
ซึ่งแปลว่า `pnpm build` ล้ม ให้ย้อนไปดูก่อน

- [x] **Step 5: พิสูจน์ว่าเทสต์กัดจริง**

```bash
mv apps/web/.env.production apps/web/.env.production.off && pnpm --filter @pos/web build && pnpm --filter @pos/web test -- src/bundle-boundary.test.ts
```

Expected: FAIL ที่ `the till carries no localhost API address` · จากนั้นคืนสภาพ:

```bash
mv apps/web/.env.production.off apps/web/.env.production && pnpm build
```

- [x] **Step 6: กวาดทั้ง workspace**

```bash
pnpm test && pnpm typecheck && npx eslint . && npx prettier --check .
```

Expected: เขียวทั้งหมด · `@pos/web` **คาดหวัง: 251 ผ่าน** (249 + 2 เมื่อ build แล้ว) · รวม **1,226**

- [x] **Step 7: commit**

```bash
git add .gitignore apps/web/.env.production apps/office/.env.production apps/web/src/bundle-boundary.test.ts
git commit -m "feat: build both sites to talk to their own /api"
```

---

## Task 3: CI

**Files:**

- Create: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: workflow ชื่อ `CI` ที่รันทุก push และทุก pull request — ไม่มี task ไหนพึ่งพา แต่ทุก task
  หลังจากนี้ได้ประโยชน์ เพราะการแก้ config บนเครื่องจริงจะไม่ทำให้เทสต์แดงโดยไม่มีใครรู้

**บริบท:** ตอนนี้ยังไม่มีโฟลเดอร์ `.github/` เลย ทั้งที่มีเทสต์ 1,226 ตัว (สเปก §7.2) · เทสต์ของ
`@pos/api` ยิงฐานข้อมูลจริงและต้องการเมนูจาก `db:seed:demo` จึงต้องยก Postgres ขึ้นเป็น service container
· และ **ต้อง `pnpm build` ก่อน `pnpm test`** ไม่งั้นเทสต์ 4 ตัวใน `bundle-boundary.test.ts`
จะข้ามตัวเองอย่างเงียบ ๆ แล้ว CI จะเขียวโดยไม่ได้ตรวจสิ่งที่มันถูกสร้างมาตรวจ

- [ ] **Step 1: เขียน workflow**

สร้าง `.github/workflows/ci.yml`:

```yaml
# Runs the same four commands a human runs before committing, on a machine
# that has never seen this repo before.
#
# `pnpm build` comes BEFORE `pnpm test` on purpose: bundle-boundary.test.ts
# reads dist/ and calls describe.skip when it is missing, so without a build
# those four tests report green by not running. The one check that exists to
# stop a payroll screen reaching a tablet must not be the one that opts out.
name: CI

on:
  push:
  pull_request:

# A second push to the same branch makes the first run pointless. Cancel it
# rather than queue behind it.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    services:
      postgres:
        # Same major version as docker-compose.yml and as the VPS, and UTC for
        # the same reason the compose file says so: businessDate maths is done
        # in the app against a database that stores UTC.
        image: postgres:16-alpine
        env:
          POSTGRES_USER: pos
          POSTGRES_PASSWORD: pos_dev_password
          POSTGRES_DB: pos_dev
          TZ: UTC
          PGTZ: UTC
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U pos -d pos_dev"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      DATABASE_URL: postgresql://pos:pos_dev_password@localhost:5432/pos_dev?schema=public
      # Throwaway values that only have to satisfy the length checks in env.ts.
      # Nothing here signs anything that outlives the job.
      JWT_SECRET: ci-only-jwt-secret-not-used-anywhere
      PRINT_AGENT_TOKEN: ci-only-print-agent-token-value

    steps:
      - uses: actions/checkout@v4

      # Reads "packageManager": "pnpm@11.18.0" from package.json, so the
      # version is pinned in one place rather than two.
      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      # postinstall runs `prisma generate`, so the client exists after this.
      - run: pnpm install --frozen-lockfile

      - run: pnpm typecheck
      - run: npx eslint .
      - run: npx prettier --check .

      - run: pnpm build

      - run: pnpm --filter @pos/api db:deploy
      - run: pnpm --filter @pos/api db:seed:demo

      - run: pnpm test
```

- [ ] **Step 2: ตรวจว่า YAML อ่านได้ก่อน push**

```bash
node -e "const{readFileSync}=require('fs');const s=readFileSync('.github/workflows/ci.yml','utf8');if(!s.includes('pnpm build')||s.indexOf('pnpm build')>s.indexOf('run: pnpm test'))throw new Error('build must come before test');console.log('order ok, '+s.split('\n').length+' lines')"
```

Expected: `order ok, ...`

- [ ] **Step 3: commit แล้ว push ให้มันรันจริง**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run typecheck, lint, format and the full suite on every push"
git push
```

- [ ] **Step 4: ดูผลรันแรก**

```bash
gh run watch
```

Expected: เขียว · ถ้าแดงให้แก้จนเขียวก่อนไป Task 4 — สเปก D9 เขียนไว้ตรง ๆ ว่า CI ที่แดงสุ่มคือ CI ที่คนเลิกอ่าน
และ CI ที่แดงตั้งแต่วันแรกก็คนละอาการเดียวกัน

> **ถ้า `@pos/api` แดงบน CI แต่เขียวบนเครื่อง** ให้ดูจำนวนเทสต์ที่รันก่อนอย่างอื่น · `apps/api/vitest.config.ts`
> ตั้ง `fileParallelism: false` ไว้เพราะทุกไฟล์ใช้ฐานข้อมูลเดียวกัน ถ้าค่านั้นหาย เทสต์จะแย่งกันเขียนแถวเดียวกัน
> และอาการจะออกเฉพาะบนเครื่องที่ CPU มากกว่าเครื่อง dev

---

## Task 4: เตรียมเครื่อง

**Files:**

- Create: `deploy/README.md` (เริ่มไว้ที่ task นี้ แล้วต่อเติมทุก task หลังจากนี้)

**Interfaces:**

- Produces: ผู้ใช้ `pos` · โฟลเดอร์ `/srv/pos` (git checkout) `/srv/www/shop` `/srv/www/office` (ไฟล์ static)
  `/etc/pos/` (ความลับ) · ufw ที่เปิดแค่ 22/80/443 · swap 2 GB · Node 22 + pnpm
  — Task 5–12 ใช้ทั้งหมดนี้

**หมายเหตุก่อนเริ่ม:** ตั้งแต่ task นี้ไปคำสั่งรันบน VPS ผ่าน ssh ไม่ใช่บนเครื่องตัวเอง
· ทุกขั้นที่ขึ้นต้นด้วย `sudo` รันในฐานะผู้ใช้ปกติที่มีสิทธิ์ sudo ไม่ใช่ root

- [ ] **Step 1: อัปเดตเครื่องแล้วลงของพื้นฐาน**

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ufw rsync ca-certificates debian-keyring debian-archive-keyring apt-transport-https
```

- [ ] **Step 2: กำแพงไฟ**

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

Expected: `Status: active` และมีแค่สามพอร์ต · **ห้ามเปิด 3001 หรือ 5432 เด็ดขาด** ทั้งคู่จะถูกผูกไว้กับ
`127.0.0.1` ใน Task 5 และ 6 อยู่แล้ว การเปิดพอร์ตให้มันคือการยกเลิกงานสองอันนั้น

- [ ] **Step 3: swap 2 GB**

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Expected: บรรทัด `Swap:` แสดง 2.0Gi · เครื่อง 2 GB ต้อง build vite สองแอปกับ `tsc` สี่ตัวในการ deploy
หนึ่งครั้ง ซึ่งเป็นจุดเดียวของทั้งระบบที่กิน RAM เป็นก้อน ถ้าไม่มี swap ตัว build จะถูก OOM killer ฆ่า
กลางทางและ error ที่ได้จะไม่พูดถึงหน่วยความจำเลย

- [ ] **Step 4: Node 22 + pnpm**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
node --version && corepack --version
```

Expected: `v22.x.x` · pnpm ไม่ต้องลงเอง — `package.json` ระบุ `"packageManager": "pnpm@11.18.0"`
และ corepack จะดึงเวอร์ชันนั้นมาให้เองตอนเรียก `pnpm` ครั้งแรกในโฟลเดอร์โปรเจกต์

- [ ] **Step 5: ผู้ใช้ `pos` และโฟลเดอร์**

```bash
sudo adduser --system --group --home /srv/pos --shell /bin/bash pos
sudo mkdir -p /srv/www/shop /srv/www/office /etc/pos
sudo chown -R pos:pos /srv/pos /srv/www
sudo chmod 750 /etc/pos
```

`--system` เพราะบัญชีนี้ไม่มีคนล็อกอิน มันมีไว้ให้ systemd รัน API และให้ cron รัน backup

- [ ] **Step 6: clone โปรเจกต์**

```bash
sudo -u pos git clone https://github.com/kongboxx/pos.git /srv/pos/repo
sudo -u pos git -C /srv/pos/repo log --oneline -1
```

Expected: commit ล่าสุดของ `main`

> **ทำไม `/srv/pos/repo` ไม่ใช่ `/srv/pos`** — home ของผู้ใช้ระบบมีไฟล์ของตัวเองอยู่แล้ว
> และการ clone ทับ home ทำให้ `git status` เห็นไฟล์เหล่านั้นเป็นของแปลกปลอมตลอดไป

- [ ] **Step 7: เขียน `deploy/README.md` บนเครื่องตัวเอง**

สร้าง `deploy/README.md` ในโปรเจกต์ (ไม่ใช่บน VPS):

```markdown
# deploy/

ไฟล์ในโฟลเดอร์นี้คือ **รูปร่าง** ของเครื่องจริง ไม่ใช่ค่าของมัน
ค่าจริงทุกตัว — รหัสผ่านฐานข้อมูล · `JWT_SECRET` · กุญแจ rclone — อยู่ใต้ `/etc/pos/` บน VPS
และไม่เคยอยู่ในที่นี่

## เครื่องหน้าตาแบบนี้

    /srv/pos/repo     git checkout ของ main
    /srv/www/shop     ไฟล์ static ของหน้าร้าน ที่ Caddy เสิร์ฟ
    /srv/www/office   ไฟล์ static ของหลังร้าน
    /etc/pos/         ความลับ · chmod 750 · เจ้าของ root:pos

**ไฟล์ static อยู่นอก git tree โดยตั้งใจ** — ถ้า Caddy ชี้ `root` เข้าไปใน checkout
คำขอที่พิมพ์ `/.git/config` หรือ `/apps/api/.env` จะได้ไฟล์นั้นจริง ๆ กลับไป

## ลำดับตอนสร้างเครื่องใหม่

Task 4 เตรียมเครื่อง → 5 PostgreSQL → 6 systemd → 7 Caddy → 8 deploy ครั้งแรก → 9 backup → 10 cron
ดูรายละเอียดใน `docs/superpowers/plans/2026-08-17-back-office-split-part3-deploy.md`
```

- [ ] **Step 8: commit**

```bash
git add deploy/README.md
git commit -m "docs: describe the shape of the server"
```

---

## Task 5: PostgreSQL

**Files:**

- Create: `deploy/postgres-setup.sql`

**Interfaces:**

- Produces: ฐานข้อมูล `pos` · role `pos` ที่มีสิทธิ์ `CREATEDB` (Task 9 ใช้สร้างฐานข้อมูลชั่วคราวตอนทดสอบกู้คืน)
  · ที่อยู่เชื่อมต่อ `postgresql://pos:<password>@127.0.0.1:5432/pos?schema=public` ซึ่ง Task 6 เขียนลง `/etc/pos/api.env`

- [ ] **Step 1: ลง PostgreSQL 16**

```bash
sudo apt install -y postgresql postgresql-client
psql --version
```

Expected: `psql (PostgreSQL) 16.x` — เท่ากับที่ `docker-compose.yml` ใช้ตอน dev

- [ ] **Step 2: ยืนยันว่ามันฟังแค่ localhost**

```bash
sudo ss -ltnp | grep 5432
```

Expected: `127.0.0.1:5432` เท่านั้น · ถ้าเห็น `0.0.0.0:5432` ให้แก้ `listen_addresses = 'localhost'`
ใน `/etc/postgresql/16/main/postgresql.conf` แล้ว `sudo systemctl restart postgresql`

- [ ] **Step 3: บังคับ UTC**

```bash
sudo -u postgres psql -c "ALTER SYSTEM SET timezone = 'UTC';"
sudo systemctl restart postgresql
sudo -u postgres psql -tAc "SHOW timezone;"
```

Expected: `UTC` · เหตุผลเดียวกับที่ `docker-compose.yml` ตั้ง `TZ`/`PGTZ` ไว้ — ฐานข้อมูลเก็บ UTC
แล้วแอปแปลงเป็นเวลาร้านตามกฎข้อ 4 ถ้าเซิร์ฟเวอร์คิดเป็นเวลาไทย บิลตอนตีหนึ่งจะถูกนับเข้าวันผิด

- [ ] **Step 4: สร้าง role และฐานข้อมูล**

สร้าง `deploy/postgres-setup.sql` ในโปรเจกต์:

```sql
-- Run ONCE, as the postgres superuser, with :password supplied on the command
-- line so it never lands in a file or in shell history:
--
--   sudo -u postgres psql -v password="$(read -rsp 'db password: ' p; echo "$p")" \
--        -f /srv/pos/repo/deploy/postgres-setup.sql
--
-- CREATEDB is here for one reason: deploy/restore-check.sh restores the latest
-- dump into a scratch database every week to prove the backup is real. Without
-- it that check would have to run as a superuser, which is a much larger key to
-- leave lying in a cron job than the right to make a database.
CREATE ROLE pos WITH LOGIN CREATEDB PASSWORD :'password';
CREATE DATABASE pos OWNER pos ENCODING 'UTF8';
```

รันบน VPS:

```bash
sudo -u postgres psql -v password="$(read -rsp 'db password: ' p; echo "$p")" -f /srv/pos/repo/deploy/postgres-setup.sql
```

> **รหัสผ่านนี้ต้องสุ่ม ไม่ใช่คิดเอง** สร้างด้วย `openssl rand -base64 24` แล้ววางตอนถูกถาม
> · ห้ามพิมพ์มันลงบทสนทนา ตั๋วงาน หรือภาพหน้าจอ

- [ ] **Step 5: ทดสอบเชื่อมต่อในฐานะ `pos`**

```bash
PGPASSWORD='<password>' psql -h 127.0.0.1 -U pos -d pos -c 'SELECT current_database(), current_user;'
```

Expected: `pos | pos` · ถ้าโดนปฏิเสธ ให้ดู `/etc/postgresql/16/main/pg_hba.conf` ว่ามีบรรทัด
`host all all 127.0.0.1/32 scram-sha-256` อยู่ (Ubuntu 24.04 มีให้เป็นค่าตั้งต้น)

- [ ] **Step 6: ยืนยันจากนอกเครื่องว่าเข้าไม่ได้**

รันจากเครื่องตัวเอง ไม่ใช่บน VPS:

```bash
nc -vz -w 5 <vps-ip> 5432
```

Expected: timeout หรือ refused · ถ้าติด แปลว่า Step 2 หรือ ufw ผิด ให้หยุดแล้วแก้ก่อนไปต่อ

- [ ] **Step 7: commit**

```bash
git add deploy/postgres-setup.sql
git commit -m "feat: add the one-time database setup script"
```

---

## Task 6: API เป็น systemd service ที่ผูกกับ 127.0.0.1

**Files:**

- Create: `deploy/pos-api.service`
- Create: `deploy/api.env.example`
- Modify: `deploy/README.md` (เติมสองแถวในตาราง)

**Interfaces:**

- Consumes: `Env.TRUST_PROXY` จาก Task 1 · ที่อยู่ฐานข้อมูลจาก Task 5
- Produces: unit `pos-api.service` ที่ฟังอยู่ที่ `127.0.0.1:3001` — Task 7 ส่ง `/api/*` มาที่นี่
  · `/etc/pos/api.env` ซึ่ง Task 10 อ่านซ้ำเพื่อรัน `sessions:purge`

**นี่คือ task ที่ทำให้กำแพงของแผนที่ 2 เป็นกำแพงจริง** — คอมเมนต์ใน `apps/api/src/modules/auth/host-guard.ts`
เขียนไว้ตรง ๆ ว่า _"Binding the API to localhost is plan 3's job, and until that lands this narrows the
target without sealing it"_ · `HOST` มีค่าตั้งต้นเป็น `0.0.0.0` ใน `env.ts:24` ซึ่งถูกสำหรับ dev
(แท็บเล็ตในร้านต้องเข้าถึงผ่าน LAN IP) และผิดสำหรับเครื่องจริง

- [ ] **Step 1: เขียน unit file**

สร้าง `deploy/pos-api.service`:

```ini
# → /etc/systemd/system/pos-api.service
#
# One Node process, restarted forever. The shop cannot sell while this is down
# (spec §8.1), so there is no such thing as "leave it stopped and look at it in
# the morning" — it comes back up and the reason is in the journal.

[Unit]
Description=POS API (Fastify)
Documentation=https://github.com/kongboxx/pos
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=pos
Group=pos
WorkingDirectory=/srv/pos/repo/apps/api

# Every secret the process needs, and nothing else. chmod 600, owner pos.
EnvironmentFile=/etc/pos/api.env

ExecStart=/usr/bin/node dist/server.js

# server.ts already handles SIGTERM by closing Fastify and disconnecting Prisma
# before exiting, so the default signal is the right one. The timeout is
# generous because a shutdown mid-transaction is exactly what must not be cut
# short: a half-written bill is worse than a slow deploy.
KillSignal=SIGTERM
TimeoutStopSec=30

Restart=always
RestartSec=3

# The API reads the built code and talks to a socket. It writes nothing to
# disk, so it is given a filesystem it cannot write to.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=pos-api

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: เขียนแม่แบบของ environment file**

สร้าง `deploy/api.env.example`:

```bash
# → /etc/pos/api.env   (chmod 600, chown pos:pos)
#
# NEVER commit the filled-in version. This file is the example; the real one
# lives only on the server. systemd reads it as KEY=VALUE with no shell
# expansion, so do not quote values and do not use $VARIABLES.

NODE_ENV=production

# Loopback ONLY. This is the line that turns the Host check in
# apps/api/src/modules/auth/host-guard.ts from a hint into a boundary: a Host
# header is chosen by whoever sends the request, so it means something only
# when the reverse proxy is the sole way in. Setting this back to 0.0.0.0
# silently undoes plan 2's work and nothing anywhere will complain.
HOST=127.0.0.1
PORT=3001

DATABASE_URL=postgresql://pos:REPLACE_WITH_DB_PASSWORD@127.0.0.1:5432/pos?schema=public

# openssl rand -hex 48
JWT_SECRET=REPLACE_ME

# Must match PRINT_AGENT_TOKEN in the Raspberry Pi's .env — see Task 11.
# openssl rand -hex 32
PRINT_AGENT_TOKEN=REPLACE_ME

# Both sites, https, no trailing slash. In production these are same-origin
# with the API so no browser actually sends an Origin that needs allowing —
# but env.ts requires at least one entry, and naming the real ones is better
# than leaving the default, which allows http://localhost:5173. That default
# is harmless on a laptop and pointless here.
WEB_ORIGIN=https://shop.<domain>,https://office.<domain>

# /auth/staff and /auth/branches answer only on the till's host. The office
# domain gets a 404, which is what plan 2 built and what Caddy's preserved Host
# header makes true.
TILL_HOSTS=shop.<domain>

# Exactly one proxy stands in front of this. See TRUST_PROXY in env.ts.
TRUST_PROXY=true
```

- [ ] **Step 3: ติดตั้งบน VPS**

```bash
sudo cp /srv/pos/repo/deploy/api.env.example /etc/pos/api.env
sudo chown pos:pos /etc/pos/api.env
sudo chmod 600 /etc/pos/api.env
sudo nano /etc/pos/api.env
```

แก้ทุกบรรทัดที่มี `REPLACE` และทุก `<domain>` · ตรวจซ้ำว่า `HOST=127.0.0.1` แล้ว

- [ ] **Step 4: build แล้วเตรียมฐานข้อมูลครั้งแรก**

```bash
cd /srv/pos/repo
sudo -u pos pnpm install --frozen-lockfile
sudo -u pos pnpm build
sudo -u pos env $(grep -v '^#' /etc/pos/api.env | xargs) pnpm --filter @pos/api db:deploy
```

Expected: `All migrations have been successfully applied.` · การ seed ข้อมูลจริงอยู่ใน Task 8
ตอนนี้แค่ต้องการ schema

- [ ] **Step 5: เปิด service**

```bash
sudo cp /srv/pos/repo/deploy/pos-api.service /etc/systemd/system/pos-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now pos-api
sudo systemctl status pos-api --no-pager
```

Expected: `active (running)`

- [ ] **Step 6: ยืนยันว่ามันฟังแค่ loopback**

```bash
sudo ss -ltnp | grep 3001
curl -s http://127.0.0.1:3001/api/health
```

Expected: บรรทัดแรกแสดง `127.0.0.1:3001` **ไม่ใช่** `0.0.0.0:3001` · บรรทัดที่สองได้
`{"status":"ok","uptimeSeconds":...,"version":"0.0.0"}`

- [ ] **Step 7: ยืนยันจากนอกเครื่องว่าเข้าไม่ถึง**

รันจากเครื่องตัวเอง:

```bash
curl -sS --max-time 5 http://<vps-ip>:3001/api/health; echo "exit=$?"
```

Expected: ล้มเหลว (`exit=28` timeout หรือ `exit=7` refused) · **ถ้าได้ JSON กลับมา ให้หยุดทันที**
แปลว่า `HOST` ยังเป็น `0.0.0.0` และตราบใดที่ยังเป็นแบบนั้น ใครก็ปลอม `Host: shop.<domain>` เข้ามาอ่าน
`/auth/staff` ได้ตรง ๆ

- [ ] **Step 8: ยืนยันว่า restart แล้วขึ้นเอง**

```bash
sudo systemctl kill -s SIGKILL pos-api && sleep 5 && curl -s http://127.0.0.1:3001/api/health
```

Expected: ได้ JSON กลับมา — `Restart=always` ทำงาน

- [ ] **Step 9: เติมตารางใน `deploy/README.md`**

บนเครื่องตัวเอง เพิ่มตารางนี้ใน `deploy/README.md` ใต้หัวข้อแรก (Task 7–10 จะมาเติมแถวต่อ):

```markdown
| ไฟล์                 | ไปอยู่ที่ไหนบนเครื่อง                         |
| -------------------- | --------------------------------------------- |
| `postgres-setup.sql` | รันครั้งเดียวในฐานะ postgres                  |
| `pos-api.service`    | `/etc/systemd/system/pos-api.service`         |
| `api.env.example`    | คัดลอกเป็น `/etc/pos/api.env` แล้วเติมค่าจริง |
```

- [ ] **Step 10: commit**

```bash
git add deploy/pos-api.service deploy/api.env.example deploy/README.md
git commit -m "feat: run the API as a service bound to loopback"
```

---

## Task 7: Caddy — https, สองเว็บ, `/api` ใต้ทั้งคู่

**Files:**

- Create: `deploy/Caddyfile`
- Modify: `deploy/README.md`

**Interfaces:**

- Consumes: API ที่ `127.0.0.1:3001` จาก Task 6 · `TRUST_PROXY=true` จาก Task 1
- Produces: `https://shop.<domain>` และ `https://office.<domain>` ที่เสิร์ฟไฟล์จาก `/srv/www/*`
  และส่ง `/api/*` ต่อไป Node — Task 8 เอาไฟล์ที่ build แล้วมาใส่ในสองโฟลเดอร์นั้น

- [ ] **Step 1: ชี้ DNS**

สร้าง A record สองอัน ที่ผู้ให้บริการโดเมน:

```
shop    A    <vps-ip>
office  A    <vps-ip>
```

รอแล้วตรวจ:

```bash
dig +short shop.<domain> office.<domain>
```

Expected: `<vps-ip>` สองบรรทัด · **ต้องได้ก่อนขั้นถัดไป** Caddy ขอใบรับรองไม่ได้ถ้า Let's Encrypt
ยังหาเครื่องไม่เจอ

- [ ] **Step 2: ลง Caddy**

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
caddy version
```

- [ ] **Step 3: หน้าชั่วคราวสองหน้า เพื่อพิสูจน์ https ก่อนเอาแอปจริงขึ้น**

```bash
echo 'shop placeholder'   | sudo -u pos tee /srv/www/shop/index.html
echo 'office placeholder' | sudo -u pos tee /srv/www/office/index.html
```

- [ ] **Step 4: เขียน Caddyfile**

สร้าง `deploy/Caddyfile` ในโปรเจกต์:

```caddyfile
# → /etc/caddy/Caddyfile   (แทน <domain> และ <admin-email> ด้วยค่าจริงตอนคัดลอกขึ้นเครื่อง)
#
# One process holding both certificates and renewing them itself, which is the
# whole reason Caddy is here rather than nginx: a shop with nobody watching the
# server must not have an expiry date in its future.

{
	email <admin-email>
}

# Everything both sites share. Imported, not repeated, so a header added for
# one cannot be forgotten on the other.
(site_common) {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "same-origin"
		-Server
	}

	# Vite fingerprints everything under /assets/, so those URLs can never
	# change meaning. A year is safe and it is what makes a reload on shop wifi
	# cost nothing.
	@immutable path /assets/*
	header @immutable Cache-Control "public, max-age=31536000, immutable"

	# These four cannot be cached, and index.html is the one that matters: it is
	# the file that names which fingerprinted assets to fetch. A tablet holding
	# yesterday's index.html asks for yesterday's chunks and never sees a deploy,
	# which reads as "the update did not work" with nothing in any log.
	@volatile path /index.html / /sw.js /registerSW.js /manifest.webmanifest /workbox-*.js
	header @volatile Cache-Control "no-cache"
}

# The API, identical under both hosts. Same origin as the page that calls it,
# which is what lets the cookies stay sameSite=lax with no CORS at all (spec D5).
(api_upstream) {
	handle /api/* {
		reverse_proxy 127.0.0.1:3001 {
			# OVERWRITE, never append. The API is configured to trust exactly one
			# hop (TRUST_PROXY in apps/api/src/env.ts), so this header must hold
			# the real peer and nothing a caller wrote. Appending would leave a
			# forged entry in front of it, and Caddy's own default `+` behaviour
			# is exactly that — hence naming it explicitly.
			header_up X-Forwarded-For {remote_host}
		}
	}
}

shop.<domain> {
	import site_common
	import api_upstream

	handle {
		root * /srv/www/shop
		# The service worker answers offline navigations from cache, but a cold
		# tablet that lands on /order/<uuid> asks the server for that path first.
		# Without this it gets a 404 and the shell that could read the bill from
		# IndexedDB never loads.
		try_files {path} /index.html
		file_server
	}
}

office.<domain> {
	import site_common
	import api_upstream

	handle {
		root * /srv/www/office
		try_files {path} /index.html
		file_server
	}
}
```

> **Host ถูกส่งต่อไปโดยไม่ต้องสั่ง** — `reverse_proxy` ของ Caddy 2 คง `Host` เดิมไว้เป็นค่าตั้งต้น
> (ต่างจาก nginx ที่เขียนทับ) ซึ่งเป็นสิ่งที่สเปก §4.2 ย้ำว่าต้องเป็นแบบนั้น · ถ้าวันหนึ่งมีคนเติม
> `header_up Host {upstream_hostport}` เข้าไป `TILL_HOSTS` จะหยุดแยกสองประตูทันทีและไม่มีอะไรฟ้อง
> — Step 8 ของ task นี้คือเทสต์ที่จับเรื่องนั้น

- [ ] **Step 5: ติดตั้งแล้วตรวจไวยากรณ์**

```bash
sudo cp /srv/pos/repo/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # แทน <domain> และ <admin-email>
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expected: `Valid configuration`

- [ ] **Step 6: เปิดใช้**

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Expected: `active (running)` · ครั้งแรกจะใช้เวลาสักครู่ระหว่างขอใบรับรอง ดูได้ที่
`sudo journalctl -u caddy -f` ซึ่งควรมีบรรทัด `certificate obtained successfully` สองครั้ง

- [ ] **Step 7: ตรวจ https ของทั้งสองเว็บ**

รันจากเครื่องตัวเอง:

```bash
curl -sI https://shop.<domain>/ | head -1
curl -sI https://office.<domain>/ | head -1
curl -s https://shop.<domain>/api/health
```

Expected: `HTTP/2 200` สองครั้ง แล้ว JSON ของ health

- [ ] **Step 8: ตรวจว่าสองประตูยังแยกกันจริงหลังผ่าน proxy**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://shop.<domain>/api/auth/branches
curl -s -o /dev/null -w '%{http_code}\n' https://office.<domain>/api/auth/branches
```

Expected: `200` แล้ว `404` · **นี่คือการตรวจที่สำคัญที่สุดของ task นี้** — มันพิสูจน์พร้อมกันสามอย่าง:
Caddy ส่ง `Host` เดิมต่อไป · `TILL_HOSTS` ถูกตั้งถูก · และงานทั้งหมดของแผนที่ 2 เรื่องการปิด
endpoint ที่เปิดโล่งยังมีผลหลังมี proxy คั่น

- [ ] **Step 9: ตรวจ cache header**

```bash
curl -sI https://shop.<domain>/index.html | grep -i cache-control
```

Expected: `cache-control: no-cache`

- [ ] **Step 10: เติมตารางแล้ว commit**

เพิ่มแถวใน `deploy/README.md`:

```markdown
| `Caddyfile` | `/etc/caddy/Caddyfile` (แทน `<domain>` และ `<admin-email>`) |
```

```bash
git add deploy/Caddyfile deploy/README.md
git commit -m "feat: serve both sites over https with the API underneath"
```

---

## Task 8: `deploy.sh` และการขึ้นของจริงครั้งแรก

**Files:**

- Create: `deploy/deploy.sh`
- Modify: `deploy/README.md`

**Interfaces:**

- Consumes: ทุกอย่างจาก Task 4–7
- Produces: คำสั่งเดียวที่รันซ้ำได้ `sudo -u pos /srv/pos/repo/deploy/deploy.sh` — Task 12 เขียนถึงมันใน README

- [ ] **Step 1: เขียนสคริปต์**

สร้าง `deploy/deploy.sh`:

```bash
#!/usr/bin/env bash
#
# One command, run as the `pos` user, that takes the server from whatever it is
# to whatever `main` says it should be.
#
#   sudo -u pos /srv/pos/repo/deploy/deploy.sh
#
# Order matters and is not arbitrary:
#   build BEFORE migrate  — a failed build must not leave a migrated database
#                           in front of the old code
#   migrate BEFORE restart — the new code may need the new column
#   rsync AFTER build      — the static files are swapped in one step, so a
#                           visitor never gets an index.html naming chunks that
#                           are not there yet
set -euo pipefail

REPO=/srv/pos/repo
ENV_FILE=/etc/pos/api.env

cd "$REPO"

echo "==> fetching"
git fetch --prune origin
git checkout main
git reset --hard origin/main
git log --oneline -1

echo "==> installing"
pnpm install --frozen-lockfile

echo "==> building"
# Two vite builds and four tsc runs on a 2 GB box. This is the step the swap
# file from Task 4 exists for; without it the OOM killer stops it here with an
# error that never mentions memory.
pnpm build

echo "==> migrating"
# `migrate deploy` only. It applies what is pending and refuses to do anything
# destructive — unlike `migrate dev` and `db push`, neither of which may ever
# be pointed at this database.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
pnpm --filter @pos/api db:deploy

echo "==> publishing the static files"
rsync -a --delete apps/web/dist/    /srv/www/shop/
rsync -a --delete apps/office/dist/ /srv/www/office/

echo "==> restarting the API"
sudo systemctl restart pos-api

echo "==> waiting for health"
for attempt in $(seq 1 20); do
	if curl -fsS --max-time 2 http://127.0.0.1:3001/api/health >/dev/null; then
		echo "healthy after ${attempt}s"
		curl -fsS http://127.0.0.1:3001/api/health/db
		echo
		echo "==> done: $(git log --oneline -1)"
		exit 0
	fi
	sleep 1
done

echo "!! the API did not come back within 20s" >&2
echo "!! journalctl -u pos-api -n 50 --no-pager" >&2
exit 1
```

- [ ] **Step 2: ให้ `pos` restart service ได้โดยไม่ต้องเป็น root ทั้งตัว**

สร้างไฟล์ sudoers บน VPS:

```bash
echo 'pos ALL=(root) NOPASSWD: /usr/bin/systemctl restart pos-api' | sudo tee /etc/sudoers.d/pos-deploy
sudo chmod 440 /etc/sudoers.d/pos-deploy
sudo visudo -c
```

Expected: `parsed OK` · สิทธิ์เดียว คำสั่งเดียว — ไม่ใช่ `NOPASSWD: ALL`

- [ ] **Step 3: ทำให้รันได้แล้ว commit**

```bash
chmod +x deploy/deploy.sh
git add deploy/deploy.sh
git update-index --chmod=+x deploy/deploy.sh
git commit -m "feat: add the deploy script"
git push
```

- [ ] **Step 4: deploy จริงครั้งแรก**

```bash
cd /srv/pos/repo && sudo -u pos git pull && sudo -u pos ./deploy/deploy.sh
```

Expected: จบด้วย `healthy after Ns` และ `==> done: <commit>` · หน้า placeholder จาก Task 7
ถูกทับด้วยแอปจริงแล้ว

- [ ] **Step 5: seed ร้านจริง**

> **รหัสผ่านตรงนี้เจ้าของเป็นคนพิมพ์ ไม่ใช่คนที่รันแผนนี้** เปิดไฟล์ในฐานะเจ้าของ หรือให้เจ้าของ
> พิมพ์ลงไปเอง · ห้ามให้ค่านี้ผ่านบทสนทนา ตั๋วงาน หรือภาพหน้าจอ ตาม Global Constraint

สร้าง `/srv/pos/repo/apps/api/.env` ชั่วคราว (ไฟล์นี้ถูก `.gitignore` กันไว้แล้ว):

```bash
sudo -u pos nano /srv/pos/repo/apps/api/.env
```

ใส่ค่าฐานข้อมูลกับข้อมูลร้าน — `DATABASE_URL` ต้องตรงกับใน `/etc/pos/api.env`
ส่วนที่เหลือดูรายการเต็มใน `apps/api/.env.example`:

```bash
DATABASE_URL=postgresql://pos:<db-password>@127.0.0.1:5432/pos?schema=public
SHOP_NAME=<ชื่อร้าน>
SHOP_CODE=<รหัส 2-4 ตัวอักษร>
OWNER_NAME=<ชื่อเต็มเจ้าของ>
OWNER_NICKNAME=<ชื่อเล่น>
OWNER_EMAIL=<อีเมลเจ้าของ>
OWNER_PASSWORD=<เจ้าของพิมพ์เอง อย่างน้อย 12 ตัวอักษร>
```

แล้ว:

```bash
cd /srv/pos/repo && sudo -u pos pnpm --filter @pos/api db:seed
sudo -u pos rm /srv/pos/repo/apps/api/.env
```

Expected: กล่องสรุปบนจอบอกชื่อร้านกับ PIN (และรหัสผ่าน ถ้าปล่อยให้ระบบสุ่มให้) · ลบไฟล์ทิ้งทันทีหลังเสร็จ
API ไม่เคยอ่านค่าพวกนี้ มันมีไว้ให้ `db:seed` ครั้งเดียว

> **`SHOP_CODE` แก้ไม่ได้หลังใบเสร็จใบแรกออก** (กฎข้อ 9) ตรวจให้แน่ก่อนกด

- [ ] **Step 6: ล็อกอินหลังร้านจากเบราว์เซอร์จริง**

เปิด `https://office.<domain>` แล้วล็อกอินด้วยอีเมล+รหัสผ่านของเจ้าของ

Expected: เข้าได้ · เห็นหน้าเมนู · และ **ไม่มีรายชื่อพนักงานให้เลือกบนหน้าล็อกอิน** (แผนที่ 2 Task 12)

- [ ] **Step 7: ตรวจว่าคุกกี้ของสองเว็บไม่ปนกันจริง**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://shop.<domain>/api/auth/me
curl -sI https://office.<domain>/ | grep -i strict-transport
```

Expected: `401` (ยังไม่ได้ล็อกอินจาก curl) แล้ว header HSTS · ส่วนการแยกคุกกี้จริง ๆ ดูจากเบราว์เซอร์:
ล็อกอินหลังร้านแล้วเปิด `https://shop.<domain>` ต้องยังเจอหน้าใส่ PIN ไม่ใช่หน้าที่ล็อกอินอยู่แล้ว

> **ข้อนี้เคยเป็นปัญหาตอน dev และหายไปเองบนเครื่องจริง** — แผนที่ 2 บันทึกไว้ว่า `localhost` คนละพอร์ต
> ใช้คุกกี้ jar เดียวกัน จึงต้องแยกชื่อคุกกี้เป็น `pos_session` กับ `office_session` · บน production
> คนละ host จึงแยกกันสองชั้น การตรวจนี้ยืนยันว่าชั้นที่สองทำงาน

- [ ] **Step 8: เติม `deploy/README.md` แล้ว commit**

```markdown
| `deploy.sh` | รันในที่เดิม: `sudo -u pos /srv/pos/repo/deploy/deploy.sh` |
```

```bash
git add deploy/README.md
git commit -m "docs: record how a deploy is run"
```

---

## Task 9: backup และการกู้คืนที่ทดสอบแล้ว

**Files:**

- Create: `deploy/backup.sh`
- Create: `deploy/restore-check.sh`
- Create: `deploy/backup.env.example`
- Modify: `deploy/README.md`

**Interfaces:**

- Consumes: role `pos` ที่มี `CREATEDB` จาก Task 5
- Produces: `/var/backups/pos/pos-<วันเวลา>.dump` (เก็บ 7 วัน) · สำเนานอกเครื่องบน B2 (30 วัน)
  · `restore-check.sh` ที่คืน exit code ไม่ใช่ 0 เมื่อกู้ไม่สำเร็จ — Task 10 เอาทั้งสองไปใส่ cron

**สเปก §7.1 เขียนไว้ว่า _"backup ที่ไม่เคยกู้คือ backup ที่ยังไม่รู้ว่ามีจริงไหม"_** — task นี้จึงไม่จบที่
สคริปต์สำรองข้อมูล แต่จบที่สคริปต์ที่กู้คืนจริงทุกสัปดาห์แล้วบอกว่าสำเร็จหรือไม่

- [ ] **Step 1: ลง rclone แล้วตั้งค่า remote**

```bash
sudo -v; curl https://rclone.org/install.sh | sudo bash
sudo -u pos rclone config
```

ตอบตามนี้: `n` (new remote) → ชื่อ `b2` → เลือก Backblaze B2 → ใส่ Account ID กับ Application Key →
`q` เพื่อออก · ตรวจ:

```bash
sudo -u pos rclone lsd b2:
```

Expected: รายชื่อ bucket · **กุญแจอยู่ใน `/srv/pos/.config/rclone/rclone.conf` และห้ามเข้า git**

- [ ] **Step 2: เขียนแม่แบบ environment ของ backup**

สร้าง `deploy/backup.env.example`:

```bash
# → /etc/pos/backup.env   (chmod 600, chown pos:pos)
#
# Separate from api.env on purpose: the API has no business holding a password
# that can read every table from the shell, and the backup scripts have no
# business holding JWT_SECRET.
#
# libpq reads these directly, so pg_dump and psql need no arguments. Note this
# is NOT the Prisma DATABASE_URL — that one carries a ?schema=public parameter
# which libpq rejects as an unknown keyword.
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=pos
PGPASSWORD=REPLACE_WITH_DB_PASSWORD
PGDATABASE=pos

# Where the copies live.
BACKUP_DIR=/var/backups/pos
KEEP_LOCAL_DAYS=7
KEEP_REMOTE_DAYS=30
RCLONE_REMOTE=b2:<bucket-name>/pos
```

- [ ] **Step 3: เขียนสคริปต์ backup**

สร้าง `deploy/backup.sh`:

```bash
#!/usr/bin/env bash
#
# One dump a day, kept here for a week and off the machine for a month.
#
# The data lives in exactly one place now — there is no copy in the shop any
# more (spec §7.1). A VPS that is deleted, billed late, or compromised takes
# every bill, every wage and every payroll record with it unless this ran.
set -euo pipefail

set -a
# shellcheck disable=SC1091
. /etc/pos/backup.env
set +a

STAMP=$(date -u +%Y%m%d-%H%M)
FILE="${BACKUP_DIR}/pos-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

# -Fc (custom format) rather than plain SQL: it is compressed, and pg_restore
# can read a single table out of it without replaying the whole file, which is
# what you want at 07:00 when one table was wrecked and the shop opens at 10:00.
pg_dump -Fc --no-owner --file="$FILE"

# A dump that pg_restore cannot list is not a backup. Checking now costs a
# second; finding out later costs the shop's history.
pg_restore --list "$FILE" >/dev/null
echo "dumped $(du -h "$FILE" | cut -f1) to ${FILE}"

rclone copy "$FILE" "$RCLONE_REMOTE"
echo "copied off the machine to ${RCLONE_REMOTE}"

find "$BACKUP_DIR" -name 'pos-*.dump' -mtime "+${KEEP_LOCAL_DAYS}" -delete
rclone delete --min-age "${KEEP_REMOTE_DAYS}d" "$RCLONE_REMOTE"

echo "kept $(find "$BACKUP_DIR" -name 'pos-*.dump' | wc -l) local dumps"
```

- [ ] **Step 4: เขียนสคริปต์ทดสอบกู้คืน**

สร้าง `deploy/restore-check.sh`:

```bash
#!/usr/bin/env bash
#
# Restores the newest dump into a database nobody uses, checks that what came
# back is a real shop, and throws it away.
#
# This is the difference between having a backup and believing you have one.
# It runs weekly from cron (Task 10) and exits non-zero when anything is wrong,
# so a broken backup shows up as a failed job rather than as a discovery made
# on the worst morning of the year.
#
# It NEVER touches the live database. The name below is not `pos` and the
# script refuses to run if anyone changes that.
set -euo pipefail

set -a
# shellcheck disable=SC1091
. /etc/pos/backup.env
set +a

SCRATCH=pos_restore_check
REPO=/srv/pos/repo

if [ "$SCRATCH" = "$PGDATABASE" ]; then
	echo "!! refusing to restore over the live database" >&2
	exit 1
fi

NEWEST=$(find "$BACKUP_DIR" -name 'pos-*.dump' -type f -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
if [ -z "${NEWEST:-}" ]; then
	echo "!! no dump found in ${BACKUP_DIR}" >&2
	exit 1
fi
echo "checking ${NEWEST}"

cleanup() {
	dropdb --if-exists "$SCRATCH"
}
trap cleanup EXIT

dropdb --if-exists "$SCRATCH"
createdb "$SCRATCH"
pg_restore --no-owner --dbname="$SCRATCH" "$NEWEST"

ask() {
	psql --dbname="$SCRATCH" -tAc "$1"
}

BRANCHES=$(ask 'SELECT count(*) FROM branches;')
STAFF=$(ask 'SELECT count(*) FROM staff;')
APPLIED=$(ask "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")
ON_DISK=$(find "${REPO}/apps/api/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)

echo "branches=${BRANCHES} staff=${STAFF} migrations=${APPLIED}/${ON_DISK}"

# A shop with no branch or no staff did not restore — an empty database also
# restores without error, which is exactly the failure this exists to catch.
[ "$BRANCHES" -ge 1 ] || {
	echo "!! no branches in the restored database" >&2
	exit 1
}
[ "$STAFF" -ge 1 ] || {
	echo "!! no staff in the restored database" >&2
	exit 1
}
# Schema drift: a dump taken before a migration landed would restore fine and
# then fail to run the current code. Better to hear about it on a Sunday.
[ "$APPLIED" -eq "$ON_DISK" ] || {
	echo "!! the dump is ${APPLIED} migrations deep, the code expects ${ON_DISK}" >&2
	exit 1
}

echo "restore check passed"
```

- [ ] **Step 5: ติดตั้งบน VPS**

```bash
cd /srv/pos/repo && sudo -u pos git pull
sudo cp deploy/backup.env.example /etc/pos/backup.env
sudo chown pos:pos /etc/pos/backup.env && sudo chmod 600 /etc/pos/backup.env
sudo nano /etc/pos/backup.env      # เติมรหัสผ่านและชื่อ bucket
sudo mkdir -p /var/backups/pos && sudo chown pos:pos /var/backups/pos
```

- [ ] **Step 6: รัน backup จริงหนึ่งครั้ง**

```bash
sudo -u pos /srv/pos/repo/deploy/backup.sh
```

Expected: `dumped ... to /var/backups/pos/pos-....dump` · `copied off the machine to ...` ·
`kept 1 local dumps`

- [ ] **Step 7: รันการทดสอบกู้คืนจริงหนึ่งครั้ง — นี่คือขั้นที่สเปกเรียกร้อง**

```bash
sudo -u pos /srv/pos/repo/deploy/restore-check.sh
```

Expected: `branches=1 staff=1 migrations=N/N` แล้ว `restore check passed`

- [ ] **Step 8: พิสูจน์ว่ามันจับความล้มเหลวได้จริง**

```bash
sudo -u pos bash -c 'BACKUP_DIR=/tmp/empty-on-purpose /srv/pos/repo/deploy/restore-check.sh'; echo "exit=$?"
```

Expected: `!! no dump found in /tmp/empty-on-purpose` และ `exit=1` · สคริปต์ที่คืน 0 เสมอ
คือสคริปต์ที่ cron จะบอกว่าผ่านตลอดกาล

- [ ] **Step 9: ยืนยันว่าฐานข้อมูลจริงไม่ถูกแตะ**

```bash
sudo -u pos psql -h 127.0.0.1 -U pos -d pos -tAc 'SELECT count(*) FROM branches;'
sudo -u pos psql -h 127.0.0.1 -U pos -d postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = 'pos_restore_check';"
```

Expected: จำนวนสาขาเท่าเดิม แล้ว `0` (ฐานข้อมูลชั่วคราวถูกลบไปแล้วด้วย `trap`)

- [ ] **Step 10: commit**

```bash
chmod +x deploy/backup.sh deploy/restore-check.sh
git add deploy/backup.sh deploy/restore-check.sh deploy/backup.env.example deploy/README.md
git update-index --chmod=+x deploy/backup.sh deploy/restore-check.sh
git commit -m "feat: back the database up and prove the backup restores"
git push
```

เพิ่มสามแถวใน `deploy/README.md` ก่อน commit:

```markdown
| `backup.sh` | รันจาก cron ทุกวัน ตี 3 |
| `restore-check.sh` | รันจาก cron ทุกอาทิตย์ — กู้คืนจริงลงฐานข้อมูลทิ้ง |
| `backup.env.example` | คัดลอกเป็น `/etc/pos/backup.env` |
```

---

## Task 10: cron

**Files:**

- Create: `deploy/purge-sessions.sh`
- Create: `deploy/cron.d-pos`
- Modify: `deploy/README.md`

**Interfaces:**

- Consumes: `backup.sh` และ `restore-check.sh` จาก Task 9 · `/etc/pos/api.env` จาก Task 6
- Produces: งานตามเวลาสามอย่าง ที่ log ลง journal ภายใต้ tag `pos-backup` `pos-sessions` `pos-restore-check`

**บริบท:** `apps/api/scripts/purge-sessions.ts` เขียนไว้ตั้งแต่แผนที่ 2 พร้อมคอมเมนต์ว่า
_"Run from cron once a day — the schedule itself is deployment work and lands in plan 3"_ · task นี้คือ
ตารางเวลานั้น · สเปก §5.4 บอกว่าเก็บ session ที่หมดอายุไว้ 90 วันเพื่อการตรวจสอบย้อนหลัง
ซึ่ง `SESSION_RETENTION_DAYS` ถืออยู่แล้ว

- [ ] **Step 1: เขียนตัวห่อสำหรับล้าง session**

สร้าง `deploy/purge-sessions.sh`:

```bash
#!/usr/bin/env bash
#
# cron has no environment worth the name, and `pnpm sessions:purge` would need
# a PATH that finds a corepack shim. Calling the binary pnpm already linked
# skips both problems and cannot break when a PATH changes.
set -euo pipefail

set -a
# shellcheck disable=SC1091
. /etc/pos/api.env
set +a

cd /srv/pos/repo/apps/api
exec ./node_modules/.bin/tsx scripts/purge-sessions.ts
```

- [ ] **Step 2: เขียนตาราง cron**

สร้าง `deploy/cron.d-pos`:

```cron
# → /etc/cron.d/pos   (chmod 644, owner root — cron ignores files it does not like)
#
# Times are UTC, which on this machine is also what the database thinks in.
# 03:15 UTC is 10:15 in Bangkok — deliberately NOT the middle of the Thai
# night, because a backup that fails at 3am local time is a backup nobody sees
# fail. Mid-morning is quiet in this shop and somebody is awake.
#
# Every line pipes into logger, so the output lands in the journal:
#   journalctl -t pos-backup --since today
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Dump, verify, copy off the machine, prune. Daily.
15 3 * * * pos /srv/pos/repo/deploy/backup.sh 2>&1 | logger -t pos-backup

# Delete sessions that expired more than SESSION_RETENTION_DAYS ago. Daily,
# after the backup, so the rows it removes are already in a dump.
40 3 * * * pos /srv/pos/repo/deploy/purge-sessions.sh 2>&1 | logger -t pos-sessions

# Restore the newest dump into a scratch database and check it is a real shop.
# Weekly on Sunday. This is the line that turns "we have backups" into a fact.
10 4 * * 0 pos /srv/pos/repo/deploy/restore-check.sh 2>&1 | logger -t pos-restore-check
```

- [ ] **Step 3: ติดตั้ง**

```bash
cd /srv/pos/repo && sudo -u pos git pull
sudo cp deploy/cron.d-pos /etc/cron.d/pos
sudo chown root:root /etc/cron.d/pos && sudo chmod 644 /etc/cron.d/pos
sudo systemctl restart cron
```

- [ ] **Step 4: รันตัวห่อ session ด้วยมือหนึ่งครั้ง**

```bash
sudo -u pos /srv/pos/repo/deploy/purge-sessions.sh
```

Expected: `ลบเซสชันที่หมดอายุเกิน 90 วัน: 0 แถว` — ศูนย์ถูกต้องสำหรับร้านที่เพิ่งเปิด

- [ ] **Step 5: ยืนยันว่า cron อ่านไฟล์แล้ว**

```bash
sudo run-parts --test /etc/cron.daily >/dev/null; grep -c . /etc/cron.d/pos
sudo journalctl -u cron --since '5 minutes ago' --no-pager | tail -5
```

Expected: ไม่มีบรรทัดที่บ่นว่า `/etc/cron.d/pos` ผิดรูปแบบ · cron จะเงียบถ้าไฟล์ถูกต้อง
และจะ log ว่า `WRONG FILE OWNER` หรือ `bad minute` ถ้าไม่ถูก

- [ ] **Step 6: ทดสอบเส้นทาง log**

```bash
sudo -u pos bash -c '/srv/pos/repo/deploy/purge-sessions.sh 2>&1 | logger -t pos-sessions'
sudo journalctl -t pos-sessions --since '2 minutes ago' --no-pager
```

Expected: เห็นบรรทัดภาษาไทยของ purge อยู่ใน journal · ถ้าไม่เห็น cron จะรันสำเร็จโดยไม่มีใครรู้ผล
ซึ่งเท่ากับไม่ได้รัน

- [ ] **Step 7: commit**

```bash
chmod +x deploy/purge-sessions.sh
git add deploy/purge-sessions.sh deploy/cron.d-pos deploy/README.md
git update-index --chmod=+x deploy/purge-sessions.sh
git commit -m "feat: schedule the backup, the purge and the restore check"
git push
```

เพิ่มสองแถวใน `deploy/README.md`:

```markdown
| `purge-sessions.sh` | รันจาก cron ทุกวัน |
| `cron.d-pos` | `/etc/cron.d/pos` (เจ้าของ root, chmod 644) |
```

---

## Task 11: Raspberry Pi และจอครัวออกอินเทอร์เน็ต

**Files:**

- Modify: `apps/print-agent/.env.example`
- Modify: `apps/print-agent/src/config.ts` (คอมเมนต์ของ `POLL_INTERVAL_MS`)
- Test: `apps/print-agent/src/config.test.ts` (เพิ่ม 1 ตัว)

**Interfaces:**

- Consumes: `PRINT_AGENT_TOKEN` จาก `/etc/pos/api.env` (Task 6) — ต้องเป็นค่าเดียวกันบน Pi
- Produces: Pi ที่ดึงงานพิมพ์ผ่าน https · จอครัวที่ต่อ `wss://shop.<domain>/api/live`

**บริบท:** สเปก §4.2 เขียนว่า _"จอครัว (WebSocket) และ Raspberry Pi (ดึงงานพิมพ์) เคยคุยกันในวงแลน
ตอนนี้ต้องวิ่งออกเน็ตทั้งคู่"_ · ฝั่งจอครัวไม่ต้องแก้อะไรเลย เพราะ `liveSocketUrl()`
(`apps/web/src/api-client.ts:73`) แปลง `/api` เป็น `wss://` ให้เองตามโปรโตคอลของหน้าเว็บ ·
ฝั่ง Pi ต้องแก้ที่อยู่ และควรทบทวนจังหวะการถาม

- [ ] **Step 1: เขียนเทสต์ของค่าตั้งต้นที่ยังไม่ผ่าน**

ต่อท้าย `describe('loadConfig', ...)` ใน `apps/print-agent/src/config.test.ts` ก่อนวงเล็บปิด
(`VALID` ที่บรรทัด 4 ของไฟล์นั้นมีแค่ `PRINT_AGENT_TOKEN` อยู่แล้ว):

```ts
it('takes an https API address, because the Pi is outside the shop wifi now', () => {
  // Not a new capability — z.string().url() has always accepted it. Locked
  // down here because the address is about to change on a machine with no
  // screen, and a schema that quietly stopped accepting https would surface
  // as "the printer died" over SSH during service.
  const config = loadConfig({ ...VALID, API_URL: 'https://shop.example.com/api' });
  expect(config.API_URL).toBe('https://shop.example.com/api');
});
```

- [ ] **Step 2: รันเทสต์**

```bash
pnpm --filter @pos/print-agent test
```

Expected: PASS · **คาดหวัง: 16 ผ่าน** (15 + 1) · ถ้าแดงเพราะชื่อไม่ตรง ให้แก้ชื่อในเทสต์ให้ตรงกับไฟล์จริง

- [ ] **Step 3: แก้ `.env.example` ของ print agent**

ใน `apps/print-agent/.env.example` แก้บล็อกของ `API_URL` เป็น:

```bash
# The POS API.
#   in the shop, during development : http://localhost:3001/api
#                                     or the LAN IP of the machine running it
#   on the real Pi                   : https://shop.<domain>/api
#
# https on the Pi is not optional. PRINT_AGENT_TOKEN is a bearer secret and it
# now crosses the open internet on every poll; over http anyone between the
# shop's router and the VPS could lift it and start claiming print jobs.
API_URL="http://localhost:3001/api"
```

และแก้บล็อกท้ายไฟล์:

```bash
# How often to ask for work. 1500ms is right on a LAN. Over the internet each
# poll is a TLS round trip to another country, so 3000 is the value for a Pi
# outside the same building — that is still a slip appearing within three
# seconds of the cashier pressing the button, which nobody in a kitchen can
# tell apart from instant.
POLL_INTERVAL_MS=1500
PRINTER_TIMEOUT_MS=5000
```

- [ ] **Step 4: เติมคอมเมนต์ใน `config.ts`**

เหนือบรรทัด `POLL_INTERVAL_MS` ใน `apps/print-agent/src/config.ts` ใส่:

```ts
/**
 * Raise this to 3000 when the agent is outside the building.
 *
 * Every poll is a full TLS round trip now, not a packet across a switch. The
 * default stays at the LAN value because that is what a developer running
 * this on their laptop wants, and the Pi's own .env is the right place for
 * the deployment's answer.
 */
```

- [ ] **Step 5: กวาดแล้ว commit**

```bash
pnpm test && pnpm typecheck && npx eslint . && npx prettier --check .
git add apps/print-agent/.env.example apps/print-agent/src/config.ts apps/print-agent/src/config.test.ts
git commit -m "feat: point the print agent at the shop's real address"
git push
```

Expected: **คาดหวังรวม 1,227 ผ่าน** (1,226 + 1)

- [ ] **Step 6: ตั้งค่าบน Pi จริง**

บน Raspberry Pi แก้ `apps/print-agent/.env`:

```bash
API_URL="https://shop.<domain>/api"
PRINT_AGENT_TOKEN="<ค่าเดียวกับใน /etc/pos/api.env>"
POLL_INTERVAL_MS=3000
```

แล้วรีสตาร์ต agent

- [ ] **Step 7: ตรวจว่าพิมพ์ออกจริง**

สั่งพิมพ์ใบเสร็จหนึ่งใบจากแท็บเล็ต

Expected: กระดาษออกภายในไม่กี่วินาที · ถ้าไม่ออก ดู log ของ agent — บรรทัด `api: https://...`
ตอนเริ่มต้น (`apps/print-agent/src/index.ts:27`) บอกว่ามันกำลังคุยกับที่ไหน

- [ ] **Step 8: ตรวจจอครัว**

เปิดจอครัวบนแท็บเล็ต แล้วส่งรายการเข้าครัวจากอีกเครื่อง

Expected: การ์ดขึ้นทันทีโดยไม่ต้องรีเฟรช · ใน DevTools → Network → WS ต้องเห็นการเชื่อมต่อไปที่
`wss://shop.<domain>/api/live` (ไม่ใช่ `ws://`) และสถานะ 101

---

## Task 12: เอกสาร

**Files:**

- Modify: `README.md` (เพิ่มหัวข้อ "ขึ้นเซิร์ฟเวอร์จริง" หลัง "รันระบบ")
- Create: `docs/runbook.md`
- Modify: `docs/superpowers/specs/2026-08-06-back-office-split-design.md` (§7.4 บันทึกสิ่งที่ต่างจากสเปก)
- Modify: `docs/superpowers/plans/2026-08-17-back-office-split-part3-deploy.md` (ติ๊กช่องและบันทึกผลจริง)

- [ ] **Step 1: วัดเลขจริงก่อนเขียน**

```bash
pnpm build && pnpm test 2>&1 | grep -E "Test Files|Tests "
```

จดตัวเลขที่ได้จริงต่อ package แล้วใช้ตัวเลขนั้น ไม่ใช่ตัวเลขที่แผนนี้ทาย

- [ ] **Step 2: เขียน runbook**

สร้าง `docs/runbook.md` — เอกสารที่คนอ่านตอนตกใจ ไม่ใช่ตอนว่าง จึงขึ้นต้นด้วยอาการ ไม่ใช่ด้วยสถาปัตยกรรม:

````markdown
# เมื่อมีอะไรผิดปกติ

เรียงตามความเร่งด่วน อาการก่อน สาเหตุทีหลัง

## ร้านขายไม่ได้ — แท็บเล็ตขึ้นว่าออฟไลน์

ระบบนี้รับเงินตอนออฟไลน์ไม่ได้โดยการออกแบบ (สเปก §8.1) "เน็ตล่ม" จึงเท่ากับ "หยุดขาย"

1. เน็ตร้านล่มหรือเซิร์ฟเวอร์ล่ม? เปิด `https://shop.<domain>/api/health` จากมือถือที่ใช้ 4G
   - เปิดได้ → เน็ตร้าน · **สลับไปเราเตอร์ 4G สำรอง** แล้วขายต่อ
   - เปิดไม่ได้ → ข้อ 2

2. ssh เข้าเครื่องแล้วดู:

   ```bash
   sudo systemctl status pos-api caddy postgresql --no-pager
   sudo journalctl -u pos-api -n 50 --no-pager
   ```

3. บริการไหนตาย สั่งขึ้นใหม่: `sudo systemctl restart <ชื่อ>`

4. ดิสก์เต็มหรือเปล่า — สาเหตุที่พบบ่อยที่สุดของ "ทุกอย่างพร้อมกัน":

   ```bash
   df -h /
   ```

   ถ้าเต็ม ลบ dump เก่าใน `/var/backups/pos/` (สำเนา 30 วันอยู่บน B2 แล้ว)

## เจ้าของล็อกอินหลังร้านไม่ได้

- **"ลองเข้าสู่ระบบถี่เกินไป"** → ตัวจำกัดต่อ IP 10 ครั้ง/นาที รอ 1 นาที
- **"บัญชีถูกล็อก"** → ใส่รหัสผิดครบโควตา รอตามเวลาที่จอบอก หรือให้คนที่มีสิทธิ์ตั้งรหัสใหม่ให้ที่หน้าพนักงาน
  (การตั้งรหัสใหม่จะล้างตัวนับให้ด้วย)
- **ลืมรหัสผ่านและไม่มีใครเข้าได้เลย** → ตั้งใหม่จากเครื่อง ดูหัวข้อถัดไป

## ตั้งรหัสผ่านหลังร้านใหม่จากเครื่อง

ทำเมื่อไม่มีใครเข้าหลังร้านได้แล้วจริง ๆ เท่านั้น

```bash
cd /srv/pos/repo/apps/api
sudo -u pos nano .env      # ใส่ DATABASE_URL, OWNER_EMAIL, OWNER_PASSWORD
sudo -u pos pnpm db:seed   # รันซ้ำไม่ทับของเดิม ยกเว้นที่ระบุ
sudo -u pos rm .env
```

รหัสผ่านต้องเจ้าของเป็นคนพิมพ์ · ลบไฟล์ `.env` ทิ้งทันทีหลังเสร็จ

## กู้ฐานข้อมูลคืน

`restore-check.sh` ทำแบบนี้ทุกอาทิตย์อยู่แล้ว ต่างกันแค่ปลายทาง

```bash
sudo systemctl stop pos-api
sudo -u pos bash -c 'set -a; . /etc/pos/backup.env; set +a
  pg_dump -Fc --no-owner --file=/var/backups/pos/before-restore-$(date -u +%Y%m%d-%H%M).dump
  dropdb pos && createdb pos
  pg_restore --no-owner --dbname=pos /var/backups/pos/<ไฟล์ที่ต้องการ>'
sudo systemctl start pos-api
curl -s http://127.0.0.1:3001/api/health/db
```

**ดัมป์ของปัจจุบันก่อนเสมอ** แม้จะรู้ว่ามันเสีย — ข้อมูลที่เสียบางส่วนยังกู้ทีละตารางได้
ข้อมูลที่ถูกทับไปแล้วไม่เหลืออะไร

ถ้าไฟล์ในเครื่องหายไปด้วย ดึงจากนอกเครื่อง:

```bash
sudo -u pos rclone copy b2:<bucket>/pos/<ไฟล์> /var/backups/pos/
```

## deploy โค้ดใหม่

```bash
sudo -u pos /srv/pos/repo/deploy/deploy.sh
```

ล้มกลางทางแล้วเว็บพัง — ย้อนกลับด้วยการ deploy commit เก่า:

```bash
cd /srv/pos/repo && sudo -u pos git reset --hard <commit-เก่า> && sudo -u pos ./deploy/deploy.sh
```

**การย้อน migration ไม่ได้ย้อนตาม** ถ้า commit ที่พังมี migration ที่รันไปแล้ว ต้องกู้ฐานข้อมูลคืนด้วย

## ตรวจว่างานตามเวลายังทำงานอยู่

```bash
journalctl -t pos-backup --since '2 days ago'
journalctl -t pos-restore-check --since '8 days ago'
journalctl -t pos-sessions --since '2 days ago'
ls -lh /var/backups/pos/
```

ถ้า `pos-restore-check` ไม่มีอะไรเลยใน 8 วัน แปลว่าไม่มีใครรู้ว่า backup ใช้ได้ไหม
ให้รันด้วยมือทันที: `sudo -u pos /srv/pos/repo/deploy/restore-check.sh`

## ใบรับรอง https ใกล้หมดอายุ

Caddy ต่ออายุเอง ไม่ต้องทำอะไร ถ้าเบราว์เซอร์เตือนจริง:

```bash
sudo journalctl -u caddy --since '2 days ago' | grep -i cert
```

สาเหตุที่พบเกือบทุกครั้งคือ DNS ถูกแก้ไปที่อื่น หรือพอร์ต 80 ถูกปิด (ต้องเปิดไว้ให้ Let's Encrypt)
````

- [ ] **Step 3: เพิ่มหัวข้อใน README**

ใส่หลังหัวข้อ `## รันระบบ` (ก่อน `### หน้าจอที่มี`) ใน `README.md`:

```markdown
## ขึ้นเซิร์ฟเวอร์จริง

เครื่องเดียว: Caddy ถือใบรับรองของสอง subdomain แล้วส่ง `/api/*` ของทั้งคู่ไป Node ตัวเดียวที่
`127.0.0.1:3001` — ได้ same-origin จึงไม่ต้องมี CORS และคุกกี้ของสองเว็บแยกกันเองตามโดเมน

    VPS 1 เครื่อง
    ├── Caddy ── shop.<domain>  ── /  → /srv/www/shop   · /api/* → 127.0.0.1:3001
    │            └ office.<domain> ── /  → /srv/www/office · /api/* → ตัวเดียวกัน
    ├── pos-api.service (Node, ผูกกับ 127.0.0.1 เท่านั้น)
    └── PostgreSQL 16 (ฟังแค่ 127.0.0.1)

**API ผูกกับ `127.0.0.1` และนั่นคือสิ่งที่ทำให้ `TILL_HOSTS` มีความหมาย** — `Host` เป็นค่าที่คนยิงเลือกเอง
มันจึงเป็นกำแพงได้ก็ต่อเมื่อเข้าถึง API ตรง ๆ ไม่ได้เลย ถ้าวันหนึ่งมีคนเปลี่ยน `HOST` กลับเป็น `0.0.0.0`
`/auth/staff` จะเปิดให้ทุกคนอีกครั้งโดยไม่มีอะไรฟ้อง

- deploy: `sudo -u pos /srv/pos/repo/deploy/deploy.sh`
- ไฟล์คอนฟิกทั้งหมดอยู่ใน [`deploy/`](deploy/) พร้อมคำอธิบายว่าแต่ละไฟล์ไปอยู่ที่ไหน
- อาการผิดปกติและวิธีแก้: [`docs/runbook.md`](docs/runbook.md)
- backup: `pg_dump` ทุกวัน เก็บในเครื่อง 7 วัน บน B2 30 วัน และ **กู้คืนจริงทุกอาทิตย์**
  ด้วย `restore-check.sh` ที่ตรวจว่าข้อมูลที่ได้กลับมาเป็นร้านจริง ไม่ใช่ฐานข้อมูลเปล่าที่ restore ผ่าน
```

- [ ] **Step 4: อัปเดตตารางเทสต์ใน README**

แก้ตัวเลขในหัวข้อ `## เทสต์` ให้ตรงกับที่วัดได้ใน Step 1

- [ ] **Step 5: บันทึกสิ่งที่ต่างจากสเปกลงในสเปก**

เพิ่ม `### 7.4 สิ่งที่ต่างจากที่เขียนไว้ในข้อ 7 (บันทึกหลังลงมือจริง)` ต่อท้าย §7.3 ในไฟล์สเปก
โดยเขียนถึงอย่างน้อยสามเรื่องนี้ พร้อมเรื่องอื่นที่เจอระหว่างทาง:

- **`request.ip` พังทันทีที่มี proxy** — สเปก §5.5 สั่งให้จำกัดการลองผิดต่อ IP แต่ไม่ได้พูดถึงว่า
  ค่านั้นมาจากไหนเมื่อมี reverse proxy คั่น · ถ้าไม่แก้ ตัวจำกัดจะกลายเป็นถังเดียวของทั้งอินเทอร์เน็ต
  ซึ่งแย่กว่าไม่มี เพราะมันกลายเป็นปุ่มปิดร้านที่ใครก็กดได้
- **PostgreSQL ไม่ได้ใช้ Docker บนเครื่องจริง** ทั้งที่ dev ใช้ · เหตุผลหลักคือ Docker เขียนกฎ iptables
  ที่อยู่ก่อน ufw ทำให้ `ports:` เปิดพอร์ตทะลุกำแพงไฟที่คนตั้งไว้
- **§7.3 เทสต์ flaky แก้ไปแล้วก่อนถึงแผนนี้** — `PayrollPage.test.tsx` ตัวที่ commit วันทำงานตอน blur
  ถูกครอบด้วย `waitFor` และย้ายไปอยู่ `apps/office` เรียบร้อยตั้งแต่แผนที่ 1 · แผนที่ 3 จึงไม่มี task สำหรับมัน

- [ ] **Step 6: ติ๊กช่องและบันทึกผลจริงในแผนนี้**

ไล่ทุก task ในไฟล์นี้ ติ๊ก `- [x]` และเติมบล็อก `> **ผลจริง 2026-xx-xx**` ตรงที่ของจริงไม่ตรงกับที่แผนเขียนไว้
แล้วรวมทุกความต่างเป็นตารางเดียวท้าย Task 12 ตามแบบที่แผนที่ 2 ทำไว้

- [ ] **Step 7: จัดรูปแบบแล้วกวาด**

```bash
npx prettier --write README.md docs/runbook.md docs/superpowers/specs/*.md docs/superpowers/plans/*.md
pnpm build && pnpm test && pnpm typecheck && npx eslint . && npx prettier --check .
```

Expected: เขียวทั้งหมด

- [ ] **Step 8: commit**

```bash
git add README.md docs/runbook.md docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: write down how the server is built and what to do when it breaks"
git push
```

---

## Definition of Done

ก้อนนี้ (สเปก §1) จบเมื่อทุกข้อต่อไปนี้เป็นจริง — ตรวจด้วยคำสั่ง ไม่ใช่ด้วยความรู้สึก

| #   | ต้องเป็นจริง                                                          | ตรวจยังไง                                                                             |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `https://shop.<domain>` เปิดได้ ใบรับรองถูกต้อง                       | `curl -sI https://shop.<domain>/ \| head -1` → `HTTP/2 200`                           |
| 2   | `https://office.<domain>` เปิดได้ ใบรับรองถูกต้อง                     | เหมือนข้อ 1                                                                           |
| 3   | เจ้าของล็อกอินหลังร้านจากนอกร้านได้ และ**บันทึกจ่ายเงินเดือนได้จริง** | ทำจริงจากมือถือที่ใช้ 4G                                                              |
| 4   | หน้าล็อกอินหลังร้านไม่มีรายชื่อพนักงาน                                | ดูด้วยตา + `curl https://office.<domain>/api/auth/staff` → 404                        |
| 5   | API เข้าถึงจากภายนอกไม่ได้                                            | `curl --max-time 5 http://<vps-ip>:3001/api/health` → ล้มเหลว                         |
| 6   | ฐานข้อมูลเข้าถึงจากภายนอกไม่ได้                                       | `nc -vz -w 5 <vps-ip> 5432` → ล้มเหลว                                                 |
| 7   | ตัวจำกัดต่อ IP แยกคนละเครื่องได้จริงหลังผ่าน proxy                    | ใส่รหัสผิด 11 ครั้งจากเน็ตหนึ่ง → 429 · แล้วลองจากอีกเน็ตหนึ่งทันที → ไม่ใช่ 429      |
| 8   | จอครัวอัปเดตสดผ่าน `wss://`                                           | DevTools → Network → WS → 101                                                         |
| 9   | Raspberry Pi พิมพ์ได้ผ่าน https                                       | สั่งพิมพ์ใบเสร็จหนึ่งใบ                                                               |
| 10  | backup ทำงานอัตโนมัติ                                                 | `ls /var/backups/pos/` มีไฟล์ของเมื่อวาน + `rclone ls b2:<bucket>/pos`                |
| 11  | **การกู้คืนถูกทดสอบแล้วและผ่าน**                                      | `sudo -u pos ./deploy/restore-check.sh` → `restore check passed`                      |
| 12  | session ที่หมดอายุถูกล้างตามเวลา                                      | `journalctl -t pos-sessions --since '2 days ago'`                                     |
| 13  | CI เขียวบน `main`                                                     | `gh run list --branch main --limit 1`                                                 |
| 14  | เทสต์ทั้งหมดเขียว ≥ 1,227                                             | `pnpm build && pnpm test`                                                             |
| 15  | เราเตอร์ 4G สำรองพร้อมใช้                                             | ทดสอบสลับจริงหนึ่งครั้งขณะร้านปิด — ข้อกำหนดปฏิบัติการตามสเปก §8.1 ไม่ใช่งานเขียนโค้ด |

**ข้อ 11 กับข้อ 15 เป็นสองข้อที่ตกหล่นง่ายที่สุด** เพราะเป็นข้อเดียวที่ระบบไม่บอกเองว่ายังไม่ได้ทำ
ทุกข้ออื่นมีอาการเมื่อไม่ได้ทำ สองข้อนี้ไม่มี จนถึงวันที่จำเป็น

---

## สิ่งที่แผนนี้จงใจไม่ทำ

| ไม่ทำ                                   | เพราะ                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| CD (deploy อัตโนมัติจาก CI)             | สเปก §7.2 ขอแค่ให้ CI รันเทสต์ · การให้ GitHub มีกุญแจ ssh ของเครื่องที่เก็บเงินเดือนกับเลขพาสปอร์ต เป็นความเสี่ยงที่ต้องคุยแยก |
| Blue-green หรือ zero-downtime deploy    | `restart` ใช้เวลาไม่ถึงวินาที และ deploy ทำตอนร้านปิด · ระบบที่ขายตอนออฟไลน์ไม่ได้อยู่แล้ว (§8.1) ไม่ได้กำไรจากความซับซ้อนนี้   |
| Monitoring/alert (Uptime Kuma, Grafana) | `journalctl` กับ health endpoint พอสำหรับร้านเดียว · การเตือนที่ไม่มีคนรับก็คือ log ที่แพงกว่าเดิม                              |
| Log rotation แยก                        | ทุกอย่างลง journald ซึ่งจำกัดขนาดตัวเองอยู่แล้ว                                                                                 |
| E2E (Playwright)                        | สเปก §3 ระบุว่าไม่อยู่ในก้อนนี้                                                                                                 |
| แก้ "รับเงินตอนออฟไลน์"                 | สเปก §8.1 — งานใหญ่ของตัวเอง ต้องออกแบบเลขเอกสารต่อเครื่องก่อน                                                                  |
| 2FA                                     | สเปก D8 — คอลัมน์ `totpSecret` สร้างรอไว้แล้ว ยังไม่ใช้                                                                         |

---

## หลังจบแผนนี้

ก้อนที่ 1 ของโรดแมป (สเปก §9) จบครบทั้งสามแผน · ก้อนถัดไปคือ **Dashboard วิเคราะห์ยอดขาย**
ซึ่งไม่มีตารางใหม่ ข้อมูลอยู่ใน `OrderLine` ครบแล้ว และเป็นก้อนแรกที่ได้ประโยชน์เต็ม ๆ จากการที่
`apps/office` เป็นแอปแยก — ไลบรารีวาดกราฟ 150–300 KB เข้าไปอยู่ในบันเดิลของแท็บเล็ตไม่ได้เชิงกายภาพ
ซึ่งเป็นเหตุผลข้อแรกที่สเปก §4.1 ใช้ตัดสินใจแยกแอปตั้งแต่ต้น
