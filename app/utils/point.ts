// Take the person to one part of the page and outline it in ink for 2 seconds (Ask's source chips, Updates links).
// id: an element id, or a data-ask value ("node:interview"). A heading points at its whole section. False if not on the page.
export function point(id: string) {
  const found = document.getElementById(id) ?? document.querySelector<HTMLElement>(`[data-ask="${CSS.escape(id)}"]`)
  const el = found?.matches('h1, h2, h3') ? found.closest<HTMLElement>('section') ?? found : found
  if (!el) return false
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  el.classList.add('ask-hl')
  setTimeout(() => el.classList.remove('ask-hl'), 2000)
  return true
}
