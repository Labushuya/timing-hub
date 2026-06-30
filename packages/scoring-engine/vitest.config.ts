import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      thresholds: {
        // Branch threshold set to 90 to account for unreachable defensive guards:
        // - rundstrecke.ts: timestamps[0] === undefined (typed number | undefined via
        //   noUncheckedIndexedAccess but raw_timestamp_ms is always number)
        // - glp.ts: reduce false branch for chronological sort
        // - orientierung.ts/sonderpruefung.ts: short-circuit && branches
        // All remaining source lines/statements/functions are fully covered.
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
