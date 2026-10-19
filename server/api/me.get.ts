export default defineEventHandler(async (event) => {
  const { user, level } = await requireUser(event)
  return { id: user.id, name: user.name, email: user.email, image: user.image, level }
})
