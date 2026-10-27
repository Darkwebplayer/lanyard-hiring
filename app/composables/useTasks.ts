export interface TaskRow {
  runId: string, nodeKey: string, nodeType: string, status: string, title: string
  dueAt: string | null, overdue: boolean, error: string | null, retries: number, createdAt: string
  applicationId: string, candidateName: string, jobId: string, jobTitle: string
  booking?: TaskBooking | null // the step has an interview to book; startsAt once picked
  grab?: { others: string[], taken: string[], need: number } // up for grabs: sent to more people than it needs, not taken by you
}
// Where an interview stands: the interviewer offers times, the panel says yes, the candidate picks.
export type BookingStage = 'closed' | 'declined' | 'needs_times' | 'panel' | 'candidate' | 'booked'
export interface TaskBooking {
  startsAt: string | null, cancelledAt?: string | null
  stage?: BookingStage, offeredBy?: string | null, pending?: string[], mustAnswer?: boolean, note?: string | null, count?: number // on your own open tasks
}
// open: up for grabs. calledOff: your interviews cancelled in the last week (an accepted offer, a close)
export interface Inbox { mine: TaskRow[], open?: TaskRow[], calledOff?: TaskRow[], overdue?: TaskRow[], blocked?: TaskRow[], failed?: TaskRow[], stuck?: TaskRow[] }

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

// What the last action did, said at the top of the page it led to. undo: a pass that can be taken back.
export interface InboxFlash { at: string, text: string, next?: { to: string, title: string }, undo?: string }

// A booked interview on someone's calendar (Schedule, the week strip).
export interface Booked extends TaskRow { startsAt: string, durationMin: number, location: string | null, people: { id: string, name: string }[] }
// Your open interviews that need times, or wait on the panel or the candidate.
export interface ToBook extends TaskRow { booking: TaskBooking, durationMin: number, location: string | null, others: string[], teamNote: string | null, sentAt: string | null }
// A time on the table, shown as an outline on the week.
export interface Offered { runId: string, candidateName: string, startsAt: string, durationMin: number }
export interface Schedule { events: Booked[], needs: ToBook[], waiting: ToBook[], offered: Offered[] }

// Times being placed on the week before Send: each belongs to one or more candidates (runIds) who need times.
// Shared by the Schedule list (drag from) and the week (drop on).
export interface Draft { id: number, startsAt: string, runIds: string[] }
export const useOffering = () => ({
  needs: useState<ToBook[]>('offer-needs', () => []),
  drafts: useState<Draft[]>('offer-drafts', () => []),
  current: useState<string | null>('offer-current', () => null), // a plain click on the week adds a time for this run
  dragging: useState<string | null>('offer-dragging', () => null),
  rev: useState('sched-rev', () => 0), // bumped after a send, so the list and the week reload
})
// One line of Done: a task you sent or passed on.
export interface DoneRow extends TaskRow { doneAt: string, passed: boolean, answer: { label: string, yes: boolean } | null }

// local midnight, n days on: calendar days, so a clock change never shifts a day
export const addDays = (d: Date, n = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
export const loadSchedule = (from: Date, days: number, everyone = false) =>
  api<Schedule>('/api/schedule', { query: { from: from.toISOString(), to: addDays(from, days).toISOString(), ...(everyone && { everyone: '1' }) } })
