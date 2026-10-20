import { listTasks } from '../../domain/tasks'

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  return listTasks(useDb(event), { userId: actor.user.id, level: actor.level }, useEnv(event).ADMIN_EMAIL, new Date())
})
