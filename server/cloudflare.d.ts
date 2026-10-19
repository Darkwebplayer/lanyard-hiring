/// <reference path="../worker-configuration.d.ts" />

// Resolved by Nitro's bundler (nitropack is Nuxt's dependency, not ours); typed here for server/entry.ts.
declare module 'nitropack/presets/cloudflare/runtime/cloudflare-module' {
  const handler: ExportedHandler<Env>
  export default handler
}
