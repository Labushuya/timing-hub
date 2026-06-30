import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests spin up a real Fastify server + Postgres + Redis.
    // Run them serially to avoid port/connection conflicts between suites.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Allow extra time for DB setup and migration
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
