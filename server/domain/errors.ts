import type { Issue } from '../../shared/workflow/types'

// Thrown by domain and engine code (which never import h3); routes map it to an HTTP error.
// Postgres error code from a (possibly drizzle-wrapped) error: 23505 unique, 23503 foreign key.
export const pgCode = (e: unknown): string | undefined =>
  (e as any)?.code ?? (e as any)?.cause?.code

export class DomainError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: Issue[]) { super(message) }
}
