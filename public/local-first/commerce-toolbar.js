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

export function createCommerceToolbar({ packPage = false, workspaceHome = '' } = {}) {
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
  const consoleAction = packPage ? createElement('button', 'Console', 'agentic-toolbar-item') : toolbarLink('Console', pack + '#console')
  if (packPage) {
    consoleAction.type = 'button'
    consoleAction.id = 'console-toggle'
    consoleAction.setAttribute('aria-controls', 'console-panel')
    consoleAction.setAttribute('aria-expanded', 'false')
  }
  const status = createElement('span', 'Checking service', 'agentic-toolbar-status')
  status.dataset.packStatus = ''
  status.setAttribute('role', 'status')
  toolbar.append(consoleAction, status)
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
