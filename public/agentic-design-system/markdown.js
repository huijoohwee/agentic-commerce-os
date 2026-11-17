import { computeTooltipPositionFromAnchor, constrainTooltipPosition, getTooltipPortalTarget } from './hover-text.js'
import { createColorPalette, DEFAULT_COLOR_SWATCHES } from './color.js'

const command = (id, label, glyph, extra = {}) => Object.freeze({ id, label, glyph, ...extra, ...(extra.wrap ? {wrap:Object.freeze([...extra.wrap])} : {}) })
/** One semantic/syntax registry for native and framework editors. Product callbacks are never executed by parsing. */
export const MARKDOWN_COMMANDS = Object.freeze([
  command('heading1', 'Heading 1', 'H₁', { prefix: '# ' }),
  command('heading2', 'Heading 2', 'H₂', { prefix: '## ' }),
  command('heading3', 'Heading 3', 'H₃', { prefix: '### ' }),
  command('bold', 'Bold', 'B', { wrap: ['**', '**'] }),
  command('italic', 'Italic', '𝑰', { wrap: ['*', '*'] }),
  command('strike', 'Strikethrough', 'S̶', { wrap: ['~~', '~~'] }),
  command('inlineCode', 'Inline Code', '‹›', { wrap: ['`', '`'] }),
  command('link', 'Link', '↗'), command('bulletList', 'Bulleted List', '•', { prefix: '- ' }),
  command('numberedList', 'Numbered List', '1.', { prefix: '1. ' }),
  command('blockquote', 'Quote', '❞', { prefix: '> ' }),
  command('slashCommands', 'Slash commands', '/'), command('variableCommands', 'Variable commands', '@'),
  command('indent', 'Indentation', '⇥'), command('outdent', 'Decrease indentation', '⇤'),
  command('underline', 'Underline', 'U̲', { wrap: ['<u>', '</u>'] }),
  command('superscript', 'Superscript', 'x²', { wrap: ['^', '^'] }),
  command('subscript', 'Subscript', 'x₂', { wrap: ['~', '~'] }),
  command('math', 'Math', '∑', { wrap: ['$', '$'] }),
  command('highlight', 'Highlight', '▰', { wrap: ['==', '=='] }),
  command('comment', 'Comment', '☷', { wrap: ['<!-- ', ' -->'] }),
  command('clearFormatting', 'Clear Formatting', '⌫'), command('colorPalette', 'Color Palette', '◉'),
])
export function getMarkdownCommand(id) {
  const found = MARKDOWN_COMMANDS.find(item => item.id === id)
  if (!found) throw new RangeError(`Unknown Markdown command: ${id}`)
  return found
}
export function markdownCommandMatches(query = '') {
  const term = String(query).replace(/^[\/@]/, '').toLowerCase()
  return MARKDOWN_COMMANDS.filter(item => `${item.id} ${item.label}`.toLowerCase().includes(term))
}
export function clampMarkdownSelection(text, selection = {}) {
  const number = value => Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0
  const a = Math.max(0, Math.min(text.length, number(selection.startOffset)))
  const b = Math.max(0, Math.min(text.length, number(selection.endOffset)))
  return { startOffset: Math.min(a, b), endOffset: Math.max(a, b) }
}
export function wrapMarkdownSelection(text, selection, left, right) {
  const { startOffset: start, endOffset: end } = clampMarkdownSelection(text, selection)
  const wrapped = start >= left.length && text.slice(start - left.length, start) === left && text.slice(end, end + right.length) === right
  if (wrapped) return { nextText: text.slice(0, start - left.length) + text.slice(start, end) + text.slice(end + right.length),
    nextSelection: { startOffset: start - left.length, endOffset: end - left.length } }
  return { nextText: text.slice(0, start) + left + text.slice(start, end) + right + text.slice(end),
    nextSelection: { startOffset: start + left.length, endOffset: end + left.length } }
}
export function toggleHeadingAcrossLines({ text, level }) {
  if (!Number.isInteger(level) || level < 1 || level > 6) throw new RangeError('Heading level must be 1–6')
  const prefix = '#'.repeat(level) + ' ', lines = String(text).split(/\r?\n/)
  const remove = lines.every(line => !line.trim() || line.startsWith(prefix))
  return lines.map(line => !line.trim() ? line : remove ? line.slice(prefix.length) : prefix + line.replace(/^#{1,6}\s+/, '')).join('\n')
}
export function clearMarkdownFormatting(text) {
  text = String(text)
  // Protect literal code contents before removing surrounding formatting.
  const used = new Set([...text.matchAll(/\0c(\d+):\0/g)].map(match=>Number(match[1])))
  let id=0; while(used.has(id)) id++
  const prefix=`\0c${id}:\0`, code=[]
  const stash=content=>`${prefix}${code.push(content)-1}\0`
  let plain=text.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]{0,3}\1[ \t]*$/gm,(_,marker,content)=>stash(content))
  plain=plain.replace(/(`+)([^\n]*?)\1/g,(whole,marker,content,offset,input)=>{
    let escapes=0;for(let i=offset-1;i>=0&&input[i]==='\\';i--)escapes++
    return escapes%2?whole:stash(content)
  })
  plain=plain.replace(/^([ \t]*)(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '$1')
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, value => value.slice(4, -3).trim())
    .replace(/<\/?(?:u|sup|sub|mark|span|strong|em|s|del)(?:\s[^>]*)?>/gi, '')
    .replace(/(\*\*|__|~~|==)([\s\S]+?)\1/g, '$2').replace(/([*_^~$])([^\s][^\n]*?)\1/g, '$2')
  return plain.replace(new RegExp(`\\0c${id}:\\0(\\d+)\\0`,'g'),(_,index)=>code[Number(index)])
}

export function applyMarkdownFormatAction({ text, selection, action, value }) {
  text = String(text)
  const descriptor = getMarkdownCommand(action), sel = clampMarkdownSelection(text, selection)
  if (descriptor.wrap) return wrapMarkdownSelection(text, sel, ...descriptor.wrap)
  const { startOffset: a, endOffset: b } = sel
  if (action === 'link') {
    const label = text.slice(a, b), replacement = `[${label}]()`
    const cursor = a + (label ? label.length + 3 : 1)
    return { nextText: text.slice(0, a) + replacement + text.slice(b), nextSelection: { startOffset: cursor, endOffset: cursor } }
  }
  if (action === 'colorPalette') {
    if (!/^#[0-9a-f]{6}$/i.test(value || '')) throw new TypeError('A six-digit hex colour is required')
    const open = `<span style="color:${value.toLowerCase()}">`
    const previous = text.slice(0,a).match(/<span style="color:#[0-9a-f]{6}">$/i)
    if (previous && text.slice(b,b+7) === '</span>') return {
      nextText:text.slice(0,a-previous[0].length)+open+text.slice(a), nextSelection:sel,
    }
    return wrapMarkdownSelection(text, sel, open, '</span>')
  }
  if (['slashCommands', 'variableCommands'].includes(action)) {
    const next = action === 'slashCommands' ? '/' : '@'
    return { nextText: text.slice(0, a) + next + text.slice(b), nextSelection: { startOffset: a + 1, endOffset: a + 1 } }
  }
  if (action === 'clearFormatting') {
    const next = clearMarkdownFormatting(text.slice(a, b))
    return { nextText: text.slice(0, a) + next + text.slice(b), nextSelection: { startOffset: a, endOffset: a + next.length } }
  }
  const start = (a === 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1)
  const last = b > a && text[b - 1] === '\n' ? b - 1 : b
  const endAt = text.indexOf('\n', last), end = endAt < 0 ? text.length : endAt
  const block = text.slice(start, end), lines = block.split('\n')
  let next
  if (/^heading[1-6]$/.test(action)) next = toggleHeadingAcrossLines({ text: block, level: Number(action.slice(-1)) })
  else if (action === 'indent') next = lines.map(line => '  ' + line).join('\n')
  else if (action === 'outdent') next = lines.map(line => line.replace(/^(?: {1,2}|\t)/, '')).join('\n')
  else {
    const prefix = descriptor.prefix
    const numbered = action === 'numberedList'
    const allHave = lines.every(line => !line.trim() || (numbered ? /^\d+\.\s+/.test(line) : line.startsWith(prefix)))
    next = lines.map((line, index) => !line.trim() ? line : numbered
      ? allHave ? line.replace(/^\d+\.\s+/, '') : `${index + 1}. ${line.replace(/^\d+\.\s+/, '')}`
      : allHave ? line.slice(prefix.length) : prefix + line).join('\n')
  }
  return { nextText: text.slice(0, start) + next + text.slice(end),
    nextSelection: { startOffset: a, endOffset: Math.max(a, Math.min(text.length + next.length - block.length, b + next.length - block.length)) } }
}
/** Native toolbar used by React too. Hosts retain selection/document and product command execution. */
export function createMarkdownToolbar({ document: doc = globalThis.document, onCommand, onInteractionStart, onInteractionEnd, commands = MARKDOWN_COMMANDS, swatches = DEFAULT_COLOR_SWATCHES }) {
  if (!doc?.createElement || typeof onCommand !== 'function') throw new TypeError('Document and command callback are required')
  const root = doc.createElement('div'); root.className = 'agentic-markdown-toolbar'; root.role = 'toolbar'; root.ariaLabel = 'Text formatting'
  const run = (id, value) => { getMarkdownCommand(id); onInteractionStart?.(); try { onCommand(id, value) } finally { onInteractionEnd?.() } }
  const down = event => { if (!event.target.closest('input')) { onInteractionStart?.(); event.preventDefault() } }
  root.addEventListener('pointerdown', down)
  let palette = null
  for (const descriptor of commands) {
    const { id, label, glyph } = getMarkdownCommand(typeof descriptor === 'string' ? descriptor : descriptor.id)
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'agentic-toolbar-item'; button.dataset.iconOnly = ''; button.dataset.markdownCommand = id
    button.ariaLabel = label; button.title = label; button.textContent = glyph
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (id !== 'colorPalette') return run(id)
      if (palette) { palette.destroy(); palette = null; button.ariaExpanded = 'false'; return }
      const section = doc.createElement('section'); section.className = 'agentic-color-palette'; section.role = 'dialog'; section.ariaLabel = 'Color Palette'
      const colors = createColorPalette(section, { value: '#000000', swatches, onValueChange: color => run(id, color) })
      const close = doc.createElement('button'); close.type = 'button'; close.className = 'agentic-toolbar-item'; close.textContent = 'Done'
      const win=doc.defaultView
      section.classList.add('agentic-rich-text-popover')
      const position=()=>{
        if(!section.isConnected)return
        const pos=constrainTooltipPosition({pos:computeTooltipPositionFromAnchor(button,4),tooltipRect:section.getBoundingClientRect(),anchorRect:button.getBoundingClientRect(),viewportW:win.innerWidth,viewportH:win.innerHeight,paddingPx:8,offsetPx:4})
        section.style.left=`${pos.left}px`;section.style.top=`${pos.top}px`
      }
      const dismiss=()=>{palette?.destroy();palette=null;button.ariaExpanded='false'}
      const outside=event=>{if(!section.contains(event.target)&&!button.contains(event.target))dismiss()}
      const key=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();button.focus({preventScroll:true})}}
      section.addEventListener('pointerdown',event=>{onInteractionStart?.();event.stopPropagation()})
      section.addEventListener('click',event=>event.stopPropagation())
      const observer=win.ResizeObserver?new win.ResizeObserver(position):null
      palette = { destroy() { observer?.disconnect();win.removeEventListener('resize',position);doc.removeEventListener('scroll',position,true);doc.removeEventListener('pointerdown',outside,true);doc.removeEventListener('keydown',key,true);colors.destroy();section.remove() } }
      close.onclick=()=>{dismiss();button.focus({preventScroll:true})}
      section.prepend(close);getTooltipPortalTarget(button).append(section)
      win.addEventListener('resize',position);doc.addEventListener('scroll',position,true);doc.addEventListener('pointerdown',outside,true);doc.addEventListener('keydown',key,true)
      observer?.observe(section);position();button.ariaExpanded='true';button.ariaHasPopup='dialog'
    })
    root.append(button)
  }
  return { element: root, destroy() { palette?.destroy(); root.removeEventListener('pointerdown', down); root.remove() } }
}
export function attachMarkdownEditor(field, options = {}) {
  if (!field || !(field.tagName === 'TEXTAREA' || field.tagName === 'INPUT' && field.type === 'text')) throw new TypeError('A text field is required')
  const doc = field.ownerDocument, container = doc.createElement('div'); container.className = 'agentic-rich-text'
  const limitStatus = doc.createElement('output'); limitStatus.role = 'status'; limitStatus.ariaLive = 'polite'; limitStatus.hidden = true; container.append(limitStatus)
  const clearLimit = () => { limitStatus.hidden = true }; field.addEventListener('input', clearLimit)
  let selection = { startOffset: field.selectionStart || 0, endOffset: field.selectionEnd || 0 }
  const capture = () => { selection = { startOffset: field.selectionStart || 0, endOffset: field.selectionEnd || 0 } }
  const toolbar = createMarkdownToolbar({ ...options, document: doc, onInteractionStart: capture, onCommand(action, value) {
    const callback = action === 'slashCommands' ? options.onSlashCommand : action === 'variableCommands' ? options.onVariableCommand : null
    if (callback) return callback()
    const result = applyMarkdownFormatAction({ text: field.value, selection, action, value })
    if (field.maxLength >= 0 && result.nextText.length > field.maxLength) { limitStatus.textContent = 'Formatting exceeds this field’s character limit.'; limitStatus.hidden = false; return }
    clearLimit();
    const prototype = field.tagName === 'TEXTAREA' ? doc.defaultView.HTMLTextAreaElement.prototype : doc.defaultView.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, result.nextText); field.focus({ preventScroll: true }); field.setSelectionRange(result.nextSelection.startOffset, result.nextSelection.endOffset)
    field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); options.onChange?.(field.value)
  } })
  field.before(container); container.append(field); container.prepend(toolbar.element)
  return { destroy() { field.removeEventListener('input', clearLimit); toolbar.destroy(); container.before(field); container.remove() } }
}
