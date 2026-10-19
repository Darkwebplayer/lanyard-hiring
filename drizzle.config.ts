import { defineConfig } from 'drizzle-kit'

process.loadEnvFile()

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dbCredentials: { url: process.env.NEON_POSTGRES_DB! },
})
