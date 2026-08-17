/**
 * The boundary between the two sites, checked against what actually shipped.
 *
 * This reads the BUILT output, not the source, because the mistake it exists
 * to catch is a build-config mistake: a payroll screen that lands on the till's
 * disk looks completely normal in the source tree and completely normal on a
 * desk with wifi. It only shows up at 12:30 when the tablet is full of code it
 * has no business holding.
 *
 * The split into two apps is a stronger fence than the lazy chunk it replaced —
 * the till cannot ship what it does not import — but "stronger" is not "self
 * enforcing". One relative import that climbs out of apps/office, or one
 * VitePWA() added to the office config by someone tidying up, puts it back.
 *
 * Run `pnpm build` first. These skip themselves rather than fail when dist/ is
 * missing, so a fresh clone running `pnpm test` is not greeted by a red suite
 * it cannot fix by writing code.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const TILL_DIST = join(SRC, '..', 'dist');
const OFFICE_DIST = join(SRC, '..', '..', 'office', 'dist');
const OFFICE_PKG = join(SRC, '..', '..', 'office', 'package.json');

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

/**
 * Every shipped .js, concatenated. The .map files sitting next to them are
 * deliberately NOT read: a sourcemap carries the original identifiers, so
 * searching one would report a name the browser never receives.
 */
const shippedJs = (dist: string): string =>
  filesUnder(dist)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

suite('the till bundle', () => {
  it('carries no back-office screen', () => {
    // Strings that exist only in apps/office. Thai UI text rather than
    // component names: minification renames functions, so `PayrollPage` may
    // not survive the build even when the whole screen does — a test that
    // passes because esbuild shortened an identifier proves nothing. The
    // labels a person reads are shipped verbatim.
    //
    // Each of these was checked to be present in the OFFICE bundle before
    // being trusted here, which is the half that is easy to skip: a sentinel
    // that is in neither bundle passes forever and guards nothing. The
    // obvious candidate "เงินเดือน" is deliberately absent from the list — it
    // ships in both, from an expense-category hint in @pos/shared.
    const officeOnly = ['กำไรขาดทุน', 'รายการหักเงิน', 'ทุกสาขา', 'สลิปเงินเดือน'];
    const js = shippedJs(TILL_DIST);

    // The offenders are collected and compared, rather than asserted one by
    // one with `expect(js).not.toContain(...)`. That form fails by printing
    // the haystack — half a megabyte of minified workbox — and a test whose
    // failure is unreadable is a test that gets deleted instead of read.
    expect(officeOnly.filter((label) => js.includes(label))).toEqual([]);
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

  it('precaches everything the precached code statically imports', () => {
    /**
     * THE TEST THAT WOULD HAVE CAUGHT THE OLD BUG.
     *
     * Before the split, the till's precache measured a tidy 326 KiB and every
     * assertion about it passed — while the precached entry chunk opened with
     * `import{...50 bindings...}from"./office-BOHpDUEF.js"`, a 390 kB chunk
     * that `globIgnores` deliberately kept OUT of the precache. Pinning the
     * office to a named chunk had made rollup hoist React, the router and
     * @pos/shared into it and leave the entry importing them back.
     *
     * A tablet with a cold cache and no signal would have asked for that file,
     * got nothing, and shown a white screen — the exact failure the precache
     * exists to prevent. The old checks all passed because they asked "is the
     * entry chunk precached?" and never "can the entry chunk RUN from the
     * precache?"
     *
     * A precache is only worth its size if it is closed under static imports.
     */
    const sw = readFileSync(join(TILL_DIST, 'sw.js'), 'utf8');
    const precached = new Set([...sw.matchAll(/assets\/[^"']+\.js/g)].map((m) => m[0]));

    const missing: string[] = [];
    for (const url of precached) {
      const text = readFileSync(join(TILL_DIST, url), 'utf8');
      // Static imports only. A dynamic import() may legitimately point at
      // something uncached — that is what "lazy" means — but a static one is
      // a hard dependency the browser resolves before running a line.
      for (const [, spec] of text.matchAll(/(?:^|[;}])\s*import\s*[^;]*?from\s*"\.\/([^"]+)"/g)) {
        const asAsset = `assets/${spec}`;
        if (!precached.has(asAsset)) missing.push(`${url} -> ${asAsset}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('still ships a service worker at all', () => {
    // The inverse mistake: making the assertions above pass by breaking the
    // PWA, which would take the till offline-capability with it.
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
    expect(existsSync(join(OFFICE_DIST, 'registerSW.js'))).toBe(false);
    // .includes() rather than not.toContain(), for the same reason as below:
    // the failure message should be `false`, not the entire bundle.
    expect(shippedJs(OFFICE_DIST).includes('serviceWorker')).toBe(false);
  });

  it('declares no local-database dependency', () => {
    // Checked against the manifest rather than by grepping the bundle for
    // "indexedDB": that string turns up inside unrelated vendor code and the
    // false positive would get the whole test deleted by whoever hits it.
    const pkg = JSON.parse(readFileSync(OFFICE_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(declared).not.toContain('dexie');
    expect(declared).not.toContain('fake-indexeddb');
    expect(declared).not.toContain('vite-plugin-pwa');
  });

  it("does not reach across into the till's offline layer", () => {
    // A separate package, so this should not compile — but a relative path
    // that climbs out of apps/office would, and this is the cheap guard.
    // Again by shipped text, not identifier: these are the words on the sync
    // bar, which only exists because the till has an outbox to report on.
    const tillOnly = ['กำลังส่งข้อมูลที่ค้างไว้', 'ทิ้งการแก้ไขบน', 'ออฟไลน์'];
    const js = shippedJs(OFFICE_DIST);

    expect(tillOnly.filter((label) => js.includes(label))).toEqual([]);
  });
});

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
