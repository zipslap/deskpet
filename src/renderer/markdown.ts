/**
 * A tiny, safe markdown renderer for replies: paragraphs, bullet/numbered lists, headings, fenced code, and inline
 * `code`, **bold** and *italic*. It builds DOM nodes with textContent only (never innerHTML), so reply text can never
 * become markup, and links are shown as plain text. A half-finished reply (an open code fence, a lone `*`) renders sanely.
 */
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*]))/g

function inline(parent: HTMLElement, text: string): void {
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) parent.append(text.slice(last, m.index))
    const tok = m[0]
    const el = document.createElement(tok.startsWith('`') ? 'code' : tok.startsWith('**') ? 'strong' : 'em')
    el.textContent = tok.startsWith('**') ? tok.slice(2, -2) : tok.slice(1, -1)
    parent.append(el)
    last = m.index! + tok.length
  }
  if (last < text.length) parent.append(text.slice(last))
}

export function renderMarkdown(into: HTMLElement, source: string): void {
  into.replaceChildren()
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  let para: string[] = []
  const flush = (): void => {
    if (para.length === 0) return
    const p = document.createElement('p')
    inline(p, para.join('\n'))
    into.append(p)
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!)
      i++ // closing fence (or the end of a reply still streaming)
      const pre = document.createElement('pre')
      const c = document.createElement('code')
      c.textContent = code.join('\n')
      pre.append(c)
      into.append(pre)
      continue
    }
    const list = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (list) {
      flush()
      const ordered = /\d/.test(list[1]!)
      const el = document.createElement(ordered ? 'ol' : 'ul')
      while (i < lines.length) {
        const m = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(lines[i]!)
        if (!m || /\d/.test(m[1]!) !== ordered) break
        const li = document.createElement('li')
        inline(li, m[2]!)
        el.append(li)
        i++
      }
      into.append(el)
      continue
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const el = document.createElement('p')
      el.className = 'md-h'
      inline(el, h[1]!)
      into.append(el)
      i++
      continue
    }
    if (line.trim() === '') flush()
    else para.push(line)
    i++
  }
  flush()
}
