import { publicStatus } from '../../../domain/status'

// No auth: the token is the key, emailed only to the candidate. 404 for unknown tokens.
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return domain(publicStatus(useDb(event), getRouterParam(event, 'token') ?? '', new Date()))
})
