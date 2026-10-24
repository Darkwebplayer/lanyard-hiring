import { jobsFeedXml, openJobs } from '../../domain/apply'

// No auth: every open job for job boards and aggregators, absolute links from the request's origin.
export default defineEventHandler(async (event) => {
  const now = new Date()
  setResponseHeaders(event, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' })
  return jobsFeedXml(getRequestURL(event).origin, await openJobs(useDb(event), now), now)
})
