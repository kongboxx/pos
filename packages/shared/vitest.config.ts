import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // businessDate must not depend on the machine running the tests.
    env: { TZ: 'UTC' },
  },
});
