import type { AppEnv } from '../env'

export interface Email {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
}

export class EmailError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message) }
}

// ponytail: mock sender — logs instead of sending, and dedupes by idempotencyKey the way a real
// provider would, so engine tests can assert "no double send". Swap the body for a real provider
// (Resend: POST /emails with an Idempotency-Key header) when email goes live. Cloudflare Email
// Service has no idempotency key (checked 2026-10-19).
export const outbox = new Map<string, Email>()

export async function sendEmail(_env: AppEnv, idempotencyKey: string, email: Email) {
  if (!outbox.has(idempotencyKey)) {
    outbox.set(idempotencyKey, email)
    console.log('[email:mock]', idempotencyKey, '→', email.to, '|', email.subject)
  }
  return idempotencyKey
}
