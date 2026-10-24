import { settings } from '../db/schema'
import { settingsInput } from '../domain/settings'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const input = await readValidatedBody(event, settingsInput.parse)
  const [row] = await useDb(event).insert(settings).values({ id: 1, ...input })
    .onConflictDoUpdate({ target: settings.id, set: input }).returning()
  return row
})
