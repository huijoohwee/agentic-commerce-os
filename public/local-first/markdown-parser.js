/** Canonical Markdown-it configuration. Constructor/plugins are injected for native/offline bundlers. */
export const ALLOWLISTED_DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i
export function markdownItSuperscript(md) {
  const escaped = (text, index) => { let count = 0; for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) count++; return count % 2 === 1 }
  md.inline.ruler.after('emphasis', 'agentic_superscript', (state, silent) => {
    const start = state.pos
    if (state.src[start] !== '^' || escaped(state.src, start)) return false
    let end = start + 1
    while (end < state.posMax && (state.src[end] !== '^' || escaped(state.src, end))) end++
    if (end >= state.posMax || end === start + 1 || /\s/.test(state.src.slice(start + 1, end))) return false
    if (silent) { state.pos = end + 1; return true }
    const previous = state.posMax
    state.push('sup_open', 'sup', 1).markup = '^'; state.pos = start + 1; state.posMax = end
    state.md.inline.tokenize(state)
    state.push('sup_close', 'sup', -1).markup = '^'; state.pos = end + 1; state.posMax = previous
    return true
  })
}
export function createMarkdownParser(MarkdownIt, { mode = 'full', extensions = {} } = {}) {
  if (!['full', 'fast', 'fastHtml'].includes(mode) || typeof MarkdownIt !== 'function') throw new TypeError('A Markdown constructor and supported mode are required')
  const md = new MarkdownIt({ html: mode !== 'fast', linkify: mode === 'full', typographer: false, breaks: false })
  if (mode === 'full') {
    for (const name of ['footnote', 'subscript', 'mark']) if (extensions[name]) md.use(extensions[name])
    md.use(markdownItSuperscript)
    if (extensions.anchor) md.use(extensions.anchor, { permalink: false, level: [1, 2, 3, 4, 5, 6], slugify: extensions.slugify })
  }
  if (mode !== 'fast') {
    const validate = md.validateLink.bind(md)
    md.validateLink = url => ALLOWLISTED_DATA_IMAGE_RE.test(String(url || '').trim()) || validate(String(url || '').trim())
  }
  return md
}
