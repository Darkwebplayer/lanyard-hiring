// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  // the app tsconfig also type-checks server routes (typed $fetch), so it needs the Worker types
  typescript: { tsConfig: { include: ['../worker-configuration.d.ts', '../server/cloudflare.d.ts'] } },
  nitro: {
    preset: 'cloudflare_module',
    entry: './entry.ts',
    cloudflare: { nodeCompat: true },
  },
})
