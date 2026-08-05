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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        /**
         * THE BACK OFFICE IS NOT PRECACHED, ON PURPOSE.
         *
         * vite-plugin-pwa precaches every built js and css file it finds, so
         * splitting /office into its own lazy chunk does NOT on its own keep
         * it off the tablet — workbox would simply download the chunk during
         * install and cache it forever. The lazy import controls when the
         * chunk loads; this line controls whether it is ever downloaded at
         * all. Both are needed, and neither works without the other.
         *
         * The cost is deliberate and handled: with no connection the office
         * chunk cannot be fetched and `import()` rejects. OfficeGate catches
         * that and says the back office needs a connection, rather than
         * leaving a white screen.
         *
         * The name comes from `manualChunks` below. If that name changes, this
         * pattern silently stops matching and the payroll screen is back on
         * the till with nothing complaining — which is what
         * bundle-boundary.test.ts exists to catch.
         */
        globIgnores: ['**/office-*.js', '**/office-*.css'],
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
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Every back-office module lands in ONE chunk called "office".
         *
         * Not for speed — for a name. The precache exclusion above has to
         * match built filenames, and rollup's automatic names follow whichever
         * module happened to be the entry point, so they move whenever the
         * back office is refactored. Pinning the name means the exclusion is
         * one line that keeps working when a fourteenth screen is added.
         *
         * Anything imported by BOTH sides falls through to `undefined` and
         * rollup puts it in a shared chunk, which is precached — correct,
         * because the till needs it.
         */
        manualChunks(id) {
          if (id.includes('/pages/office/') || id.includes('/components/office/')) return 'office';
          return undefined;
        },
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
