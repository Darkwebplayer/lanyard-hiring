import { z } from 'zod'
import { OPS_BY_TYPE } from '../../../../shared/workflow/rules'
import { pickerFields } from '../../../domain/jobs'

// Variable picker: fields a node may read, each with the operators its type supports.
export default defineEventHandler(async (event) => {
  await requireManager(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  const { node } = await getValidatedQuery(event, z.object({ node: z.string().min(1) }).parse)
  const fields = await domain(pickerFields(useDb(event), id, node))
  return fields.map(f => ({ ...f, ops: OPS_BY_TYPE[f.type] }))
})
