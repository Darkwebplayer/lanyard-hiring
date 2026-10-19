export default defineEventHandler(event => useAuth(event).handler(toWebRequest(event)))
