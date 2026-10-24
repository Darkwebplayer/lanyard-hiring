// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  // Recruiter pages sit behind a session cookie: client-only. The public pages render on the server so
  // crawlers (Google job search) see the job and its JSON-LD. ssr must be on globally for any route to
  // render on the server (ssr: false builds no server renderer), so '/**' turns it off and the public pages back on.
  ssr: true,
  routeRules: {
    '/**': { ssr: false },
    '/apply/**': { ssr: true },
    '/careers': { ssr: true },
  },
  // the dev key always passes; set NUXT_PUBLIC_TURNSTILE_SITE_KEY in production
  runtimeConfig: { public: { turnstileSiteKey: '1x00000000000000000000AA' } },
  css: ['@vue-flow/core/dist/style.css', '~/assets/css/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#f8f6f8' },
        { name: 'color-scheme', content: 'light' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap' },
      ],
    },
  },
  // the app tsconfig also type-checks server routes (typed $fetch), so it needs the Worker types
  typescript: { tsConfig: { include: ['../worker-configuration.d.ts', '../server/cloudflare.d.ts'] } },
  nitro: {
    preset: 'cloudflare_module',
    cloudflare: { nodeCompat: true },
  },
  // the custom Worker entry (queue + cron) is for the built Worker; `nuxt dev` needs Nitro's own dev entry
  $production: { nitro: { entry: './entry.ts' } },
})
