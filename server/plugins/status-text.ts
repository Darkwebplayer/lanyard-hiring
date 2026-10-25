// The 4xx codes this API throws; anything else keeps Nitro's default.
const TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone',
  411: 'Length Required', 413: 'Content Too Large', 422: 'Unprocessable Content', 429: 'Too Many Requests',
}

// createError({ statusCode, message }) leaves statusMessage empty, and Nitro then labels even a 403 "Server Error".
// Name the status instead. The error hook runs (synchronously) before the error handler renders the response.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error) => {
    const e = error as { statusCode?: number, statusMessage?: string }
    if (e.statusCode && !e.statusMessage && TEXT[e.statusCode]) e.statusMessage = TEXT[e.statusCode]
  })
})
