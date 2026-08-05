import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'UTC' },
    /**
     * ONE FILE AT A TIME.
     *
     * Every test in here is an integration test against the SAME dev database,
     * and some of them measure things that are true of the whole branch rather
     * than of one row: what the till took between two timestamps, how many
     * bills the day has, what the next document number is. Run two such files
     * at once and one file's cash sale lands inside the other file's shift
     * window — the assertion that fails is correct, and the code it accuses is
     * innocent.
     *
     * Found by shift.routes.test.ts, which passed alone and failed five ways in
     * the suite. It also explains the `Unique constraint failed on
     * (branchId, name)` lines that two files had been racing each other into.
     *
     * The bill is a few seconds on a suite that is dominated by bcrypt anyway.
     */
    fileParallelism: false,
  },
});
