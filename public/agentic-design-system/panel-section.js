/** Canonical section mechanics. Hosts own content, persistence and available geometry. */
export const PANEL_SECTION = Object.freeze({
  section: 'agentic-panel-section', header: 'agentic-panel-section-header',
  title: 'agentic-panel-section-title', actions: 'agentic-panel-section-actions',
  body: 'agentic-panel-section-body', scroll: 'agentic-panel-scroll-region',
  defaultCollapsed: true, expand: 'Expand section', collapse: 'Collapse section',
  expandAll: 'Expand All', collapseAll: 'Collapse All',
})

/** Restore focus before hiding content, without stealing focus from another section. */
export function recoverSectionFocus(body, trigger) {
  if (body?.contains(body.ownerDocument.activeElement)) trigger?.focus({ preventScroll: true })
}

export function isSectionGroupCollapsed(keys, collapsedKeys) {
  return keys.length > 0 && keys.every(key => collapsedKeys.has(key))
}
export function updateSectionGroup(previous, key, collapsed) {
  if (previous.has(key) === collapsed) return previous
  const next = new Set(previous)
  if (collapsed) next.add(key)
  else next.delete(key)
  return next
}

export function setPanelSectionExpanded(section, expanded) {
  if (section?.localName !== 'details' || typeof expanded !== 'boolean')
    throw new TypeError('A details section and boolean expansion state are required')
  const trigger = section.querySelector(':scope > summary')
  if (!trigger) throw new TypeError('A panel section requires a direct summary')
  if (!expanded && section.contains(section.ownerDocument.activeElement)
    && !trigger.contains(section.ownerDocument.activeElement)) trigger.focus({ preventScroll: true })
  if (section.open !== expanded) section.open = expanded
}

const installations = new WeakMap()
/** Enhance opted-in native details, retaining their nodes, events, values and native keys. */
export function installPanelSections(root = globalThis.document) {
  if (!root?.querySelectorAll || !root.addEventListener) throw new TypeError('A DOM root is required')
  if (installations.has(root)) return installations.get(root)
  const selector = 'details[data-agentic-section]'
  const prepare = section => {
    const summary = section.querySelector(':scope > summary')
    if (!summary) throw new TypeError('A panel section requires a direct summary')
    section.classList.add(PANEL_SECTION.section)
    summary.classList.add(PANEL_SECTION.header)
    summary.dataset.agenticSticky = section.dataset.agenticSticky === 'false' ? 'false' : 'true'
  }
  const refresh = () => {
    if (root.matches?.(selector)) prepare(root)
    root.querySelectorAll(selector).forEach(prepare)
  }
  const toggle = event => {
    const section = event.target
    if (!section.matches?.(selector) || section.open) return
    const summary = section.querySelector(':scope > summary')
    if (section.contains(section.ownerDocument.activeElement) && !summary.contains(section.ownerDocument.activeElement))
      summary.focus({ preventScroll: true })
  }
  const action = event => {
    const button = event.target.closest?.('[data-agentic-sections-action]')
    if (!button || !root.contains(button)) return
    const target = button.getAttribute('aria-controls')
    const group = target && (root.ownerDocument ?? root).getElementById(target)
    if (!group || !root.contains(group)) throw new TypeError('Section actions require a local aria-controls group')
    const sections = [...group.querySelectorAll(selector)]
    const command = button.dataset.agenticSectionsAction
    if (!['expand', 'collapse', 'toggle'].includes(command)) throw new TypeError('Unknown section action')
    const expanded = command === 'expand' || command === 'toggle' && sections.every(section => !section.open)
    sections.forEach(section => setPanelSectionExpanded(section, expanded))
  }
  refresh()
  root.addEventListener('toggle', toggle, true)
  root.addEventListener('click', action)
  const Observer = (root.ownerDocument ?? root).defaultView?.MutationObserver
  const observer = Observer && new Observer(refresh)
  observer?.observe(root, { childList: true, subtree: true })
  let active = true
  const dispose = () => {
    if (!active) return
    active = false
    observer?.disconnect()
    root.removeEventListener('toggle', toggle, true)
    root.removeEventListener('click', action)
    installations.delete(root)
  }
  installations.set(root, dispose)
  return dispose
}
