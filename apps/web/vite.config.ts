import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: false },
      workbox: {
        /**
         * Everything built here is precached, and that is now the whole rule.
         *
         * There used to be a `globIgnores` line keeping the back office out,
         * because vite-plugin-pwa precaches every js and css file it finds —
         * a lazy chunk alone would not have kept the payroll screen off the
         * tablet, workbox would have downloaded it at install and held it
         * forever. Two settings had to agree, and the day they stopped
         * agreeing nothing would have said so.
         *
         * The office is a separate site now, so there is nothing left in this
         * build to exclude. Precaching everything is correct BECAUSE what is
         * here is only the till: if that stops being true, the fix is to move
         * the screen out, not to add an exclusion back.
         */
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        /**
         * The app shell answers ANY route from the cache (Step 4).
         *
         * Without this, a tablet that is offline and lands on /order/<uuid> —
         * which is where it lands after every reload, because that is the page
         * the cashier was on — asks the server for that path and gets nothing.
         * The bills are all safely in IndexedDB and the screen that can read
         * them never loads. The fallback makes the shell come from disk and
         * the router take it from there.
         */
        navigateFallback: 'index.html',
        // ...except /api, which must never be served a cached HTML page: a
        // stale price on a bill is worse than an honest error.
        navigateFallbackDenylist: [/^\/api/],
      },
      manifest: {
        name: 'POS',
        short_name: 'POS',
        description: 'ระบบขายหน้าร้าน',
        lang: 'th',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        // Tablets are mounted landscape on the counter.
        orientation: 'landscape',
        start_url: '/',
        // Both sizes are required before Android will offer "install to home
        // screen" at all — an app the tablet cannot install is an app that
        // still has a browser address bar eating a row of the till.
        // "maskable" lets Android crop them to its own icon shape without
        // slicing the bowl, which is why the glyph sits inside the middle 60%.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // Lets the tablet on the shop wifi reach the dev server by LAN IP.
    host: true,
  },
  /**
   * No `manualChunks`. There used to be one, and it was not for speed — it
   * pinned the back office to a chunk NAMED "office" so the precache exclusion
   * had a stable filename to match. Both halves are gone with the office
   * itself; rollup splits normally now, and every piece it emits belongs on
   * the tablet.
   */
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
