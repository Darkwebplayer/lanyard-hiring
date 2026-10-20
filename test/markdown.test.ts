import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../app/utils/markdown'

describe('job description markdown', () => {
  it('renders the subset: headings, emphasis, lists, links, paragraphs', () => {
    const html = renderMarkdown('# About\nWe ship **parcels** and *fast*.\nSecond line\n\n- one\n– two\n\n1. first\n2. second\n\nSee [the blog](https://example.com/blog).')
    expect(html).toBe([
      '<h2>About</h2>',
      '<p>We ship <strong>parcels</strong> and <em>fast</em>.<br>Second line</p>',
      '<ul><li>one</li><li>two</li></ul>',
      '<ol><li>first</li><li>second</li></ol>',
      '<p>See <a href="https://example.com/blog" target="_blank" rel="noopener nofollow">the blog</a>.</p>',
    ].join('\n'))
  })

  it('never lets HTML or script URLs through', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> <script>x</script>\n[click](javascript:alert(1)) [x](https://a.test" onmouseover="y)')
    expect(html).not.toMatch(/<img|<script|href="javascript|" onmouseover/)
    expect(html).toContain('&lt;img')
  })
})
