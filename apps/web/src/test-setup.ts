import '@testing-library/jest-dom/vitest';
// jsdom has no IndexedDB, and since Step 4 almost every screen reads a bill
// from it. fake-indexeddb is a real implementation of the spec in memory, so
// the tests exercise the same Dexie code the tablet runs rather than a mock
// that agrees with whatever the test expects.
import 'fake-indexeddb/auto';
