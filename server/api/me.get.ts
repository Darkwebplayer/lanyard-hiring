import { aiState } from '../domain/ask'
import { getSettings } from '../domain/settings'

export default defineEventHandler(async (event) => {
  const { user, level } = await requireUser(event)
  // tells the client whether to show Ask at all (hidden, not disabled, when off)
  const ai = aiState(useEnv(event), (await getSettings(useDb(event))).aiEnabled)
  return { id: user.id, name: user.name, email: user.email, image: user.image, level, ai }
})
