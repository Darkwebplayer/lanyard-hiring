<script setup lang="ts">
useHead({ title: 'Team' })

type RoleLevel = 'manager' | 'employee'
interface Role { id: string, name: string, level: RoleLevel, createdAt: string }
interface User { id: string, name: string, email: string, image: string | null, active: boolean, roleId: string | null, roleName: string | null, roleLevel: RoleLevel | null, createdAt: string, isAdmin: boolean }
interface Invite { email: string, roleId: string, roleName: string, createdAt: string }

const LEVELS: { value: RoleLevel, label: string }[] = [
  { value: 'manager', label: 'Manager: jobs, workflows, all candidates' },
  { value: 'employee', label: 'Employee: only their own tasks' },
]

const users = ref<User[] | null>(null)
const invites = ref<Invite[]>([])
const roles = ref<Role[]>([])
const loadError = ref('')
async function load() {
  loadError.value = ''
  try {
    const [u, r] = await Promise.all([api<{ users: User[], invites: Invite[] }>('/api/users'), api<Role[]>('/api/roles')])
    users.value = u.users
    invites.value = u.invites
    roles.value = r
  }
  catch (e) { loadError.value = toApiError(e).message }
}
load()

const sortedRoles = computed(() => [...roles.value].sort((a, b) => a.name.localeCompare(b.name)))
// Admin first, then by name. Not by active: a row that jumps when switched off puts the next click on someone else.
const sortedUsers = computed(() => [...users.value ?? []].sort((a, b) =>
  Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name)))

// per-row errors, shown next to the row that caused them
const rowError = reactive<Record<string, string>>({})
const busyRow = ref<string | null>(null)

async function patchUser(u: User, body: { roleId?: string, active?: boolean }) {
  delete rowError[u.id]
  busyRow.value = u.id
  try {
    const row = await api<User>(`/api/users/${u.id}`, { method: 'PATCH', body })
    Object.assign(u, row)
  }
  catch (e) {
    rowError[u.id] = toApiError(e).message
    users.value = [...users.value!] // re-render so the control shows the saved value again
  }
  finally { busyRow.value = null }
}

// Switching on applies at once; switching off signs them out, so it asks first.
const confirmDlg = ref<HTMLDialogElement>()
const toDeactivate = ref<User | null>(null)
function onActive(u: User, e: Event) {
  const input = e.target as HTMLInputElement
  if (input.checked) return patchUser(u, { active: true })
  input.checked = true
  toDeactivate.value = u
  confirmDlg.value?.showModal()
}
async function confirmDeactivate() {
  const u = toDeactivate.value!
  confirmDlg.value?.close()
  await patchUser(u, { active: false })
}
const backdropClose = (e: MouseEvent) => { if (e.target === e.currentTarget) (e.target as HTMLDialogElement).close() }

// invite
const inviteEmail = ref('')
const inviteRole = ref('')
const inviteError = ref('')
const inviting = ref(false)
const invited = ref<{ email: string, existed: boolean } | null>(null)
// reads the invite's role now, so changing it in the list below keeps this line true
const invitedNote = computed(() => {
  const inv = invited.value && invites.value.find(i => i.email === invited.value!.email)
  if (!inv) return ''
  return invited.value!.existed ? `Invite for ${inv.email} changed to ${inv.roleName}.` : `Invited ${inv.email} as ${inv.roleName}.`
})
watch(roles, (r) => { if (!inviteRole.value) inviteRole.value = [...r].sort((a, b) => a.name.localeCompare(b.name)).find(x => x.level === 'employee')?.id ?? r[0]?.id ?? '' })
async function sendInvite() {
  inviteError.value = ''
  invited.value = null
  inviting.value = true
  try {
    const inv = await api<Invite>('/api/invites', { method: 'POST', body: { email: inviteEmail.value.trim(), roleId: inviteRole.value } })
    const existed = invites.value.some(i => i.email === inv.email)
    invites.value = [inv, ...invites.value.filter(i => i.email !== inv.email)]
    invited.value = { email: inv.email, existed }
    inviteEmail.value = ''
  }
  catch (e) { inviteError.value = toApiError(e).message }
  finally { inviting.value = false }
}
const inviteRowError = reactive<Record<string, string>>({})
// an invite's role changes by inviting the address again
async function reinvite(i: Invite, roleId: string) {
  delete inviteRowError[i.email]
  busyRow.value = i.email
  try { Object.assign(i, await api<Invite>('/api/invites', { method: 'POST', body: { email: i.email, roleId } })) }
  catch (e) {
    inviteRowError[i.email] = toApiError(e).message
    invites.value = [...invites.value] // re-render so the control shows the saved value again
  }
  finally { busyRow.value = null }
}
async function removeInvite(i: Invite) {
  delete inviteRowError[i.email]
  try {
    await api(`/api/invites/${encodeURIComponent(i.email)}`, { method: 'DELETE' })
    invites.value = invites.value.filter(x => x.email !== i.email)
  }
  catch (e) { inviteRowError[i.email] = toApiError(e).message }
}

// roles
const roleError = reactive<Record<string, string>>({})
async function patchRole(r: Role, body: { name?: string, level?: RoleLevel }) {
  delete roleError[r.id]
  if (body.name !== undefined) {
    body.name = body.name.trim()
    if (!body.name || body.name === r.name) { roles.value = [...roles.value]; return }
  }
  try {
    const row = await api<Role>(`/api/roles/${r.id}`, { method: 'PATCH', body })
    Object.assign(r, row)
    // people with this role show the new name and level
    for (const u of users.value ?? []) if (u.roleId === r.id) Object.assign(u, { roleName: row.name, roleLevel: row.level })
    for (const i of invites.value) if (i.roleId === r.id) i.roleName = row.name
  }
  catch (e) {
    roleError[r.id] = toApiError(e).message
    roles.value = [...roles.value]
  }
}
const people = (r: Role) => (users.value ?? []).filter(u => u.roleId === r.id && u.active).length

const newRole = ref('')
const newLevel = ref<RoleLevel>('employee')
const addRoleError = ref('')
async function addRole() {
  addRoleError.value = ''
  try {
    const r = await api<Role>('/api/roles', { method: 'POST', body: { name: newRole.value.trim(), level: newLevel.value } })
    roles.value = [...roles.value, r]
    newRole.value = ''
  }
  catch (e) { addRoleError.value = toApiError(e).message }
}
</script>

<template>
  <div class="page">
    <header class="page-head"><h1>Team</h1></header>

    <div v-if="loadError" class="empty" role="alert">
      <h2>The team didn’t load</h2>
      <p>{{ loadError }}</p>
      <button class="btn" @click="load"><Icon name="retry" />Try again</button>
    </div>

    <template v-else>
      <section class="block" aria-labelledby="people" :aria-busy="!users" :inert="!users">
        <h2 id="people">Members</h2>

        <form class="panel invite" @submit.prevent="sendInvite">
          <div class="field">
            <label for="inv-email">Invite by email</label>
            <input id="inv-email" v-model="inviteEmail" type="email" required placeholder="name@company.com" autocomplete="off">
          </div>
          <div class="field">
            <label for="inv-role">Role</label>
            <select id="inv-role" v-model="inviteRole" required>
              <option v-for="r in sortedRoles" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
          </div>
          <button class="btn btn-primary" :aria-busy="inviting" :disabled="inviting || !roles.length">
            <span v-if="inviting" class="spinner" /><span>Send invite</span>
          </button>
          <p class="hint">They join the list below at once and sign in with Google using this address.</p>
          <div aria-live="polite" class="inv-result">
            <p v-if="inviteError" class="error"><Icon name="alert" :size="16" />{{ inviteError }}</p>
            <p v-else-if="invitedNote" class="ok"><Icon name="check" :size="16" />{{ invitedNote }}</p>
          </div>
        </form>

        <div class="panel table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>Role</th><th>Access</th><th>Joined</th></tr></thead>
            <tbody>
              <template v-if="!users">
                <tr v-for="i in 3" :key="i"><td v-for="(w, k) in [60, 50, 40, 30]" :key="k"><span class="skeleton sk" :style="{ width: `${w}%` }" /></td></tr>
              </template>
              <tr v-for="u in sortedUsers" :key="u.id" :class="{ off: !u.active }">
                <td>
                  <div class="who">
                    <Avatar :name="u.name" :image="u.image" :size="32" />
                    <div class="who-text">
                      <b>{{ u.name }}</b>
                      <span class="faint email" :title="u.email">{{ u.email }}</span>
                    </div>
                  </div>
                </td>
                <td class="role">
                  <span v-if="u.isAdmin" class="locked"><Icon name="lock" :size="14" />Admin · can’t be changed here</span>
                  <template v-else>
                    <select
                      :value="u.roleId ?? ''" :aria-label="`Role for ${u.name}`" :disabled="busyRow === u.id"
                      @change="patchUser(u, { roleId: ($event.target as HTMLSelectElement).value })"
                    >
                      <option v-if="!u.roleId" value="" disabled>No role</option>
                      <option v-for="r in sortedRoles" :key="r.id" :value="r.id">{{ r.name }}</option>
                    </select>
                  </template>
                  <p v-if="rowError[u.id]" class="error" role="alert">{{ rowError[u.id] }}</p>
                </td>
                <td>
                  <label v-if="!u.isAdmin" class="switch">
                    <input type="checkbox" role="switch" :checked="u.active" :disabled="busyRow === u.id" :aria-label="`${u.name} can sign in`" @change="onActive(u, $event)">
                    <span>{{ u.active ? 'Active' : 'Switched off' }}</span>
                  </label>
                  <span v-else class="faint">Always on</span>
                </td>
                <td class="faint nowrap">{{ fmtDate(u.createdAt) }}</td>
              </tr>
              <!-- invited, not signed in yet: on the list from the moment they're invited, so nobody wonders where they went -->
              <tr v-for="i in invites" :key="i.email" class="pending">
                <td>
                  <div class="who">
                    <Avatar :name="i.email" :size="32" />
                    <div class="who-text">
                      <b class="email-cell">{{ i.email }}</b>
                      <span class="faint">Invited, not signed in yet</span>
                    </div>
                  </div>
                </td>
                <td class="role">
                  <select :value="i.roleId" :aria-label="`Role for ${i.email}`" :disabled="busyRow === i.email" @change="reinvite(i, ($event.target as HTMLSelectElement).value)">
                    <option v-for="r in sortedRoles" :key="r.id" :value="r.id">{{ r.name }}</option>
                  </select>
                  <p v-if="inviteRowError[i.email]" class="error" role="alert">{{ inviteRowError[i.email] }}</p>
                </td>
                <td><button class="btn btn-quiet btn-sm" :aria-label="`Cancel invite for ${i.email}`" :disabled="busyRow === i.email" @click="removeInvite(i)">Cancel invite</button></td>
                <td class="faint nowrap">Invited {{ fmtDate(i.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

      </section>

      <section class="block" aria-labelledby="roles-h" :aria-busy="!users" :inert="!users">
        <div>
          <h2 id="roles-h">Roles &amp; permissions</h2>
          <p class="muted sub">The name is yours to choose; the level decides what people can see.</p>
        </div>
        <div class="panel table-wrap">
          <table class="table roles">
            <thead><tr><th>Name</th><th>Level</th><th class="num">People</th></tr></thead>
            <tbody>
              <template v-if="!users">
                <tr v-for="i in 3" :key="i"><td v-for="(w, k) in [50, 40, 20]" :key="k"><span class="skeleton sk" :style="{ width: `${w}%` }" /></td></tr>
              </template>
              <tr v-for="r in sortedRoles" :key="r.id">
                <td>
                  <input
                    :value="r.name" :aria-label="`Rename ${r.name}`" maxlength="60" class="inline"
                    @change="patchRole(r, { name: ($event.target as HTMLInputElement).value })" @keydown.enter="($event.target as HTMLInputElement).blur()"
                  >
                  <p v-if="roleError[r.id]" class="error" role="alert">{{ roleError[r.id] }}</p>
                </td>
                <td>
                  <select :value="r.level" :aria-label="`Level for ${r.name}`" @change="patchRole(r, { level: ($event.target as HTMLSelectElement).value as RoleLevel })">
                    <option v-for="l in LEVELS" :key="l.value" :value="l.value">{{ l.label }}</option>
                  </select>
                </td>
                <td class="num faint">{{ people(r) }}</td>
              </tr>
              <tr v-if="users && !roles.length"><td colspan="3" class="faint">No roles yet. Add one below before you invite anyone.</td></tr>
            </tbody>
          </table>
          <form class="add-role" @submit.prevent="addRole">
            <input v-model="newRole" required maxlength="60" placeholder="New role, e.g. Interviewer" aria-label="New role name">
            <select v-model="newLevel" aria-label="New role level">
              <option v-for="l in LEVELS" :key="l.value" :value="l.value">{{ l.label }}</option>
            </select>
            <button class="btn"><Icon name="plus" />Add role</button>
            <p v-if="addRoleError" class="error" role="alert">{{ addRoleError }}</p>
          </form>
        </div>
      </section>
    </template>

    <dialog ref="confirmDlg" class="dialog" aria-labelledby="dl-t" @click="backdropClose" @close="toDeactivate = null">
      <form v-if="toDeactivate" method="dialog" @submit.prevent="confirmDeactivate">
        <div class="dialog-body">
          <h2 id="dl-t">Deactivate {{ toDeactivate.name }}?</h2>
          <p class="muted">They’re signed out at once and can’t sign in until you switch them back on. Their scorecards and history stay. Tasks waiting on them stay assigned, so reassign those from the inbox.</p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" autofocus @click="confirmDlg?.close()">Keep access</button>
          <button class="btn btn-danger">Deactivate and sign out</button>
        </div>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.block { display: grid; gap: 16px; margin-bottom: 40px; }
.sub { margin-top: 4px; }
.invite { display: grid; grid-template-columns: minmax(0, 440px) minmax(160px, 240px) auto; justify-content: start; gap: 8px 12px; align-items: end; padding: 16px 20px; }
.invite .hint, .inv-result { grid-column: 1 / -1; font-size: var(--t-sm); }
.invite .hint { color: var(--ink-2); }
.inv-result:empty { display: none; }
.error, .ok { display: flex; gap: 6px; align-items: center; font-size: var(--t-sm); font-weight: 500; }
.error { color: var(--bad); margin-top: 4px; }
.ok { color: var(--ok); }
.who { display: flex; gap: 12px; align-items: center; min-width: 240px; }
.who-text { display: grid; min-width: 0; }
.who-text b { font-weight: 600; overflow-wrap: anywhere; }
.email { font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch; }
.role { width: 240px; }
.role select { min-height: var(--h-sm); }
.locked { display: inline-flex; gap: 6px; align-items: center; color: var(--ink-2); font-size: var(--t-sm); white-space: nowrap; }
/* switched off: quieter but still readable (opacity failed contrast) */
tr.off .who b { color: var(--ink-2); font-weight: 500; }
tr.off .who .avatar { background: var(--sunk); color: var(--ink-2); }
.nowrap { white-space: nowrap; }
.sk { display: block; height: 14px; margin: 9px 0; }
.email-cell { overflow-wrap: anywhere; }

/* switch: a checkbox drawn as a track and knob */
.switch { display: inline-flex; gap: 10px; align-items: center; cursor: pointer; font-size: var(--t-sm); white-space: nowrap; }
.switch input {
  /* a transparent 2px border grows the target to 38 × 24 (the 24 px minimum) while the track still draws 34 × 20 */
  width: 38px; height: 24px; border-radius: 99px; border: 2px solid transparent; background: var(--line-2) padding-box; position: relative;
  display: inline-block; transition: background var(--t-micro) var(--ease);
}
.switch input::before {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff;
  scale: 1; clip-path: none; box-shadow: 0 1px 2px oklch(0.3 0.04 330 / 0.3); transition: translate var(--t-micro) var(--ease);
}
.switch input:checked { background: var(--ink) padding-box; border-color: transparent; }
.switch input:checked::before { translate: 14px 0; }

.roles td:first-child { width: 40%; }
.roles select { min-height: var(--h-sm); max-width: 320px; }
.inline { min-height: var(--h-sm); border-color: transparent; background: transparent; font-weight: 600; padding: 0 8px; margin-left: -8px; }
.inline:hover { border-color: var(--line-2); }
.add-role { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 320px) auto; gap: 8px 12px; padding: 12px 14px; border-top: 1px solid var(--line); }
.add-role input, .add-role select { min-height: var(--h-sm); }
.add-role .btn { height: var(--h-sm); }
.add-role .error { grid-column: 1 / -1; }
</style>
