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

export * from './http.js';
export * from './routes.js';
export * from './session-store.js';
