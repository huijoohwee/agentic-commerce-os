import { createIconButton } from './toolbar-icons.js'

export const PACK_TOOL = 'commerce.workspace.program-pack.create'

export const WORKSPACE_ROLES = Object.freeze({
  shop: Object.freeze({ label: 'Shopper', helpLabel: 'shopper', title: 'Shopper' }),
  vendor: Object.freeze({ label: 'Vendor', helpLabel: 'vendor', title: 'Vendor workspace' }),
  admin: Object.freeze({ label: 'Admin', helpLabel: 'admin', title: 'Admin workspace' }),
  sme: Object.freeze({ label: 'SME pack', helpLabel: 'SME pack', title: 'SME business pack' }),
  housing: Object.freeze({ label: 'Housing', helpLabel: 'housing comparison', title: 'Housing comparison' })
})

export const createElement = (tag, text, className) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

function toolbarLink(label, href) {
  const link = createElement('a', label, 'agentic-toolbar-item')
  link.href = href
  return link
}

function createCommerceToolbar({ packPage = false, workspaceHome = '' } = {}) {
  const toolbar = createElement('nav', undefined, 'agentic-toolbar')
  toolbar.setAttribute('aria-label', 'Workspace Toolbar')
  toolbar.dataset.scroll = ''
  const brand = toolbarLink(undefined, workspaceHome === null ? '#builder' : workspaceHome + '#shop')
  brand.setAttribute('aria-label', 'Airvio Commerce home')
  brand.append(createElement('strong', 'airvio'), createElement('small', 'Commerce'))
  toolbar.append(brand)

  if (workspaceHome !== null) {
    for (const [role, { label }] of Object.entries(WORKSPACE_ROLES)) {
      const link = toolbarLink(label, workspaceHome + '#' + role)
      link.dataset.workspaceDestination = role
      toolbar.append(link)
    }
  }

  const service = new URL(packPage ? './' : './services/workspace-pack/', location.href)
  toolbar.dataset.packService = service.href
  for (const [section, label] of [['builder', 'Workspace'], ['formats', 'Included files']]) {
    const link = toolbarLink(label, '#' + section)
    link.dataset.packDestination = section
    toolbar.append(link)
  }
  const status = createElement('span', 'Checking service', 'agentic-toolbar-status')
  status.dataset.packStatus = ''
  status.setAttribute('role', 'status')
  toolbar.append(status)
  return toolbar
}

// Dimensions, stroke and button states come from the pinned Design System helper.
const drawings = {
  start: 'M5.5 4.5h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM8 4.5v11',
  end: 'M6.5 6.5H4.25a2.25 2.25 0 1 1 2.25-2.25v11.5A2.25 2.25 0 1 1 4.25 13.5h11.5a2.25 2.25 0 1 1-2.25 2.25V4.25a2.25 2.25 0 1 1 2.25 2.25H6.5Z',
}
function edgeButton(edge, label, id) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path')
  svg.setAttribute('viewBox', '0 0 20 20')
  path.setAttribute('d', drawings[edge])
  svg.append(path)
  const button = createIconButton(label, svg)
  button.id = id
  button.dataset.dockEdge = edge
  button.title = label
  return button
}

function attachPanel(button, label, ...items) {
  const popover = createElement('div', undefined, 'commerce-flyout')
  popover.popover = 'auto'
  popover.id = button.id + '-panel'
  popover.dataset.edge = button.dataset.dockEdge
  const surface = createElement('section', undefined, 'agentic-base-floating-panel')
  const inner = createElement('div', undefined, 'agentic-base-floating-panel-inner')
  inner.append(createElement('h2', label, 'agentic-floating-panel-title'), ...items)
  surface.append(inner); popover.append(surface)
  popover.setAttribute('role', 'region'); popover.setAttribute('aria-label', label)
  button.popoverTargetElement = popover
  button.setAttribute('aria-controls', popover.id)
  button.setAttribute('aria-expanded', 'false')
  popover.addEventListener('beforetoggle', ({ newState }) => {
    const open = newState === 'open'
    button.setAttribute('aria-expanded', String(open))
    if (button.dataset.dockEdge === 'start' && button.popoverTargetElement) {
      button.title = open ? 'Hide navigation' : 'Show navigation'
      button.setAttribute('aria-label', button.title)
    }
  })
  items[0].autofocus = true
  popover.addEventListener('click', event => {
    if (event.target.closest('a,button')) popover.hidePopover()
  }, { capture: true })
  window.addEventListener('hashchange', () => popover.hidePopover())
  return popover
}

export function mountCommerceChrome(header, options = {}) {
  const toolbar = createCommerceToolbar(options)
  const navigation = edgeButton('start', 'Show navigation', 'workspace-navigation-toggle')
  const launcher = edgeButton('end', 'Tools and Console', 'commerce-panels-toggle')
  const tools = createElement('button', 'Agent tools', 'agentic-toolbar-item')
  tools.type = 'button'; tools.id = 'workspace-agent-open'
  tools.setAttribute('aria-haspopup', 'dialog')
  const consoleAction = createElement('button', 'Console', 'agentic-toolbar-item')
  consoleAction.type = 'button'; consoleAction.id = 'console-toggle'
  const dock = createElement('div', undefined, 'agentic-toolbar-dock')
  const banner = createElement('div', undefined, 'commerce-banner')
  banner.setAttribute('role', 'note')
  banner.append(createElement('strong', 'Workspace Program Pack'), createElement('span', 'Free conversion · No account · No payment'))
  header.classList.add('commerce-chrome'); header.append(banner, dock)
  dock.append(navigation, toolbar, launcher, attachPanel(launcher, 'Tools and Console', tools, consoleAction))
  const sections = [...toolbar.querySelectorAll('[data-pack-destination]')].map(link => toolbarLink(link.textContent, link.href))
  dock.append(attachPanel(navigation, 'Pack navigation', ...sections))
  setPackChrome(toolbar, !!options.packPage)
  return toolbar
}

export function setPackChrome(toolbar, pack) {
  const header = toolbar.closest('header'), nav = header.querySelector('#workspace-navigation-toggle')
  const menu = header.querySelector('#workspace-navigation-toggle-panel')
  nav.popoverTargetElement = pack ? menu : null
  menu.hidePopover()
  const tools = header.querySelector('#workspace-agent-open'), consoleAction = header.querySelector('#console-toggle')
  if (pack && !document.getElementById('console-sheet')) tools.removeAttribute('aria-controls')
  else tools.setAttribute('aria-controls', pack ? 'console-sheet' : 'workspace-agent-drawer')
  if (pack && document.getElementById('console-panel')) consoleAction.setAttribute('aria-controls', 'console-panel')
  if (!pack) consoleAction.removeAttribute('aria-expanded')
  if (pack) {
    nav.setAttribute('aria-controls', menu.id)
    nav.setAttribute('aria-expanded', 'false')
    nav.setAttribute('aria-label', 'Show navigation')
    nav.title = 'Show navigation'
  }
}

export function selectToolbarItem(link) {
  const toolbar = link.parentElement
  toolbar.querySelector('[aria-current]')?.removeAttribute('aria-current')
  link.setAttribute('aria-current', 'location')
  const bounds = toolbar.getBoundingClientRect()
  const { left, right } = link.getBoundingClientRect()
  if (left < bounds.left) toolbar.scrollLeft += left - bounds.left
  else if (right > bounds.right) toolbar.scrollLeft += right - bounds.right
}

const observations = new WeakMap()
export function observePackService(toolbar, changed) {
  const existing = observations.get(toolbar)
  if (existing) {
    if (changed) { existing.listeners.add(changed); if (existing.available !== undefined) changed(existing.available) }
    return existing.ready
  }
  const observation = { listeners: new Set(changed ? [changed] : []), available: undefined }
  observations.set(toolbar, observation)
  const status = toolbar.querySelector('[data-pack-status]')
  const url = new URL('service.json', toolbar.dataset.packService)
  let latest = 0, previous
  async function refresh() {
    const request = ++latest
    let ready = false
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        const service = await response.json()
        ready = service.schema === 'commerce.workspace-pack-service/v1' && service.owner === 'agentic-commerce-os'
          && service.id === PACK_TOOL && service.price?.mode === 'free' && service.price.amount === '0'
      }
    } catch { /* An unreachable or malformed descriptor cannot establish readiness. */ }
    if (request !== latest || previous === ready) return
    previous = ready
    status.textContent = ready ? 'Service ready' : 'Service unavailable'
    observation.available = ready
    for (const listener of observation.listeners) listener(ready)
  }
  addEventListener('online', refresh)
  addEventListener('offline', refresh)
  addEventListener('pageshow', event => { if (event.persisted) void refresh() })
  observation.ready = refresh()
  return observation.ready
}
