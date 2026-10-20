export type Level = 'admin' | 'manager' | 'employee'
export interface Me { id: string, name: string, email: string, image: string | null, level: Level }

// The signed-in person, loaded once per visit by the auth middleware.
export const useMe = () => {
  const me = useState<Me | null>('me', () => null)
  const isManager = computed(() => me.value?.level === 'manager' || me.value?.level === 'admin')
  const isAdmin = computed(() => me.value?.level === 'admin')
  return { me, isManager, isAdmin }
}
