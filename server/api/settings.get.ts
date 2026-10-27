import { getSettings, logoUrl } from '../domain/settings'

export default defineEventHandler(async (event) => {
  // managers read it too: the reject dialogs need rejectReasons. Writing stays admin-only.
  await requireManager(event)
  const s = await getSettings(useDb(event))
  return { ...s, logoUrl: logoUrl(s.logoKey) }
})
