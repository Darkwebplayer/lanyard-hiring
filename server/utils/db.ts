import type { H3Event } from 'h3'
import { createDb, type Db } from '../db/client'
import { pgCode } from '../domain/errors'
import type { AppEnv } from '../env'

export const useEnv = (event: H3Event) => event.context.cloudflare.env as AppEnv

// One db per request, closed after the response by server/plugins/db-close.ts.
export function useDb(event: H3Event): Db {
  return (event.context.db ??= createDb(useEnv(event).HYPERDRIVE.connectionString))
}


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
