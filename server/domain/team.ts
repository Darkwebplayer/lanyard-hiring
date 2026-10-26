import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { invites, roles, user } from '../db/schema'
import { isAdminEmail } from './access'

// The Team page: members with their role, and invites not yet accepted. Admins only (the route checks).
export async function listTeam(db: Db, adminEmail: string) {
  const [users, pending] = await Promise.all([
    db.select({
      id: user.id, name: user.name, email: user.email, image: user.image, active: user.active,
      roleId: user.roleId, roleName: roles.name, roleLevel: roles.level, createdAt: user.createdAt,
    }).from(user).leftJoin(roles, eq(roles.id, user.roleId)).orderBy(asc(user.email)),
    db.select({ email: invites.email, roleId: invites.roleId, roleName: roles.name, createdAt: invites.createdAt })
      .from(invites).innerJoin(roles, eq(roles.id, invites.roleId)).orderBy(asc(invites.email)),
  ])
  return { users: users.map(u => ({ ...u, isAdmin: isAdminEmail(u.email, adminEmail) })), invites: pending }
}
