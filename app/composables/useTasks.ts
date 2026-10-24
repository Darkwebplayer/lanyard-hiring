export interface TaskRow {
  runId: string, nodeKey: string, nodeType: string, status: string, title: string
  dueAt: string | null, overdue: boolean, error: string | null, retries: number, createdAt: string
  applicationId: string, candidateName: string, jobId: string, jobTitle: string
  booking?: { startsAt: string | null } | null // the step lets the candidate book a time; startsAt once they have
}
export interface Inbox { mine: TaskRow[], overdue?: TaskRow[], blocked?: TaskRow[], failed?: TaskRow[], stuck?: TaskRow[] }

// Shared by the rail (count) and the inbox page, so the inbox loads once.
export const useTasks = () => {
  const inbox = useState<Inbox | null>('inbox', () => null)
  const error = useState<ApiError | null>('inbox-error', () => null)
  async function refresh() {
    try {
      const res = await api<Inbox>('/api/tasks')
      // anything else (an empty body, an HTML page mid-reload or mid-sign-in) is a failed load, not an empty inbox
      if (!Array.isArray(res?.mine)) throw { status: 0, code: 'bad_response', message: 'Something went wrong on our side. Try again.', issues: [] } satisfies ApiError
      inbox.value = res
      error.value = null
    }
    catch (e) {
      error.value = e as ApiError
    }
  }
  return { inbox, error, refresh }
}
