/**
 * The fence around the till.
 *
 * Every other test in this app renders something and asserts what a person
 * sees. This one reads source files and the built service worker, because the
 * two mistakes it guards against are invisible on a desk and only appear on a
 * tablet with no signal:
 *
 *   1. A back-office screen gets precached onto the till. Nothing breaks —
 *      the tablet just carries the payroll screen it will never open, and
 *      carries the next five back-office features too. Slow rot, no symptom.
 *
 *   2. A till screen becomes lazy, or the office chunk stops being excluded.
 *      This one is not slow: `import()` rejects with no connection, and the
 *      bill will not open at 12:30. Both halves of "lazy and precached are
 *      opposites" are checked here, in that direction.
 *
 * The service-worker assertions need a build. `pnpm build` runs before
 * `pnpm test` in the verification sequence, so in practice dist is there; if
 * it is not, those cases skip rather than failing a fresh clone, and the
 * source-level cases below still run and still catch a lazy till screen.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const DIST = join(SRC, '..', 'dist');

function sourcesUnder(...dirs: string[]): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string, label: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${label}/${entry.name}`);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.'))
        out.push({ file: `${label}/${entry.name}`, text: readFileSync(full, 'utf8') });
    }
  };
  for (const dir of dirs) walk(join(SRC, dir), dir);
  return out;
}

/** every module specifier a file imports, however it spells it */
function specifiersIn(text: string): string[] {
  return [...text.matchAll(/(?:from\s+'|import\s*\(\s*'|vi\.mock\(\s*')([^']+)'/g)].map(
    (m) => m[1]!,
  );
}

/* ------------------------------------------------------------------ */
/* source: what may reach what                                         */
/* ------------------------------------------------------------------ */

describe('the back office cannot reach the offline layer', () => {
  it('no office screen imports IndexedDB or the outbox', () => {
    // A back-office screen reading the local mirror would be showing figures
    // from a cache that is only ever as fresh as the last sync — and a payroll
    // total or a P&L computed from a stale cache is a wrong number that looks
    // exactly like a right one. These screens are online-only by design; this
    // is what stops that decision quietly eroding one import at a time.
    const offenders = sourcesUnder('pages/office', 'components/office')
      .filter(({ text }) => specifiersIn(text).some((s) => s.includes('offline/')))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe('the till cannot reach the back office', () => {
  it('no till screen imports an office module', () => {
    // This is the import that would undo the whole split without any visible
    // symptom: one till screen importing one office component drags the
    // office chunk back into the precached bundle, and the tablet is carrying
    // the payroll screen again.
    const offenders = sourcesUnder('pages/pos')
      .filter(({ text }) => specifiersIn(text).some((s) => s.includes('office/')))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe('no till screen is lazy', () => {
  it('the only dynamic import in the app shell is the back office', () => {
    // A lazy chunk that is not precached cannot be fetched with no signal.
    // For the office that is intended and handled; for anything under /pos it
    // means the screen does not open, and it will pass every test on a desk.
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const dynamic = [...app.matchAll(/import\s*\(\s*'([^']+)'/g)].map((m) => m[1]!);

    expect(dynamic).toEqual(['./pages/office/routes.js']);
  });
});

/* ------------------------------------------------------------------ */
/* build: what actually lands on the tablet                            */
/* ------------------------------------------------------------------ */

const built = existsSync(join(DIST, 'sw.js'));

describe.skipIf(!built)('the service worker precache', () => {
  const sw = built ? readFileSync(join(DIST, 'sw.js'), 'utf8') : '';
  const precached = [...sw.matchAll(/"(assets\/[^"]+)"/g)].map((m) => m[1]!);
  const assets = built ? readdirSync(join(DIST, 'assets')) : [];

  it('carries the till', () => {
    // If this ever empties, the app stopped working offline altogether.
    expect(precached.some((f) => /^assets\/index-.*\.js$/.test(f))).toBe(true);
  });

  it('does not carry the back office', () => {
    expect(precached.filter((f) => f.includes('office-'))).toEqual([]);
  });

  it('still SHIPS the back office, it just does not cache it', () => {
    // The other way to make the previous assertion pass is to break the office
    // build entirely, which would also stop it loading online.
    expect(assets.filter((f) => /^office-.*\.js$/.test(f)).length).toBe(1);
  });
});
