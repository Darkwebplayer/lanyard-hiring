import { defineConfig } from 'vitest/config'

try { process.loadEnvFile() } catch {} // .env is optional (CI)

export default defineConfig({
  test: {
    globalSetup: ['./test/setup.ts'],
    fileParallelism: !process.env.TEST_PG, // real-Postgres files share one db
    testTimeout: process.env.TEST_PG ? 180_000 : 10_000, // remote round trips
    // PGlite migrates a fresh database per file; with files in parallel on a busy machine that passes 10 s
    hookTimeout: process.env.TEST_PG ? 180_000 : 30_000,
  },
})
