import { defineConfig } from 'vitest/config'

process.loadEnvFile()

export default defineConfig({
  test: {
    globalSetup: ['./test/setup.ts'],
    fileParallelism: !process.env.TEST_PG, // real-Postgres files share one db
    testTimeout: process.env.TEST_PG ? 60_000 : 10_000, // remote round trips
    hookTimeout: process.env.TEST_PG ? 60_000 : 10_000,
  },
})
