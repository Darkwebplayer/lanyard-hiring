import { asc } from 'drizzle-orm'
import { roles } from '../../db/schema'

// managers need roles for task assignee pickers
export default defineEventHandler(async (event) => {
  await requireManager(event)
  return useDb(event).select().from(roles).orderBy(asc(roles.name))
})
