import { publicDocuments } from '../../../domain/documents'

// No auth: the candidate's checklist. 404 for unknown tokens.
export default defineEventHandler(event => domain(publicDocuments(useDb(event), getRouterParam(event, 'token') ?? '')))
