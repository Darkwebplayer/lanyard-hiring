import { asc, eq } from 'drizzle-orm'
import { roles, user } from '../../db/schema'
import { isAdminEmail } from '../../domain/access'

// For managers' pickers (task assignees, reassign, job owner): active people who can sign in, i.e. who have a role
// or are the admin. No switched-off accounts, no invites; the full list stays admin-only in GET /api/users.
export default defineEventHandler(async (event) => {
  await requireManager(event)
  const adminEmail = useEnv(event).ADMIN_EMAIL
  const rows = await useDb(event).select({
    id: user.id, name: user.name, email: user.email, image: user.image, active: user.active, roleName: roles.name, roleLevel: roles.level,
  }).from(user).leftJoin(roles, eq(roles.id, user.roleId)).orderBy(asc(user.name))
  return rows.flatMap(({ active, ...u }) => {
    const admin = isAdminEmail(u.email, adminEmail)
    return active && (admin || u.roleLevel) ? [{ ...u, roleLevel: admin ? 'admin' : u.roleLevel, isAdmin: admin }] : []
  })
})
