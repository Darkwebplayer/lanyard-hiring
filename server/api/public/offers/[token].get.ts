import { z } from 'zod'
import { publicOffer } from '../../../domain/offers'

// No auth: the token is the credential. Malformed tokens 404 without touching the db.
export default defineEventHandler(async (event) => {
  const { token } = await getValidatedRouterParams(event, z.object({ token: z.string() }).parse)
  return domain(publicOffer(useDb(event), token))
})
