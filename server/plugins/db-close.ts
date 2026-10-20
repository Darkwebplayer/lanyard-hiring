// Close the per-request db client once the response is out (Hyperdrive does the pooling).
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('afterResponse', (event) => {
    const db = event.context.db as { close: () => Promise<void> } | undefined
    if (db) event.waitUntil(db.close())
  })
})
