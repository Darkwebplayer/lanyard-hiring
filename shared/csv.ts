// RFC 4180 CSV for spreadsheet imports, parsed in the browser. The delimiter is sniffed from the
// header line (outside quotes): whichever of , ; or tab appears most, comma on a tie.
// Blank lines are kept as [''] so record numbers still match the spreadsheet's row numbers.
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const delim = sniff(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') field += ch
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else quoted = false
    }
    else if (ch === '"') quoted = true
    else if (ch === delim) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    }
    else field += ch
  }
  if (field || row.length) rows.push([...row, field]) // last line without a trailing newline
  return rows
}

function sniff(text: string) {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch in counts) counts[ch]!++
  }
  return [';', '\t'].reduce((best, d) => counts[d]! > counts[best]! ? d : best, ',')
}

// "Full name" columns: last word is the last name, the rest the first. One word = first name only.
export function splitName(full: string): { first: string, last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return { first: parts[0] ?? '', last: '' }
  return { first: parts.slice(0, -1).join(' '), last: parts.at(-1)! }
}
