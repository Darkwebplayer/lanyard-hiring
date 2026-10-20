// Cloudflare Turnstile server-side check. Fails closed: no secret, no token or no answer = not human.
// Local dev uses Cloudflare's always-pass test secret 1x0000000000000000000000000000000AA.
export async function verifyTurnstile(secret: string | undefined, token: string | undefined, ip: string | undefined, fetchFn: typeof fetch = fetch) {
  if (!secret || !token) return false
  try {
    const res = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, ...(ip && { remoteip: ip }) }),
    })
    return res.ok && (await res.json() as { success?: boolean }).success === true
  }
  catch {
    return false
  }
}
