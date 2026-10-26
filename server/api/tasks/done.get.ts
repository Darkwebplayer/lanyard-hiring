import { listDone } from '../../domain/tasks'

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  return listDone(useDb(event), { userId: actor.user.id, level: actor.level }, new Date())
})
