import {
  HOVER_PARTS, HOVER_BEHAVIOR, HOVER_DISMISS_EVENT,
  computeTooltipPositionFromAnchor, computeTooltipMaxWidthPx, constrainTooltipPosition, getTooltipPortalTarget,
} from './hover-text.js'

const LABEL_OWNER = Symbol.for('agentic-design-system/hover-label-owner/v1')
const ID_OWNER = Symbol.for('agentic-design-system/hover-id-owner/v1')
const protectedStyle = /^(?:background|color$|font|lineHeight$|padding|margin|border|boxShadow$|position$|zIndex$|transform$|pointerEvents$|(?:max|min)?(?:Width|Height)$|--agentic-hover)/i
const unitless = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order'])
const isElement = value => Boolean(value?.ownerDocument?.defaultView?.Element
  && value instanceof value.ownerDocument.defaultView.Element)
const idOwner = doc => {
  const current = doc[ID_OWNER]
  if (current) {
    if (!Number.isSafeInteger(current.next) || current.next < 0 || Object.prototype.toString.call(current.ids) !== '[object Set]')
      throw new Error('Conflicting hover ID owner')
    return current
  }
  const state = { next: 0, ids: new Set() }
  Object.defineProperty(doc, ID_OWNER, { value: state })
  return state
}
const generatedId = (doc, state) => {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = 'agentic-hover-' + (++state.next)
    if (!state.ids.has(id) && !doc.getElementById(id)) return id
  }
  throw new Error('Hover ID namespace is occupied')
}
const addDescription = (node, id) => {
  if (!isElement(node)) return
  const ids = new Set((node.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean))
  ids.add(id); node.setAttribute('aria-describedby', [...ids].join(' '))
}
const removeDescription = (node, id) => {
  const ids = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id)
  if (ids.length) node.setAttribute('aria-describedby', ids.join(' '))
  else node.removeAttribute('aria-describedby')
}

export function dismissHoverPanels(ownerDocument = globalThis.document) {
  const win = ownerDocument?.defaultView
  if (!win) throw new TypeError('Hover dismissal requires an owner document')
  ownerDocument.dispatchEvent(new win.Event(HOVER_DISMISS_EVENT))
}

/** One DOM lifecycle for native consumers and framework bridges. Content is never interpreted as HTML. */
export function createHoverPanel(anchor, initial = {}) {
  if (!isElement(anchor)) throw new TypeError('Hover anchor must be an Element')
  const doc = anchor.ownerDocument, win = doc.defaultView
  if (anchor.hasAttribute('data-agentic-hover-id')) throw new Error('Hover anchor already has an owner')
  const element = doc.createElement('section'), contentElement = doc.createElement('section')
  const ids = idOwner(doc), id = initial.id || generatedId(doc, ids)
  if (typeof id !== 'string' || /\s/.test(id) || doc.getElementById(id) || ids.ids.has(id)) throw new TypeError('Hover ID must be unique')
  ids.ids.add(id)
  element.id = id; element.setAttribute('role', 'tooltip'); element.dataset.agenticHoverRoot = '1'
  contentElement.className = 'agentic-hover-content'; element.append(contentElement)
  let options = {}, visible = false, destroyed = false, frame = null, observer = null
  let scrollDelay = null, scrollTimer = null, scrollAllowed = false, delayElapsed = false
  let styleKeys = new Set(), dataKeys = new Set()
  const described = new Set()
  const stopScroll = () => {
    if (scrollDelay !== null) win.clearTimeout(scrollDelay)
    if (scrollTimer !== null) win.clearInterval(scrollTimer)
    scrollDelay = scrollTimer = null; scrollAllowed = delayElapsed = false
    element.scrollTop = 0
  }
  const px = (style, name) => {
    const value = style.getPropertyValue(name).trim()
    if (!/^[0-9]+(?:\.[0-9]+)?px$/.test(value)) throw new Error('Missing shared hover CSS token: ' + name)
    return Number.parseFloat(value)
  }
  const reposition = () => {
    if (destroyed || !visible || !anchor.isConnected) return
    const style = win.getComputedStyle(element)
    if (style.position !== 'fixed') throw new Error('Missing shared hover stylesheet')
    const gap = px(style, '--agentic-hover-anchor-gap'), edge = px(style, '--agentic-hover-edge-gap')
    const defaultWidth = px(style, options.widthRole === 'label' ? '--agentic-hover-width-label' : '--agentic-hover-width-default')
    const width = options.contentSize?.width || computeTooltipMaxWidthPx(anchor, {
      maxWidthPx: options.maxWidthPx, maxWidthFromPrevSibling: options.maxWidthFromPrevSibling, defaultMaxWidthPx: defaultWidth,
    })
    element.style.setProperty('--agentic-hover-width', width + 'px')
    element.style.inlineSize = options.contentSize?.width ? options.contentSize.width + 'px' : 'max-content'
    element.style.blockSize = options.contentSize?.height ? options.contentSize.height + 'px' : ''
    const pos = computeTooltipPositionFromAnchor(anchor, gap), offset = options.contentOffset || { x: 0, y: 0 }
    element.style.transform = 'translateX(-50%)'
    element.style.left = pos.left + offset.x + 'px'; element.style.top = pos.top + offset.y + 'px'
    const next = constrainTooltipPosition({
      pos: { left: pos.left + offset.x, top: pos.top + offset.y }, tooltipRect: element.getBoundingClientRect(),
      anchorRect: anchor.getBoundingClientRect(), viewportW: Math.max(1, win.innerWidth),
      viewportH: Math.max(1, win.innerHeight), paddingPx: edge, offsetPx: gap,
    })
    element.style.left = next.left + 'px'; element.style.top = next.top + 'px'
  }
  const schedulePosition = () => {
    if (!visible || destroyed || frame !== null) return
    frame = win.requestAnimationFrame(() => { frame = null; reposition() })
  }
  const associate = target => {
    const node = isElement(target) && anchor.contains(target) ? target : anchor
    addDescription(node, id); described.add(node)
  }
  const setOpen = next => {
    if (destroyed || visible === next) return
    visible = next
    if (visible) {
      getTooltipPortalTarget(anchor).append(element); associate(anchor)
      win.addEventListener('resize', schedulePosition); win.addEventListener('scroll', schedulePosition, true)
      doc.addEventListener('keydown', onKey, true); doc.addEventListener(HOVER_DISMISS_EVENT, dismiss)
      if (win.ResizeObserver) { observer = new win.ResizeObserver(schedulePosition); observer.observe(element) }
      try { reposition() } catch (error) { setOpen(false); throw error }
      options.onVisibilityChange?.(element)
    } else {
      observer?.disconnect(); observer = null
      win.removeEventListener('resize', schedulePosition); win.removeEventListener('scroll', schedulePosition, true)
      doc.removeEventListener('keydown', onKey, true); doc.removeEventListener(HOVER_DISMISS_EVENT, dismiss)
      if (frame !== null) win.cancelAnimationFrame(frame)
      frame = null; stopScroll()
      for (const node of described) removeDescription(node, id)
      described.clear(); element.remove(); options.onVisibilityChange?.(null)
    }
  }
  const dismiss = () => { if (typeof options.open !== 'boolean') setOpen(false) }
  const onKey = event => { if (event.key === 'Escape') dismiss() }
  const enter = event => {
    if (typeof options.open !== 'boolean') setOpen(true)
    else if (visible) reposition()
    if (visible) associate(event.target)
  }
  const leave = event => {
    if (event.type === 'mouseleave' && anchor.contains(doc.activeElement)) return
    if (isElement(event.relatedTarget) && (anchor.contains(event.relatedTarget)
      || options.interactive !== false && element.contains(event.relatedTarget))) return
    if (typeof options.open !== 'boolean') setOpen(false)
  }
  const startScroll = () => {
    if (scrollTimer !== null || !scrollAllowed || options.interactive === false
      || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    if (element.scrollHeight <= element.clientHeight) return
    scrollTimer = win.setInterval(() => {
      const max = element.scrollHeight - element.clientHeight
      element.scrollTop = element.scrollTop + 1 >= max ? 0 : element.scrollTop + 1
    }, HOVER_BEHAVIOR.scrollIntervalMs)
  }
  const contentEnter = () => {
    if (options.interactive === false) return
    options.onContentMouseEnter?.()
    if (scrollDelay !== null) return
    scrollDelay = win.setTimeout(() => {
      scrollDelay = null; delayElapsed = true; startScroll()
    }, HOVER_BEHAVIOR.scrollDelayMs)
  }
  const contentLeave = event => {
    if (options.interactive === false) return
    options.onContentMouseLeave?.(); stopScroll(); leave(event)
  }
  const contentMove = event => {
    if (options.interactive === false) return
    const rect = element.getBoundingClientRect(), fraction = rect.height ? (event.clientY - rect.top) / rect.height : 0
    scrollAllowed = fraction > .25 && fraction < .95
    if (!scrollAllowed) { stopScroll(); return }
    if (delayElapsed) startScroll()
  }
  const update = patch => {
    if (destroyed) throw new Error('Hover panel is destroyed')
    const next = { ...options, ...patch }
    if (next.id !== undefined && next.id !== id) throw new TypeError('Hover ID is immutable')
    for (const value of [next.maxWidthPx, next.contentSize?.width, next.contentSize?.height,
      next.contentOffset?.x, next.contentOffset?.y]) {
      if (value !== undefined && !Number.isFinite(value)) throw new TypeError('Hover geometry must be finite')
    }
    if ([next.maxWidthPx, next.contentSize?.width, next.contentSize?.height].some(value => value !== undefined && value < 0))
      throw new TypeError('Hover sizes must be nonnegative')
    for (const [name, value] of Object.entries(next.contentDataAttrs || {})) {
      if (!/^data-[a-z0-9-]+$/.test(name) || name.startsWith('data-agentic-hover')
        || value !== undefined && typeof value !== 'string')
        throw new TypeError('Invalid hover data attribute')
    }
    const content = next.content
    if (content !== undefined && typeof content !== 'string' && typeof content !== 'number'
      && (!content || ![1, 3, 11].includes(content.nodeType) || content.ownerDocument !== doc
        || content === anchor || content.contains?.(anchor))) throw new TypeError('Hover content requires same-document nodes or text')
    options = next
    element.className = [HOVER_PARTS.panel, options.contentClassName || ''].filter(Boolean).join(' ')
    element.dataset.interactive = options.interactive === false ? 'false' : 'true'
    for (const key of dataKeys) element.removeAttribute(key)
    dataKeys = new Set()
    for (const [key, value] of Object.entries(options.contentDataAttrs || {})) {
      if (value !== undefined) { element.setAttribute(key, value); dataKeys.add(key) }
    }
    for (const key of styleKeys) {
      if (key.startsWith('--')) element.style.removeProperty(key)
      else element.style[key] = ''
    }
    styleKeys = new Set()
    for (const [key, value] of Object.entries(options.contentStyle || {})) {
      if (value === null || value === undefined || protectedStyle.test(key)) continue
      if (key.startsWith('--')) element.style.setProperty(key, String(value))
      else element.style[key] = typeof value === 'number' && value !== 0 && !unitless.has(key) ? value + 'px' : String(value)
      styleKeys.add(key)
    }
    if (Object.hasOwn(patch, 'content') && content !== undefined) contentElement.replaceChildren(content)
    if (typeof options.open === 'boolean') setOpen(options.open)
    if (visible) reposition()
  }
  anchor.setAttribute('data-agentic-hover-anchor', '1'); anchor.setAttribute('data-agentic-hover-id', id)
  anchor.addEventListener('mouseenter', enter); anchor.addEventListener('mouseleave', leave)
  anchor.addEventListener('focusin', enter); anchor.addEventListener('focusout', leave)
  element.addEventListener('mouseenter', contentEnter); element.addEventListener('mouseleave', contentLeave)
  element.addEventListener('mousemove', contentMove); element.addEventListener('load', schedulePosition, true)
  const destroy = () => {
    if (destroyed) return
    setOpen(false); destroyed = true
    ids.ids.delete(id)
    anchor.removeEventListener('mouseenter', enter); anchor.removeEventListener('mouseleave', leave)
    anchor.removeEventListener('focusin', enter); anchor.removeEventListener('focusout', leave)
    element.removeEventListener('mouseenter', contentEnter); element.removeEventListener('mouseleave', contentLeave)
    element.removeEventListener('mousemove', contentMove); element.removeEventListener('load', schedulePosition, true)
    if (anchor.getAttribute('data-agentic-hover-id') === id) {
      anchor.removeAttribute('data-agentic-hover-id'); anchor.removeAttribute('data-agentic-hover-anchor')
    }
  }
  try { update(initial) } catch (error) { destroy(); throw error }
  return { element, contentElement, update, reposition, destroy, get visible() { return visible } }
}

/** One delegated title owner per document, including dynamically mounted controls. */
export function installHoverLabels(ownerDocument = globalThis.document, { fallbackAttribute } = {}) {
  const doc = ownerDocument, win = doc?.defaultView
  if (!win?.MutationObserver || !doc.body) throw new TypeError('Hover labels require a browser document')
  if (fallbackAttribute !== undefined && !/^data-[a-z0-9-]+$/.test(fallbackAttribute)) throw new TypeError('Invalid hover label fallback')
  const previous = doc[LABEL_OWNER]
  if (previous) {
    if (previous.fallbackAttribute !== fallbackAttribute) throw new Error('Conflicting hover label owner')
    previous.refs++
    let released = false
    return () => { if (!released) { released = true; previous.release() } }
  }
  const state = { refs: 1, fallbackAttribute, release: null }
  const selector = '[title]' + (fallbackAttribute ? ',[' + fallbackAttribute + ']' : '')
  let active = null, observer = null, panel = null
  const restore = () => {
    observer?.disconnect(); observer = null; panel?.destroy(); panel = null
    if (!active) return
    const { element, title, text, addedLabel } = active
    if (element.getAttribute('title') === '') {
      if (title === null) element.removeAttribute('title')
      else element.setAttribute('title', title)
    }
    if (addedLabel && element.getAttribute('aria-label') === text) element.removeAttribute('aria-label')
    active = null
  }
  const renderActive = () => {
    if (!active?.delegated || panel) return
    try { panel = createHoverPanel(active.element, { content: active.text, open: true, interactive: false, widthRole: 'label' }) }
    catch (error) { restore(); throw error }
  }
  const show = target => {
    if (!isElement(target)) return
    const element = target.closest(selector)
    if (element === active?.element) return
    const title = element?.getAttribute('title') ?? null
    const text = (title ?? (fallbackAttribute && element?.getAttribute(fallbackAttribute)))?.trim()
    restore()
    if (!element || !text) return
    const delegated = !element.closest('[data-agentic-hover-anchor="1"]')
    const addedLabel = !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && !element.labels?.length
      && !element.textContent?.trim() && element.matches('button,a[href],input,select,textarea,[role="button"]')
    active = { element, title, text, delegated, addedLabel }
    element.setAttribute('title', '')
    if (addedLabel) element.setAttribute('aria-label', text)
    renderActive()
    observer = new win.MutationObserver(() => {
      if (!active) return
      if (!element.isConnected) { restore(); return }
      const next = element.getAttribute('title')
      if (next === '') return
      if (!next?.trim()) { restore(); return }
      const previousText = active.text
      active.title = next; active.text = next.trim(); element.setAttribute('title', '')
      if (active.addedLabel) {
        if (element.getAttribute('aria-label') === previousText) element.setAttribute('aria-label', active.text)
        else active.addedLabel = false
      }
      panel?.update({ content: active.text })
    })
    observer.observe(doc.body, { childList: true, subtree: true })
    observer.observe(element, { attributes: true, attributeFilter: ['title'] })
  }
  const enter = event => {
    if (event.type === 'focusin' && isElement(event.target) && event.target.closest(selector) === active?.element) renderActive()
    else show(event.target)
  }
  const leave = event => {
    if (!active || event.relatedTarget?.nodeType && active.element.contains(event.relatedTarget)) return
    if (event.type === 'mouseout' && active.element.contains(doc.activeElement)) return
    restore()
  }
  const dismiss = () => { panel?.destroy(); panel = null }
  const key = event => { if (event.key === 'Escape') dismiss() }
  for (const name of ['mouseover', 'focusin']) doc.addEventListener(name, enter, true)
  for (const name of ['mouseout', 'focusout']) doc.addEventListener(name, leave, true)
  doc.addEventListener('pointerdown', dismiss, true); doc.addEventListener('keydown', key, true)
  doc.addEventListener(HOVER_DISMISS_EVENT, dismiss)
  const release = () => {
    if (state.refs <= 0) return
    if (--state.refs) return
    for (const name of ['mouseover', 'focusin']) doc.removeEventListener(name, enter, true)
    for (const name of ['mouseout', 'focusout']) doc.removeEventListener(name, leave, true)
    doc.removeEventListener('pointerdown', dismiss, true); doc.removeEventListener('keydown', key, true)
    doc.removeEventListener(HOVER_DISMISS_EVENT, dismiss); restore(); delete doc[LABEL_OWNER]
  }
  state.release = release; doc[LABEL_OWNER] = state
  let released = false
  return () => { if (!released) { released = true; release() } }
}
