import { listTeam } from '../../domain/team'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return listTeam(useDb(event), useEnv(event).ADMIN_EMAIL)
})
