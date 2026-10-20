// A small Markdown subset for job descriptions, safe by construction: every character is HTML-escaped first,
// then only these become tags: # headings, **bold**, *italic*, `code`, [links](https://…), - / * / – lists,
// 1. lists, paragraphs and line breaks. Links accept http(s) and mailto only. Raw HTML shows as text.
// ponytail: no tables, images or nested lists; swap in a parser plus a sanitiser if descriptions need them.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
const escape = (s: string) => s.replace(/[&<>"']/g, c => ESC[c]!)

function inline(s: string) {
  return escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>')
}

const BULLET = /^\s*[-*–]\s+(.*)$/
const NUMBER = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,3})\s+(.*)$/

// headingBase: the level a single # becomes, so the page's own h1 stays the only h1
export function renderMarkdown(src: string, headingBase = 2): string {
  const out: string[] = []
  let para: string[] = []
  let list = null as { tag: 'ul' | 'ol', items: string[] } | null // 'as': TS can't see the closures below reassign it
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] }
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null }

  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    const h = HEADING.exec(line)
    const b = BULLET.exec(line)
    const n = NUMBER.exec(line)
    if (!line.trim()) { flushPara(); flushList() }
    else if (h) {
      flushPara(); flushList()
      const level = Math.min(headingBase + h[1]!.length - 1, 6)
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`)
    }
    else if (b || n) {
      flushPara()
      const tag = b ? 'ul' : 'ol'
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] } }
      list!.items.push((b ?? n)![1]!)
    }
    else { flushList(); para.push(line) }
  }
  flushPara(); flushList()
  return out.join('\n')
}
