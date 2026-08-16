import '@testing-library/jest-dom/vitest';

// No fake-indexeddb here, unlike the till. The back office has no local
// database, so a test that needed one would be testing something this app
// must never grow.
