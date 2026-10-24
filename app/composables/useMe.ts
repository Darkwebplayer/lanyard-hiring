export type Level = 'admin' | 'manager' | 'employee'
// ai: 'on' = Ask and the AI steps work; 'off' = an admin turned AI off; 'unconfigured' = the server has no AI key
export interface Me { id: string, name: string, email: string, image: string | null, level: Level, ai: 'on' | 'off' | 'unconfigured' }

// The signed-in person, loaded once per visit by the auth middleware.
export const useMe = () => {
  const me = useState<Me | null>('me', () => null)
  const isManager = computed(() => me.value?.level === 'manager' || me.value?.level === 'admin')
  const isAdmin = computed(() => me.value?.level === 'admin')
  // Ask is hidden, not disabled, when AI isn't on; admins still get the button, which explains why
  const canAsk = computed(() => me.value?.ai === 'on')
  return { me, isManager, isAdmin, canAsk }
}
