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
 * No manualChunks either. The till needed one to pin a chunk NAME so the
 * precache exclusion could match it; with the office in its own site there is
 * nothing left to exclude, so the pinning is gone and rollup splits normally.
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
