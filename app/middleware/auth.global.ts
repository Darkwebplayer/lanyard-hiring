import type { Me } from "~/composables/useMe"

const PUBLIC = ['/login', '/apply/']

export default defineNuxtRouteMiddleware(async (to) => {
  if (PUBLIC.some(p => to.path.startsWith(p))) return
  const { me } = useMe()
  if (!me.value) {
    try {
      me.value = await $fetch<Me>('/api/me')
    }
    catch (e) {
      const { status, code } = toApiError(e)
      if (status === 401) return navigateTo({ path: '/login', query: to.fullPath === '/' ? {} : { next: to.fullPath } })
      return navigateTo({ path: '/login', query: { error: code === 'no_access' ? 'NO_ACCESS' : 'UNKNOWN' } })
    }
  }
  // employees only have the inbox and the candidates their tasks belong to
  const level = me.value.level
  if (level === 'employee' && !/^\/(inbox|candidates|tasks)/.test(to.path) && to.path !== '/') return navigateTo('/inbox')
  if (level !== 'admin' && /^\/(team|settings)/.test(to.path)) return navigateTo('/inbox')
})
