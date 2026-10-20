// Bindings come from `wrangler types` (global Env). Secrets live in .env locally and
// `wrangler secret put` in production, so they're typed here. An import (not a global
// augmentation) so every Nuxt tsconfig that type-checks server files sees it.
export type AppEnv = Env & {
  ADMIN_EMAIL: string
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  TURNSTILE_SECRET: string
  DISABLED_NODE_TYPES?: string
  AI_MODEL?: string // gateway model id, e.g. anthropic/claude-sonnet-5-5
  AI_GATEWAY_API_KEY?: string
  AI_MOCK?: string // '1' = deterministic mock AI (dev only)
}
