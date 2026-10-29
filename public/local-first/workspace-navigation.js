import { getOrCreateSingleton, releaseSingleton } from './workspace-singleton.js'

const createElement = (tag, text, className) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

function createIcon(symbolId) {
  if (!document.getElementById(symbolId)) throw Error(`workspace_shared_icon_missing:${symbolId}`)
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 20 20')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('focusable', 'false')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${symbolId}`)
  icon.append(use)
  return icon
}

function createWorkspaceSearch(variant) {
  if (variant === 'sme') return null
  const label = variant === 'admin' ? 'Search projects' : 'Search offers'
  const button = createElement('button', undefined, 'console-search secondary')
  button.type = 'button'
  button.dataset.workspaceSearch = ''
  button.setAttribute('aria-label', label)
  button.hidden = variant === 'shop'
  if (variant === 'admin') button.id = 'project-search-shortcut'
  button.append(createIcon('icon-search'), createElement('span', label, 'sidebar-search-label'), createElement('kbd', '⌘ K'))
  return button
}

export const WORKSPACE_ROLES = Object.freeze({
  shop: Object.freeze({ label: 'Shopper', helpLabel: 'shopper', breadcrumb: 'Storefront', title: 'Shopper' }),
  vendor: Object.freeze({ label: 'Vendor', helpLabel: 'vendor', breadcrumb: 'Catalog', title: 'Vendor workspace' }),
  admin: Object.freeze({ label: 'Admin', helpLabel: 'admin', breadcrumb: 'Projects', title: 'Admin workspace' }),
  sme: Object.freeze({ label: 'SME pack', helpLabel: 'SME pack', breadcrumb: 'SME pack', title: 'SME business pack' })
})
function uniqueElement(selector, error) {
  const matches = document.querySelectorAll(selector)
  if (matches.length !== 1) throw Error(error)
  return matches[0]
}
export function assertSharedWorkspaceShell() {
  const header = uniqueElement('[data-workspace-header].topbar', 'workspace_header_singleton_invalid')
  const sidebar = uniqueElement('[data-workspace-sidebar]', 'workspace_sidebar_singleton_invalid')
  const shell = uniqueElement('#workspace-shell', 'workspace_shell_singleton_invalid')
  const footer = uniqueElement('[data-workspace-footer]', 'workspace_footer_singleton_invalid')
  if (document.querySelectorAll('.topbar').length !== 1
    || document.querySelectorAll('.console-sidebar').length !== 1
    || document.querySelectorAll('.workspace-footer').length !== 1
    || document.querySelectorAll('#workspace-footer').length !== 1
    || header.parentElement !== document.body || sidebar.parentElement !== shell || footer.parentElement !== document.body) {
    throw Error('workspace_shell_singleton_ownership_invalid')
  }
  const current = { header, sidebar, shell, footer }
  const singleton = getOrCreateSingleton('workspace-shell-dom', () => Object.freeze(current))
  if (singleton.header !== header || singleton.sidebar !== sidebar
    || singleton.shell !== shell || singleton.footer !== footer) {
    throw Error('workspace_shell_singleton_identity_changed')
  }
  return singleton
}
const SIDEBAR_NOTES = Object.freeze({
  shop: Object.freeze({ label: 'Offer preview details', status: 'Preview details', title: 'What shoppers see', body: 'Offer title, outcome, audience and planned price. Private notes stay in your workspace.' }),
  vendor: Object.freeze({ label: 'Workspace information', status: 'Private workspace status', title: 'Local-first workspace', body: 'Private drafts on this device. Human review before publication.' }),
  admin: Object.freeze({ label: 'Workspace information', status: 'Private workspace status', title: 'Local-first workspace', body: 'Private drafts on this device. Human review before publication.' }),
  sme: Object.freeze({ label: 'Privacy details', status: 'Local input', title: 'Your facts stay here', body: 'Checks run on this device. Inputs are not saved.' })
})

function createSidebarNote(variant) {
  const definition = SIDEBAR_NOTES[variant]
  if (!definition) throw Error('workspace_sidebar_note_missing')
  const note = createElement('section', undefined, 'sidebar-note')
  note.setAttribute('aria-label', definition.label)
  const status = createElement('span', undefined, 'status-dot')
  status.setAttribute('role', 'img'); status.setAttribute('aria-label', definition.status)
  note.append(status, createElement('strong', definition.title), createElement('p', definition.body))
  return note
}

function createWorkspaceHeader() {
  const mount = uniqueElement('[data-workspace-header]', 'workspace_header_mount_not_singleton')
  if (!(mount instanceof HTMLElement)) throw Error('workspace_header_mount_missing')
  if (mount.matches('header.topbar')) return mount
  if (document.querySelectorAll('.topbar').length) throw Error('workspace_header_duplicate_rendered')
  const header = createElement('header', undefined, 'topbar')
  header.dataset.workspaceHeader = ''
  const toggle = createElement('button', undefined, 'secondary navigation-toggle')
  toggle.id = 'workspace-navigation-toggle'; toggle.type = 'button'
  toggle.setAttribute('aria-label', 'Hide navigation'); toggle.setAttribute('aria-expanded', 'true')
  toggle.setAttribute('aria-controls', 'shop-navigation')
  toggle.title = 'Hide navigation'
  toggle.append(createIcon('icon-navigation'))
  const brand = createElement('a', undefined, 'brand')
  brand.href = '#shop'; brand.setAttribute('aria-label', 'Airvio Commerce home')
  const mark = createElement('img', undefined, 'brand-mark')
  mark.src = './favicon.svg'; mark.alt = ''; mark.setAttribute('aria-hidden', 'true')
  const wordmark = createElement('span', undefined, 'brand-wordmark')
  wordmark.append(createElement('strong', 'airvio'), createElement('small', 'commerce'))
  brand.append(mark, wordmark); header.append(brand, toggle)
  const breadcrumb = createElement('nav', undefined, 'console-breadcrumb')
  breadcrumb.id = 'console-breadcrumb'; breadcrumb.setAttribute('aria-label', 'Parent workspace'); breadcrumb.hidden = true
  const root = createElement('a', 'Projects'); root.id = 'console-root'; root.href = '#admin'
  breadcrumb.append(root); header.append(breadcrumb)
  const workspace = createElement('select', undefined, 'workspace-role-switcher')
  workspace.id = 'workspace-role-switcher'; workspace.setAttribute('aria-label', 'Choose workspace')
  for (const [role, definition] of Object.entries(WORKSPACE_ROLES)) {
    const option = createElement('option', definition.label); option.value = role; workspace.append(option)
  }
  header.append(workspace)
  const agent = createElement('button', undefined, 'secondary console-agent-button')
  agent.id = 'workspace-agent-open'; agent.type = 'button'; agent.setAttribute('aria-label', 'Agent tools')
  agent.setAttribute('aria-haspopup', 'dialog'); agent.setAttribute('aria-expanded', 'false'); agent.hidden = true
  agent.innerHTML = '<span role="img" aria-label="Command key icon">⌘</span>'
  header.append(agent)
  const status = createElement('span', undefined, 'badge'); status.id = 'connection'
  const statusLabel = createElement('span', 'Local workspace · Online', 'workspace-status-label')
  status.append(statusLabel); status.title = statusLabel.textContent
  header.append(status); mount.replaceWith(header)
  return header
}

export function mountWorkspaceShell() {
  const mounted = getOrCreateSingleton('workspace-shared-shell-mount', () => {
    createWorkspaceHeader()
    return assertSharedWorkspaceShell()
  })
  const current = assertSharedWorkspaceShell()
  if (mounted.header !== current.header || mounted.sidebar !== current.sidebar
    || mounted.shell !== current.shell || mounted.footer !== current.footer) {
    throw Error('workspace_shell_mount_identity_changed')
  }
  return mounted
}

export function mountWorkspaceSidebar({ host, template, variant, id, label, className = 'sidebar' } = {}) {
  if (!(host instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)
    || typeof variant !== 'string' || !variant || typeof id !== 'string' || !id)
    throw Error('workspace_sidebar_binding_invalid')
  const { sidebar, shell } = assertSharedWorkspaceShell()
  if (!(sidebar instanceof HTMLElement)) throw Error('workspace_sidebar_mount_missing')
  if (host !== shell) throw Error('workspace_sidebar_host_invalid')
  if (sidebar.dataset.sidebarVariant !== variant) {
    const definition = WORKSPACE_ROLES[variant]
    const sharedActions = document.querySelector('#workspace-sidebar-actions')
    if (!definition || !(sharedActions instanceof HTMLTemplateElement)) throw Error('workspace_sidebar_shared_actions_missing')
    sidebar.replaceChildren(template.content.cloneNode(true))
    const search = createWorkspaceSearch(variant)
    if (search) sidebar.prepend(search)
    for (const nav of sidebar.querySelectorAll('.service-nav')) {
      const links = [...nav.children].filter(child => child instanceof HTMLAnchorElement)
      if (!links.length) throw Error('workspace_sidebar_navigation_empty')
      const linkList = createElement('div', undefined, 'service-nav-links')
      linkList.append(...links)
      nav.append(linkList)
    }
    sidebar.append(createSidebarNote(variant))
    const actions = sharedActions.content.cloneNode(true)
    const intro = actions.querySelector('[data-workspace-intro]')
    const tour = actions.querySelector('[data-workspace-tour]')
    if (!(intro instanceof HTMLAnchorElement) || !(tour instanceof HTMLAnchorElement)) {
      throw Error('workspace_sidebar_actions_invalid')
    }
    intro.href = '#' + variant
    intro.dataset.workspaceIntro = variant
    intro.setAttribute('aria-label', `Open the ${definition.helpLabel} workspace overview`)
    tour.href = '#' + variant
    tour.dataset.workspaceTour = variant
    tour.setAttribute('aria-label', `Take a quick tour of the ${definition.helpLabel} workspace`)
    const actionNav = createElement('nav', undefined, 'sidebar-actions')
    actionNav.setAttribute('aria-label', 'Workspace help')
    actionNav.append(actions)
    sidebar.append(actionNav)
    for (const link of sidebar.querySelectorAll('a')) {
      const label = [...link.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.trim()).filter(Boolean).join(' ')
      if (!label) continue
      for (const node of [...link.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove()
      link.append(createElement('span', label, 'sidebar-item-label'))
    }
    sidebar.dataset.sidebarVariant = variant
  }
  sidebar.id = id; sidebar.className = className
  if (label) sidebar.setAttribute('aria-label', label)
  sidebar.dataset.selectionTarget = id
  if (sidebar.parentElement !== host) host.prepend(sidebar)
  assertSharedWorkspaceShell()
  return sidebar
}

export function bindWorkspaceNavigation({ onChange, onWorkspaceChange = () => {}, breakpoint = '(max-width: 950px)' } = {}) {
  const toggle = document.querySelector('#workspace-navigation-toggle')
  const workspace = document.querySelector('#workspace-role-switcher')
  const sidebar = document.querySelector('[data-workspace-sidebar]')
  if (!(toggle instanceof HTMLButtonElement) || !(workspace instanceof HTMLSelectElement)
    || !(sidebar instanceof HTMLElement) || typeof onChange !== 'function' || typeof onWorkspaceChange !== 'function') {
    throw Error('workspace_navigation_shell_invalid')
  }
  return getOrCreateSingleton('workspace-navigation-binding', () => {
    const compact = matchMedia(breakpoint)
    const mobileNavigation = matchMedia('(max-width: 850px)')
    let pendingWorkspaceRoute = null
    const render = () => onChange(!document.body.classList.contains('navigation-collapsed'))
    const setCollapsed = collapsed => {
      document.body.classList.toggle('navigation-collapsed', collapsed)
      render()
    }
    const onMobileNavigationChange = event => setCollapsed(event.matches)
    const onClick = () => setCollapsed(!document.body.classList.contains('navigation-collapsed'))
    const onSidebarNavigation = event => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null
      if (compact.matches && link && !link.matches('[data-workspace-tour], [data-workspace-intro]')) setCollapsed(true)
    }
    const onWorkspaceSelect = () => {
      if (!workspace.value || location.hash === `#${workspace.value}`) return
      pendingWorkspaceRoute = workspace.value
      onWorkspaceChange(workspace.value)
      location.hash = workspace.value
    }
    const correctTargetPosition = targetId => {
      if (!compact.matches || !targetId) return
      const correctScroll = () => {
        const target = document.getElementById(targetId)
        const headerBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0
        const sidebar = document.querySelector('[data-workspace-sidebar]:not([hidden])')
        const sidebarBottom = sidebar && getComputedStyle(sidebar).position === 'sticky'
          ? sidebar.getBoundingClientRect().bottom : 0
        const obstructionBottom = Math.max(headerBottom, sidebarBottom)
        if (!target || target.getBoundingClientRect().top >= obstructionBottom + 12) return
        window.scrollBy({ top: target.getBoundingClientRect().top - obstructionBottom - 12, behavior: 'instant' })
      }
      const correctAfterLayout = () => requestAnimationFrame(() => requestAnimationFrame(correctScroll))
      correctAfterLayout()
      if (document.fonts?.ready) void document.fonts.ready.then(correctAfterLayout)
      if (document.readyState !== 'complete') window.addEventListener('load', correctAfterLayout, { once: true })
    }
    const onHashChange = event => {
      if (!compact.matches) return
      const targetId = new URL(event?.newURL || location.href).hash.slice(1).split('?')[0]
      if (pendingWorkspaceRoute === targetId) { pendingWorkspaceRoute = null; return }
      correctTargetPosition(targetId)
    }

    const binding = {
      dispose() {
        toggle.removeEventListener('click', onClick)
        sidebar.removeEventListener('click', onSidebarNavigation)
        workspace.removeEventListener('change', onWorkspaceSelect)
        window.removeEventListener('hashchange', onHashChange)
        mobileNavigation.removeEventListener('change', onMobileNavigationChange)
        releaseSingleton('workspace-navigation-binding', binding)
      },
    }
    setCollapsed(mobileNavigation.matches)
    toggle.addEventListener('click', onClick)
    sidebar.addEventListener('click', onSidebarNavigation)
    workspace.addEventListener('change', onWorkspaceSelect)
    window.addEventListener('hashchange', onHashChange)
    mobileNavigation.addEventListener('change', onMobileNavigationChange)
    if (location.hash) onHashChange()
    return binding
  }).dispose
}
