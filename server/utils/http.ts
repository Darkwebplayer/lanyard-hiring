import { DomainError } from '../domain/errors'

// Domain code throws DomainError (no h3 dependency); routes turn it into an HTTP error.
export async function domain<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  }
  catch (e) {
    if (e instanceof DomainError) throw createError({ statusCode: e.status, message: e.message, data: e.issues && { issues: e.issues } })
    throw e
  }
}
