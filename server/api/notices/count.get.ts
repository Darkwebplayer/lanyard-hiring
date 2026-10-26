import { listNotices } from '../../domain/notices'

// The bell's poll: only what came in since the tray was last opened. Times aren't shown, so no zone.
export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { unread, urgent } = await listNotices(useDb(event), { userId: actor.user.id, level: actor.level }, 'UTC', new Date(), true)
  return { unread, urgent }
})
