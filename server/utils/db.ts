import type { H3Event } from 'h3'
import { createDb, type Db } from '../db/client'
import type { AppEnv } from '../env'

export const useEnv = (event: H3Event) => event.context.cloudflare.env as AppEnv

// One db per request. The runtime drops the socket when the request ends, so no explicit close.
export function useDb(event: H3Event): Db {
  return (event.context.db ??= createDb(useEnv(event).HYPERDRIVE.connectionString))
}

// Postgres error code from a (possibly drizzle-wrapped) error: 23505 unique, 23503 foreign key.
export const pgCode = (e: unknown): string | undefined =>
  (e as any)?.code ?? (e as any)?.cause?.code

// Runs a write, turning constraint violations into 409/422 instead of 500.
export async function constrained<T>(write: Promise<T>, messages: { unique?: string, fk?: string } = {}) {
  try {
    return await write
  }
  catch (e) {
    const code = pgCode(e)
    if (code === '23505') throw createError({ statusCode: 409, message: messages.unique ?? 'already_exists' })
    if (code === '23503') throw createError({ statusCode: 422, message: messages.fk ?? 'invalid_reference' })
    throw e
  }
}
