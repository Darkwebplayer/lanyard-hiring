export interface TaskRow {
  runId: string, nodeKey: string, nodeType: string, status: string, title: string
  dueAt: string | null, overdue: boolean, error: string | null, retries: number, createdAt: string
  applicationId: string, candidateName: string, jobId: string, jobTitle: string
}
export interface Inbox { mine: TaskRow[], overdue?: TaskRow[], blocked?: TaskRow[], failed?: TaskRow[], stuck?: TaskRow[] }

// Shared by the rail (count) and the inbox page, so the inbox loads once.
export const useTasks = () => {
  const inbox = useState<Inbox | null>('inbox', () => null)
  const error = useState<ApiError | null>('inbox-error', () => null)
  async function refresh() {
    try {
      inbox.value = await api<Inbox>('/api/tasks')
      error.value = null
    }
    catch (e) {
      error.value = e as ApiError
    }
  }
  return { inbox, error, refresh }
}
