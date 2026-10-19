// Pure access rules, shared by Better Auth hooks and route guards.

export type Level = 'admin' | 'manager' | 'employee'

const norm = (email: string) => email.trim().toLowerCase()

export const isAdminEmail = (email: string, adminEmail: string) =>
  !!adminEmail && norm(email) === norm(adminEmail)

// Effective level for a signed-in user, or null for "no access".
// Admin comes only from ADMIN_EMAIL, so it can't be revoked or locked out from the UI.
export function accessLevel(
  user: { email: string, active: boolean },
  roleLevel: 'manager' | 'employee' | null | undefined,
  adminEmail: string,
): Level | null {
  if (isAdminEmail(user.email, adminEmail)) return 'admin'
  if (!user.active || !roleLevel) return null
  return roleLevel
}

export const atLeastManager = (level: Level) => level === 'admin' || level === 'manager'

// Decides whether a first-time Google sign-in may create a user. Returns the role to give, or an error.
export function gateNewUser(
  profile: { email: string, emailVerified: boolean },
  adminEmail: string,
  invite: { roleId: string } | undefined,
): { ok: true, email: string, roleId: string | null } | { ok: false, reason: string } {
  if (!profile.emailVerified) return { ok: false, reason: 'email_not_verified' }
  const email = norm(profile.email)
  if (isAdminEmail(email, adminEmail)) return { ok: true, email, roleId: null }
  if (!invite) return { ok: false, reason: 'not_invited' }
  return { ok: true, email, roleId: invite.roleId }
}
