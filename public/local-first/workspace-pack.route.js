import { prepareViewStylesheet } from './workspace-view-styles.js'
import { observePackService, setPackChrome } from './commerce-toolbar.js'

const sections = new Set(['#builder', '#formats', '#console'])
export const isPackRoute = () => sections.has(location.hash)

// The public service URL remains a bookmark. In Commerce, all destinations use the shell's hash router.
function resolvePackBookmark() {
  const url = new URL(location.href)
  if (!url.searchParams.has('workspace-pack')) return false
  const defaultConsole = !url.hash
  url.searchParams.delete('workspace-pack')
  if (!sections.has(url.hash)) url.hash = 'builder'
  history.replaceState(history.state, '', url)
  return defaultConsole
}

export function createPackRoute() {
  const toolbar = document.querySelector('[data-workspace-header] .agentic-toolbar')
  const service = new URL(toolbar.dataset.packService)
  const assets = new URL('./services/workspace-pack/', import.meta.url)
  const host = document.getElementById('pack-view')
  const root = host.attachShadow({ mode: 'open' })
  const prepareStyles = prepareViewStylesheet(new URL('workspace-pack.css', assets), root)
  const main = document.getElementById('main'), footer = document.getElementById('workspace-footer')
  let pending, view, visible = false
  let defaultConsole = resolvePackBookmark()
  const status = document.getElementById('pack-route-status')
  document.querySelector('.skip-link').addEventListener('click', event => {
    if (!visible) return
    event.preventDefault()
    const target = root.getElementById('main')
    target.tabIndex = -1; target.focus()
  })
  const retry = status.querySelector('button')
  retry.addEventListener('click', () => window.dispatchEvent(new Event('hashchange')))

  async function load() {
    const response = await fetch(assets, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw Error('pack_view_unavailable')
    const page = new DOMParser().parseFromString(await response.text(), 'text/html')
    if (!page.getElementById('pack-form') || !page.getElementById('console-template') || !page.getElementById('agent-tools-template')) throw Error('pack_view_invalid')
    const content = document.createElement('div')
    content.className = 'pack-content agentic-form-controls'
    // Mount the same authored Pack body used by the standalone host, without a second header or bootstrap.
    content.append(...page.body.querySelectorAll(':scope > main, :scope > dialog, :scope > div, :scope > section, :scope > template'))
    content.querySelector('a[href="./"]')?.setAttribute('href', '#builder')
    const [module] = await Promise.all([import(new URL('workspace-pack.js', assets).href), prepareStyles()])
    root.querySelector('.pack-content')?.remove()
    root.append(content)
    return module.mountWorkspacePack({ root, toolbar, service, active: () => visible,
      readiness: changed => observePackService(toolbar, changed) })
  }

  if (isPackRoute()) { main.hidden = footer.hidden = true; status.hidden = false }
  return {
    async enter(current, leaveRole) {
      pending ??= load().catch(error => { pending = undefined; throw error })
      try { view = await pending }
      catch {
        if (current()) {
          status.hidden = false; status.firstElementChild.textContent = 'Workspace could not load.'
          retry.hidden = false
        }
        return
      }
      if (!current()) return
      status.hidden = true; retry.hidden = true
      if (!visible) {
        leaveRole()
        main.hidden = footer.hidden = true; host.hidden = false; visible = true
        document.body.dataset.workspaceRole = 'pack'
        setPackChrome(toolbar, true)
      }
      document.title = 'Workspace Program Pack · Airvio Commerce'
      void view.enter(defaultConsole)
      defaultConsole = false
      if (location.hash === '#formats') root.getElementById('formats').scrollIntoView({ behavior: 'instant' })
      else window.scrollTo({ top: 0, behavior: 'instant' })
    },
    leave() {
      if (visible) { visible = false; view.leave(); setPackChrome(toolbar, false) }
      host.hidden = status.hidden = true; main.hidden = footer.hidden = false
    },
  }
}
