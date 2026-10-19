import { createDb } from '../server/db/client'

process.loadEnvFile()

// Integration tests run against NEON_POSTGRES_DB and clean up the rows they create.
// ponytail: shared dev db; move to a dedicated test branch/db before the engine race tests (phase 4).
export const testDb = () => createDb(process.env.NEON_POSTGRES_DB!)
