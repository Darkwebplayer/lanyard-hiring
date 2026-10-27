import { removeLogo } from '../../domain/settings'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return removeLogo(useDb(event), useEnv(event).CV_BUCKET)
})
