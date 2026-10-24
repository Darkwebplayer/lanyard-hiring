import { createTemplate, templateInput } from '../../domain/offers'

export default defineEventHandler(async (event) => {
  await requireManager(event)
  const input = await readValidatedBody(event, templateInput.parse)
  setResponseStatus(event, 201)
  return createTemplate(useDb(event), input)
})
