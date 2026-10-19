import { describe, expect, it } from 'vitest'
import { accessLevel, atLeastManager, gateNewUser } from '../server/domain/access'

const ADMIN = 'Boss@Gmail.com'

describe('gateNewUser', () => {
  it('lets the env admin in without an invite, case-insensitively', () => {
    expect(gateNewUser({ email: ' boss@gmail.COM', emailVerified: true }, ADMIN, undefined))
      .toEqual({ ok: true, email: 'boss@gmail.com', roleId: null })
  })
  it('requires an invite for everyone else and copies its role', () => {
    expect(gateNewUser({ email: 'a@x.com', emailVerified: true }, ADMIN, undefined)).toEqual({ ok: false, reason: 'not_invited' })
    expect(gateNewUser({ email: 'A@x.com', emailVerified: true }, ADMIN, { roleId: 'r1' }))
      .toEqual({ ok: true, email: 'a@x.com', roleId: 'r1' })
  })
  it('refuses unverified emails, even the admin', () => {
    expect(gateNewUser({ email: ADMIN, emailVerified: false }, ADMIN, undefined)).toEqual({ ok: false, reason: 'email_not_verified' })
  })
  it('never treats an empty ADMIN_EMAIL as a match', () => {
    expect(gateNewUser({ email: '', emailVerified: true }, '', undefined)).toEqual({ ok: false, reason: 'not_invited' })
  })
})

describe('accessLevel', () => {
  it('admin from env beats role and active flag', () => {
    expect(accessLevel({ email: 'boss@gmail.com', active: false }, null, ADMIN)).toBe('admin')
  })
  it('uses the role level for active users', () => {
    expect(accessLevel({ email: 'a@x.com', active: true }, 'manager', ADMIN)).toBe('manager')
    expect(accessLevel({ email: 'a@x.com', active: true }, 'employee', ADMIN)).toBe('employee')
  })
  it('denies inactive or role-less users (e.g. a former admin after ADMIN_EMAIL changes)', () => {
    expect(accessLevel({ email: 'a@x.com', active: false }, 'manager', ADMIN)).toBeNull()
    expect(accessLevel({ email: 'old-admin@x.com', active: true }, null, ADMIN)).toBeNull()
  })
  it('atLeastManager', () => {
    expect(['admin', 'manager', 'employee'].map(l => atLeastManager(l as any))).toEqual([true, true, false])
  })
})
