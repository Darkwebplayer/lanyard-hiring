import { getSettings } from '../domain/settings'

export default defineEventHandler(async (event) => {
  // managers read it too: the reject dialogs need rejectReasons. Writing stays admin-only.
  await requireManager(event)
  return getSettings(useDb(event))
})
