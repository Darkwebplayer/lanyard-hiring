import { assertAiOn } from '../../domain/ask'
import { draftFlow, flowDraftInput, flowGenerator, withCvField } from '../../domain/flowDraft'

// A draft only: nothing is saved here. The editor opens it unsaved and the person saves it.
export default defineEventHandler(async (event) => {
  await requireManager(event)
  const body = await readValidatedBody(event, flowDraftInput.parse)
  const env = useEnv(event)
  await domain(assertAiOn(useDb(event), env))
  // `form` comes back only when the draft adds to it (a CV upload); the editor saves it with the flow
  const { form, added } = withCvField(body.description, body.form)
  const res = await domain(draftFlow(flowGenerator(env, form), body.description, form))
  return added ? { ...res, form, summary: `${res.summary} · adds “${added.label}” to the form` } : res
})
