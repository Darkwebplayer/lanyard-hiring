import { z } from 'zod'
import { validZone } from '../../domain/bookings'
import { listNotices } from '../../domain/notices'

// The Updates tray, fetched when it opens. ?tz and ?locale: the viewer's, for times and "per day" groups.
const query = z.object({
  tz: z.string().max(100).refine(validZone, 'unknown time zone').default('UTC'),
  locale: z.string().max(35).refine(l => Intl.DateTimeFormat.supportedLocalesOf(l).length > 0, 'unknown locale').default('en-GB'),
})

export default defineEventHandler(async (event) => {
  const actor = await requireUser(event)
  const { tz, locale } = await getValidatedQuery(event, query.parse)
  return listNotices(useDb(event), { userId: actor.user.id, level: actor.level }, tz, new Date(), false, locale)
})
