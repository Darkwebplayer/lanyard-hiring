// Dev only: a placeholder owner and one published Standard-hire job in NEON_POSTGRES_DB. Prints the job id.
import { eq } from 'drizzle-orm'
import { createDb } from '../server/db/client'
import * as s from '../server/db/schema'
import { createJob, publish, saveDraft } from '../server/domain/jobs'
import { STANDARD_HIRE } from '../shared/workflow/templates'

process.loadEnvFile()
const db = createDb(process.env.NEON_POSTGRES_DB!)
const [manager] = await db.select().from(s.roles).where(eq(s.roles.name, 'Manager'))
await db.insert(s.user).values({ id: 'demo-owner', email: 'demo-owner@example.test', name: 'Demo Owner', roleId: manager!.id }).onConflictDoNothing()
const { job } = await createJob(db, 'demo-owner', { title: 'Demo Backend Engineer', description: 'Demo job', requirements: { must_have_skills: ['TypeScript', 'Postgres'] }, openings: 1, closesAt: null }, { kind: 'blank' })
await saveDraft(db, job.id, STANDARD_HIRE)
await publish(db, job.id, 'admin@example.test')
console.log(job.id)
await db.close()
