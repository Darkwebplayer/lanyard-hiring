import type { Issue } from '../../shared/workflow/types'

// Thrown by domain and engine code (which never import h3); routes map it to an HTTP error.
export class DomainError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: Issue[]) { super(message) }
}
