import { assertAiOn } from '../../domain/ask'
import { draftFlow, flowDraftInput, flowGenerator } from '../../domain/flowDraft'

// A draft only: nothing is saved here. The editor opens it unsaved and the person saves it.
export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { description, form } = await readValidatedBody(event, flowDraftInput.parse)
  const env = useEnv(event)
  await domain(assertAiOn(useDb(event), env))
  return domain(draftFlow(flowGenerator(env, form), description, form))
})
