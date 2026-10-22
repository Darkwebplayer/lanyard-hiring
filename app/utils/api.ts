import type { Issue } from '~~/shared/workflow/types'

// Every API error the UI can meet, in the words a recruiter would use. Keys are the backend's stable codes.
const MESSAGES: Record<string, string> = {
  unauthenticated: 'Your session ended. Sign in again.',
  no_access: 'Your account has no access. Ask an admin to give you a role.',
  forbidden: 'You don’t have access to this.',
  not_found: 'This doesn’t exist, or it isn’t yours to see.',
  task_not_found: 'This task isn’t yours, or it no longer exists.',
  role_name_taken: 'A role with this name already exists.',
  admin_is_managed_by_env: 'The admin account is set by the server and can’t be changed here.',
  unknown_role: 'That role no longer exists. Pick another.',
  user_exists: 'This person already has an account. Change their role in the list instead.',
  job_not_found: 'This job doesn’t exist.',
  source_job_not_found: 'The job you copied from no longer exists. Pick another.',
  invalid_preset: 'Some settings need another look.',
  preset_not_found: 'This preset was deleted. The list is up to date now.',
  flow_preset_not_found: 'This flow preset was deleted. Pick another.',
  section_changed: 'Someone else changed this section. The list is up to date now; try again.',
  owner_must_be_manager: 'The owner must be a manager or an admin.',
  publish_first: 'Publish the job once before you open it.',
  job_archived: 'This job is archived and can’t change.',
  no_draft: 'There are no unpublished changes.',
  invalid_version: 'Fix the marked problems, then publish again.',
  job_not_open: 'This job isn’t taking applications any more.',
  turnstile_failed: 'We couldn’t confirm you’re a person. Try again.',
  too_large: 'The files are too large together. Keep the total under 25 MB.',
  invalid_application: 'Some answers need another look.',
  already_applied: 'You’ve already applied for this job with this email.',
  invalid_scorecard: 'Some scorecard answers need another look.',
  already_submitted: 'You’ve already submitted this scorecard.',
  task_closed: 'This task has finished or moved on, so it can’t take changes.',
  node_not_in_version: 'That step isn’t in the flow this candidate is on.',
  already_closed: 'This application is already closed. Reopen it first.',
  reason_required: 'Say why. The reason goes in each candidate’s history.',
  not_latest_run: 'Only the latest step can be retried.',
  not_retryable: 'This step isn’t stopped, so there’s nothing to retry.',
  application_closed: 'This application is closed.',
  bad_assignee: 'One of those people can’t take tasks (inactive or without a role).',
  below_min_submissions: 'That would leave too few people to finish the task.',
}

export interface ApiError { status: number, code: string, message: string, issues: Issue[] }

export function toApiError(e: unknown): ApiError {
  // already converted by api(): converting again would lose the code
  if (e && typeof e === 'object' && 'code' in e && 'issues' in e) return e as ApiError
  const err = e as { statusCode?: number, status?: number, data?: { message?: string, statusMessage?: string, data?: { issues?: Issue[] } } }
  const status = err.statusCode ?? err.status ?? 0
  const code = err.data?.message ?? (status === 404 ? 'not_found' : status ? `http_${status}` : 'network')
  const message = MESSAGES[code]
    ?? (code.startsWith('cannot_go_from_') ? `A job can’t go from ${code.split('_')[3]} to ${code.split('_')[5]}.` : null)
    ?? (code === 'network' ? 'Can’t reach the server. Check your connection and try again.' : 'Something went wrong on our side. Try again.')
  return { status, code, message, issues: err.data?.data?.issues ?? [] }
}

// $fetch that throws ApiError, and sends people to sign-in when the session ends.
export async function api<T = unknown>(url: string, opts: Parameters<typeof $fetch>[1] = {}): Promise<T> {
  try {
    return await $fetch<T>(url, opts as any) as T
  }
  catch (e) {
    const err = toApiError(e)
    if (err.status === 401 && import.meta.client && !location.pathname.startsWith('/login')) {
      await navigateTo({ path: '/login', query: { next: location.pathname + location.search } })
    }
    throw err
  }
}

// What a manager does about each run error (docs/backend.md §5).
export function runErrorText(error: string | null | undefined): { what: string, fix: string } {
  const e = error ?? ''
  if (e.startsWith('no_assignees')) return { what: 'Nobody could be assigned', fix: 'Give someone the role this step uses, then retry.' }
  if (/^(missing_file|file_not_found|checksum_mismatch)/.test(e)) return { what: 'The CV is missing or was changed', fix: 'Move the candidate on by hand.' }
  if (e.startsWith('unreadable_cv')) return { what: 'The CV can’t be read', fix: 'It may be a scan. Move it to a manual review.' }
  if (/^(ai_not_configured|ai_error)/.test(e)) return { what: 'The AI review couldn’t run', fix: 'Check the AI settings, then retry.' }
  if (e.startsWith('missing_ref')) return { what: 'The email had an empty field', fix: 'Move the candidate on, or fix their data and retry.' }
  if (e.startsWith('email_failed')) return { what: 'The email provider refused the email', fix: 'Retry.' }
  if (e.startsWith('disabled')) return { what: 'This kind of step is switched off', fix: 'Switch it back on, then retry.' }
  if (/^(invalid_config|no_handler)/.test(e)) return { what: 'This step is set up wrong', fix: 'Ask a developer to look at it.' }
  return { what: 'A temporary error, three times in a row', fix: 'Retry.' }
}
