import { mountFloatingPanel } from './floating-panel.js'
import { mountWorkspaceLayout } from './workspace-layout.js'
import { createDesignIcon, createIconButton } from './toolbar-icons.js'

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
    if (items.some(item => item.contains(event.target)) && event.target.closest('a,button')) popover.hidePopover()
  }, { capture: true })
  window.addEventListener('hashchange', () => popover.hidePopover())
  return popover
}

const PANEL_VIEWS = Object.freeze([
  Object.freeze({ key: 'agent-tools', label: 'Agent tools', icon: 'Bot' }),
  Object.freeze({ key: 'console', label: 'Console', icon: 'SquareTerminal' }),
  Object.freeze({ key: 'setup-guide', label: 'Setup Guide', icon: 'HelpCircle' }),
])
const workspacePanelKey = Symbol.for('agentic-commerce-os.shared-workspace-panel')
const getWorkspacePanel = () => document[workspacePanelKey] ?? null

function attachWorkspacePanel(button) {
  const popover = createElement('div', undefined, 'commerce-workspace-panel')
  popover.id = 'commerce-workspace-panel'
  popover.dataset.agenticFloatingPanelAvoidBottom = 'true'
  for (const { key, label, icon } of PANEL_VIEWS) {
    const slot = createElement('section')
    Object.assign(slot.dataset, { panelTab: key, panelLabel: label, panelIcon: icon })
    const layout = createElement('div', undefined, 'agentic-panel-tab-layout')
    const header = createElement('header', undefined, 'agentic-panel-tab-header')
    header.append(createElement('h2', label, 'agentic-panel-section-title'))
    const body = createElement('section', undefined, 'agentic-panel-tab-body')
    // A guide supplies its own heading and scrolling body inside its shadow root.
    const contentHost = key === 'setup-guide' ? layout : body
    contentHost.id = `commerce-panel-${key}`
    if (key === 'agent-tools') {
      const pack = createElement('section'); pack.id = 'commerce-pack-agent-content'; pack.hidden = true
      body.append(pack)
    }
    layout.append(header, body); slot.append(layout); popover.append(slot)
  }
  let returnFocus = button
  button.addEventListener('click', () => { returnFocus = button })
  const native = mountFloatingPanel(button, popover, {
    label: 'Commerce workspace panels', tablistLabel: 'Workspace panels',
    returnFocus: () => { if (returnFocus.isConnected) returnFocus.focus({ preventScroll: true }) },
    onChange: ({ open, key: view }) => {
      const dialog = popover.querySelector('[role="dialog"]'), selected = popover.querySelector('[role="tab"][aria-selected="true"]')
      if (dialog && selected) dialog.setAttribute('aria-labelledby', selected.id)
      document.dispatchEvent(new CustomEvent('commerce:panel-state', { detail: { open, view } }))
    },
  })
  // An external launcher can open this non-modal host without moving focus inside it.
  document.addEventListener('keydown', event => {
    if (native.isOpen && event.key === 'Escape' && !event.defaultPrevented && !event.isComposing
      && !event.composedPath().some(node => node.matches?.('dialog[open]'))) {
      event.preventDefault(); native.close()
    }
  })
  const controller = {
    open(key = native.activeKey, options = {}) {
      if (options.trigger?.isConnected) returnFocus = options.trigger
      native.open(key, { focus: !!options.focus })
    },
    hide: (focus = false) => native.close(focus),
    get activeView() { return native.activeKey }, get isOpen() { return native.isOpen },
    setContext(pack) { native.select(pack ? 'console' : 'agent-tools') },
  }
  return { popover, controller }
}

export function openCommercePanel(view, options) {
  const panel = getWorkspacePanel()
  if (!panel) throw new Error('Commerce FloatingPanel has not been mounted.')
  panel.open(view, options)
}

export function closeCommercePanel(focus = false) { getWorkspacePanel()?.hide(focus) }
export function getCommercePanelView() { return getWorkspacePanel()?.activeView ?? '' }
export function isCommercePanelOpen() { return getWorkspacePanel()?.isOpen ?? false }

export function mountCommerceChrome(header, options = {}) {
  const toolbar = createCommerceToolbar(options)
  const navigation = edgeButton('start', 'Show navigation', 'workspace-navigation-toggle')
  const launcher = createIconButton('Tools and Console', createDesignIcon('SlidersHorizontal'))
  launcher.id = 'commerce-panels-toggle'; launcher.title = 'Tools and Console'; launcher.dataset.dockEdge = 'end'
  const dock = createElement('div', undefined, 'agentic-toolbar-dock')
  const banner = createElement('div', undefined, 'commerce-banner')
  banner.setAttribute('role', 'note')
  banner.append(createElement('strong', 'Workspace Program Pack'), createElement('span', 'Free conversion · No account · No payment'))
  header.classList.add('commerce-chrome'); header.append(banner, dock)
  const { popover, controller } = attachWorkspacePanel(launcher)
  if (getWorkspacePanel()) throw new Error('Commerce FloatingPanel is already mounted.')
  Object.defineProperty(document, workspacePanelKey, { value: controller })
  dock.append(navigation, toolbar, launcher, popover)
  controller.setContext(!!options.packPage)
  mountWorkspaceLayout({panel:popover, toolbar, create:createElement, roles:WORKSPACE_ROLES, packPage:!!options.packPage})
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
  const panel = getWorkspacePanel()
  if (panel?.isOpen) panel.hide(false)
  panel?.setContext(pack)
  document.dispatchEvent(new CustomEvent('commerce:panel-context', { detail: { pack } }))
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
