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

  const pack = packPage ? '' : './services/workspace-pack/'
  for (const [section, label] of [['builder', 'Workspace'], ['formats', 'Included files']]) {
    const link = toolbarLink(label, pack + '#' + section)
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
    if (button.dataset.dockEdge === 'start') {
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
  tools.setAttribute('aria-controls', options.packPage ? 'console-sheet' : 'workspace-agent-drawer')
  const builder = toolbar.querySelector('[data-pack-destination="builder"]')
  const consoleAction = options.packPage ? createElement('button', 'Console', 'agentic-toolbar-item')
    : toolbarLink('Console', new URL('#console', builder.href).href)
  if (options.packPage) {
    consoleAction.type = 'button'; consoleAction.id = 'console-toggle'
    consoleAction.setAttribute('aria-controls', 'console-panel')
  }
  const dock = createElement('div', undefined, 'agentic-toolbar-dock')
  const banner = createElement('div', undefined, 'commerce-banner')
  banner.setAttribute('role', 'note')
  banner.append(createElement('strong', 'Workspace Program Pack'), createElement('span', 'Free conversion · No account · No payment'))
  header.classList.add('commerce-chrome'); header.append(banner, dock)
  dock.append(navigation, toolbar, launcher, attachPanel(launcher, 'Tools and Console', tools, consoleAction))
  if (options.packPage) {
    const sections = [...toolbar.querySelectorAll('[data-pack-destination]')].map(link => toolbarLink(link.textContent, link.href))
    dock.append(attachPanel(navigation, 'Pack navigation', ...sections))
  }
  return toolbar
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

export function observePackService(toolbar, changed) {
  const status = toolbar.querySelector('[data-pack-status]')
  const url = new URL('service.json', toolbar.querySelector('[data-pack-destination="builder"]').href)
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
    changed?.(ready)
  }
  addEventListener('online', refresh)
  addEventListener('offline', refresh)
  addEventListener('pageshow', event => { if (event.persisted) void refresh() })
  return refresh()
}
