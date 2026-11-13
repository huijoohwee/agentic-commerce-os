import { enhanceSelects } from './dropdown-menus.js';
import { mountCommerceChrome, observePackService, selectToolbarItem, PACK_TOOL, openCommercePanel, closeCommercePanel, getCommercePanelView, isCommercePanelOpen } from './commerce-toolbar.js';
export function mountWorkspacePack({ root, toolbar, service, active, readiness }) {
  enhanceSelects(root);
  const mountPanelContent = (hostId, templateId) => {
    const host = document.getElementById(hostId), template = root.getElementById(templateId)
    if (!host || !(template instanceof HTMLTemplateElement)) throw new Error(`Commerce panel content is missing: ${templateId}`)
    const panelRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    if (!panelRoot.childNodes.length) {
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./workspace-pack.css', import.meta.url).href
      panelRoot.append(stylesheet, template.content.cloneNode(true))
    }
    return panelRoot
  }
  const agentPanelRoot = mountPanelContent('commerce-pack-agent-content', 'agent-tools-template')
  const consoleRoot = mountPanelContent('commerce-panel-console', 'console-template')
  document.getElementById('commerce-pack-agent-content').hidden = false
  enhanceSelects(consoleRoot)
  const $ = id => root.getElementById(id) ?? consoleRoot.getElementById(id) ?? agentPanelRoot.getElementById(id)
  const sample = '# Add up a small order\ndef order_total(quantity, unit_price):\n    return quantity * unit_price\n\ntotal = 0\nfor quantity in range(1, 4):\n    total = total + order_total(quantity, 5)\n\nprint(total)\n'
  const endpoint = new URL('api', service), toolName = PACK_TOOL
  const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('')
  let generation = 0, controller = null, pack = null, urls = [], reviewEnabled = false, review = null
  const reviewDialog = $('request-review')
  let reviewTrigger = $('create')
  let consoleEventCount = 0, browserRegistered = false, toolCalls = 0, consoleApi = null, consoleLoad = null, consoleIntent = 0
  let extensionStats = { registered: 0, available: 0, stage: 'Idle', events: 0 }
  const modelContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext
  function deepActiveElement() {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    return active
  }
  const setupGuideHost = document.getElementById('commerce-panel-setup-guide')
  const setupSteps = Object.freeze([
    Object.freeze({ id: 'prepare', label: 'Prepare your source', detail: 'Paste supported Python or load the local example. Imports and general Python execution are outside this converter.', actionLabel: 'Show source' }),
    Object.freeze({ id: 'review', label: 'Review the request', detail: 'Check the source and conversion scope. Your source is sent only after you create the pack.', actionLabel: 'Review source' }),
    Object.freeze({ id: 'convert', label: 'Create the pack', detail: 'The converter creates the four files from supported Python. It does not run your code.', actionLabel: 'Continue conversion' }),
    Object.freeze({ id: 'files', label: 'Inspect and download files', detail: 'Review the Python, Blocks / JSON, Markdown, and Canvas files before downloading.', actionLabel: 'Open included files' }),
  ])
  let packStage = 'prepare', packStageStatus = 'Prepare your source', selectedGuideStep = 'prepare'
  let setupGuideHandle = null, setupGuideLoad = null, setupGuideController = null, setupGuideGeneration = 0
  function setupGuideState() {
    const current = setupSteps.findIndex(step => step.id === packStage)
    return {
      title: 'Program Pack setup', closeLabel: 'Close Program Pack setup guide',
      summary: 'Prepare a supported Python source, review the request, and download four files.',
      status: packStageStatus, selectedId: selectedGuideStep, busy: packStage === 'convert',
      items: setupSteps.map((step, index) => ({ ...step,
        meta: index < current ? 'Complete' : index === current ? 'Current' : 'Next', actionDisabled: false })),
      notice: 'Your source stays on this page until you create the pack. Conversion does not execute it.',
      onSelect(id) {
        if (!setupSteps.some(step => step.id === id)) return
        selectedGuideStep = id; setupGuideHandle?.update(setupGuideState())
      },
      onAction: focusSetupStep,
      onClose: () => closeCommercePanel(true),
    }
  }
  function focusSetupStep(id) {
    if (id === 'files') {
      location.hash = '#formats'
      root.getElementById('formats')?.scrollIntoView({ block: 'start' })
      return
    }
    const target = id === 'prepare' ? $('source')
      : id === 'review' ? ($('create')?.disabled ? $('source') : $('create'))
        : reviewDialog?.open ? $('confirm-request') : ($('create')?.disabled ? $('source') : $('create'))
    target?.scrollIntoView?.({ block: 'center' })
    target?.focus?.({ preventScroll: true })
  }
  async function openPackSetupGuide() {
    if (!active() || setupGuideHandle || setupGuideLoad) return
    if (!setupGuideHost) throw new Error('Commerce Setup Guide panel slot is missing.')
    const generation = ++setupGuideGeneration
    const controller = setupGuideController = new AbortController()
    const shadow = setupGuideHost.shadowRoot ?? setupGuideHost.attachShadow({ mode: 'open' })
    const loading = document.createElement('p'); loading.className = 'hint'; loading.textContent = 'Loading Program Pack guide…'
    shadow.replaceChildren(loading)
    const load = (async () => {
      try {
        const moduleUrl = new URL(import.meta.url)
        const graphUrl = moduleUrl.pathname.includes('/services/workspace-pack/')
          ? new URL('../../workspace-graph.js', moduleUrl) : new URL('./workspace-graph.js', moduleUrl)
        const { mountCommerceSequenceGuide } = await import(graphUrl.href)
        if (!active() || generation !== setupGuideGeneration) return
        const handle = await mountCommerceSequenceGuide(setupGuideHost, setupGuideState(), controller.signal)
        if (!active() || generation !== setupGuideGeneration) { handle.destroy(); return }
        setupGuideHandle = handle
      } catch {
        if (!active() || generation !== setupGuideGeneration) return
        const status = document.createElement('p'); status.className = 'hint'; status.textContent = 'Setup Guide could not load. Reload this workspace to retry.'
        status.setAttribute('role', 'status')
        setupGuideHost.shadowRoot?.replaceChildren(status)
      }
    })()
    setupGuideLoad = load
    try { await load } finally { if (setupGuideLoad === load) setupGuideLoad = null }
  }
  function disposePackSetupGuide() {
    setupGuideGeneration++; setupGuideLoad = null
    setupGuideController?.abort(); setupGuideController = null
    setupGuideHandle?.destroy(); setupGuideHandle = null
    setupGuideHost?.shadowRoot?.replaceChildren()
  }
  function liveSnapshot() {
    return { service: $('console-service').textContent, browser: $('console-browser-tool').textContent,
      conversionRegistered: browserRegistered, form: $('console-form-state').textContent, events: consoleEventCount, toolCalls }
  }
  function updateStatus(stats = extensionStats) {
    extensionStats = stats
    const registered = stats.registered + Number(browserRegistered), available = stats.available + Number(browserRegistered)
    $('console-tool-count').textContent = `${registered} browser tool${registered === 1 ? '' : 's'}`
    $('capability-count').textContent = `${available} available · ${registered} registered`
    $('agent-tools-count').textContent = `${available} available`
    $('agent-tools-summary').textContent = `${available} available now · ${registered} registered · ${stats.stage.toLowerCase()}`
    $('status-service').textContent = `Service: ${$('console-service').textContent}`
    $('status-rehearsal').textContent = `Rehearsal: ${stats.stage} · ${stats.events} event${stats.events === 1 ? '' : 's'}`
    $('status-agent').textContent = toolCalls ? `${toolCalls} browser call${toolCalls === 1 ? '' : 's'} observed` : 'No browser calls observed'
  }
  async function consoleAction(action, trigger) {
    const intent = ++consoleIntent
    try {
      consoleLoad ??= import('./workspace-pack.console.js').then(module => module.initConsole({
        root, agentRoot: agentPanelRoot, consoleRoot, active, context: modelContext, live: liveSnapshot, changed: updateStatus,
        openPanel: (view = 'console', trigger = null) => openCommercePanel(view, { trigger, focus: false }), review: () => $('pack-form').requestSubmit(),
        toolObserved: () => { toolCalls++; updateStatus() },
      }))
      consoleApi = await consoleLoad
      if (intent === consoleIntent && action !== 'init') consoleApi.action(action, trigger)
    } catch { consoleLoad = null; $('simulation-status').textContent = 'Console tools unavailable. Reload when connected and try again.' }
  }
  for (const button of [...root.querySelectorAll('[data-console-action]'), ...consoleRoot.querySelectorAll('[data-console-action]')])
    button.addEventListener('click', () => consoleAction(button.dataset.consoleAction, button))
  $('agent-tools-filter').addEventListener('input', () => consoleApi?.refreshLive())
  $('simulation-scenario').addEventListener('change', () => { consoleIntent++ })
  document.addEventListener('keydown', event => {
    if (!active() || !(event.metaKey || event.ctrlKey) || event.altKey || event.repeat || root.querySelector('dialog[open]') || consoleRoot.querySelector('dialog[open]')
      || event.composedPath()[0]?.closest?.('input,textarea,select,[contenteditable=true]')) return
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); consoleAction('commands', root.activeElement ?? document.activeElement) }
    if (event.key.toLowerCase() === 'j') {
      event.preventDefault()
      setConsoleOpen(!isCommercePanelOpen() || getCommercePanelView() !== 'console', true, event.target)
    }
  })
  function recordConsole(kind, message) {
    const entry = document.createElement('li'), label = document.createElement('time'), detail = document.createElement('span')
    entry.dataset.kind = kind
    consoleEventCount++
    const time = new Date()
    label.dateTime = time.toISOString()
    label.textContent = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    detail.textContent = message
    entry.append(label, detail)
    const events = $('console-events')
    events.append(entry)
    while (events.children.length > 16) events.firstElementChild.remove()
    $('console-event-count').textContent = `${consoleEventCount} events`
    updateStatus(); consoleApi?.refreshLive()
  }
  function setConsoleOpen(open, focus = true, trigger = null) {
    if (!open && focus && location.hash === '#console') {
      history.replaceState(history.state, '', '#builder')
      syncPackLocation()
    }
    if (open) openCommercePanel('console', { trigger, focus })
    else closeCommercePanel(focus)
  }
  $('status-console').addEventListener('click', event => setConsoleOpen(true, true, event.currentTarget))
  const activateWorkspacePanelView = view => {
    if (view === 'setup-guide') void openPackSetupGuide()
    if (view === 'agent-tools') {
      if (consoleApi) consoleApi.refreshLive()
      else void consoleAction('tools', agentPanelRoot.activeElement)
    }
    if (view === 'console' && !consoleApi) void consoleAction('init')
  }
  document.addEventListener('commerce:panel-state', event => {
    if (!active()) return
    if (event.detail?.open) activateWorkspacePanelView(event.detail.view)
    if (!event.detail?.open && location.hash === '#console') { history.replaceState(history.state, '', '#builder'); syncPackLocation() }
  })
  const workspacePanel = document.getElementById('commerce-workspace-panel')
  const initiallySelectedView = !workspacePanel?.hidden
    ? workspacePanel?.querySelector('[role="tab"][aria-selected="true"]')?.dataset.panelView
    : undefined
  if (active() && initiallySelectedView) activateWorkspacePanelView(initiallySelectedView)
  const statusBar = $('status-service').parentElement
  if (typeof statusBar?.getBoundingClientRect === 'function') {
    const syncStatusHeight = () => document.documentElement.style.setProperty('--agentic-floating-panel-bottom-offset', `${statusBar.getBoundingClientRect().height}px`)
    syncStatusHeight()
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncStatusHeight).observe(statusBar)
    else window.addEventListener('resize', syncStatusHeight)
  }
  function syncPackLocation() {
    const hash = location.hash || '#builder'
    const section = [...toolbar.querySelectorAll('[data-pack-destination]')].find(link => link.hash === hash)
    if (section) selectToolbarItem(section)
    else toolbar.querySelector('[aria-current]')?.removeAttribute('aria-current')
    if (hash === '#console') setConsoleOpen(true, false)
  }
  function setFormStage(stage, message) {
    packStage = stage; packStageStatus = message
    $('console-form-state').textContent = message
    consoleApi?.refreshLive()
    setupGuideHandle?.update(setupGuideState())
    root.querySelectorAll('[data-stage]').forEach(step => {
      if (step.dataset.stage === stage) step.setAttribute('aria-current', 'step')
      else step.removeAttribute('aria-current')
    })
  }
  function setReviewEnabled(enabled) {
    $('create').disabled = $('console-review').disabled = !enabled
  }
  $('console-review').addEventListener('click', () => $('pack-form').requestSubmit())
  recordConsole('info', 'Console ready. Events are limited to this tab.')
  function closeReview() {
    if (review) setFormStage('prepare', 'Ready to review')
    review = null
    if (reviewDialog.open) { reviewDialog.close(); reviewTrigger.focus() }
  }
  function invalidate() {
    closeReview()
    generation++; controller?.abort(); controller = null; pack = null
    urls.forEach(url => URL.revokeObjectURL(url)); urls = []
    $('result').hidden = true; $('empty').hidden = false; $('cancel').hidden = true
    $('result-heading').textContent = 'Ready when you are.'; $('result-badge').textContent = 'No current pack'
    setReviewEnabled(reviewEnabled); setFormStage('prepare', 'Prepare your source'); $('status').textContent = 'Review your source to create a fresh pack.'
    $('source-size').textContent = `${(new TextEncoder().encode($('source').value).length / 1024).toFixed(1)} / 32 KiB`
  }
  function showFile(index) {
    if (!pack) return
    const file = pack.files[index]
    $('preview').textContent = file.content
    $('file-info').textContent = `${file.name} · ${file.bytes.toLocaleString()} bytes`
    $('download').href = urls[index]; $('download').download = file.name
    root.querySelectorAll('[data-file]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.file) === index)))
  }
  async function requestPack(input, signal) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      credentials: 'omit', body: JSON.stringify(input), signal })
    const result = await response.json()
    if (!response.ok) throw Error(result.code || 'workspace_pack_unavailable')
    if (result.sourceDigest !== input.sourceDigest || !Array.isArray(result.files) || result.files.length !== 4) throw Error('workspace_pack_result_invalid')
    for (const file of result.files) if (await sha(file.content) !== file.digest) throw Error('workspace_pack_digest_invalid')
    const { artifactDigest, ...unsigned } = result
    if (await sha(JSON.stringify(unsigned)) !== artifactDigest) throw Error('workspace_pack_digest_invalid')
    return result
  }
  $('source').value = sample; invalidate()
  $('sample').addEventListener('click', () => { $('source').value = sample; $('title').value = 'Order total example'; invalidate() })
  for (const id of ['source', 'title']) $(id).addEventListener('input', invalidate)
  $('cancel').addEventListener('click', () => { invalidate(); $('status').textContent = 'Conversion cancelled. Your source is unchanged.'; recordConsole('info', 'Form conversion cancelled.') })
  $('close-review').addEventListener('click', closeReview)
  $('edit-request').addEventListener('click', () => { closeReview(); $('source').focus() })
  reviewDialog.addEventListener('cancel', event => { event.preventDefault(); closeReview() })
  reviewDialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const first = $('close-review'), last = $('edit-request')
    if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus() }
  })
  reviewDialog.addEventListener('click', event => {
    if (event.target !== reviewDialog) return
    const rect = reviewDialog.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeReview()
  })
  $('pack-form').addEventListener('submit', async event => {
    event.preventDefault()
    if (!reviewEnabled || controller) return
    const trigger = deepActiveElement() === $('console-review') ? $('console-review') : $('create')
    invalidate()
    const current = generation, source = $('source').value, title = $('title').value
    const bytes = new TextEncoder().encode(source).length
    if (bytes > 32768) { $('status').textContent = 'Keep the Python source within 32 KiB.'; return }
    setReviewEnabled(false)
    try {
      const input = { title, source, sourceDigest: await sha(source) }
      if (current !== generation || !reviewEnabled) return
      review = { generation: current, input }
      reviewTrigger = trigger
      $('review-title').textContent = title
      $('review-size').textContent = `${bytes.toLocaleString()} bytes of Python · 4 files included`
      reviewDialog.showModal()
      $('status').textContent = 'Review your request. Your source has not been sent.'
      setFormStage('review', 'Waiting for your review')
      recordConsole('info', 'Form review opened. Source not sent.')
    } catch { $('status').textContent = 'Request review is unavailable. Your source has not been sent.' }
    finally { if (current === generation) setReviewEnabled(reviewEnabled) }
  })
  $('confirm-request').addEventListener('click', async () => {
    if (!review || !reviewEnabled || controller) return
    if (review.generation !== generation || review.input.source !== $('source').value || review.input.title !== $('title').value) {
      invalidate(); $('status').textContent = 'Your source changed. Review the updated request.'; return
    }
    const input = review.input
    invalidate()
    const current = generation, requestController = new AbortController(); controller = requestController
    const signal = requestController.signal, timeout = setTimeout(() => requestController.abort(), 8000)
    setReviewEnabled(false); $('cancel').hidden = false; $('status').textContent = 'Creating and verifying your four files…'
    setFormStage('convert', 'Creating your pack')
    recordConsole('running', 'Form conversion requested.')
    try {
      const result = await requestPack(input, signal)
      if (generation !== current || signal.aborted) return
      pack = result
      urls = pack.files.map(file => URL.createObjectURL(new Blob([file.content], { type: file.mediaType })))
      urls.push(URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2) + '\n'], { type: 'application/json' })))
      $('download-pack').href = urls[4]; $('empty').hidden = true; $('result').hidden = false
      $('result-heading').textContent = pack.title; $('result-badge').textContent = '4 files verified'
      $('status').textContent = `Pack ready. Exact source preserved. Canvas contains ${pack.canvas.nodes} nodes. Code was not executed.`
      $('receipt').textContent = `Source: ${pack.sourceDigest}\nPack: ${pack.artifactDigest}`; showFile(0)
      $('result-heading').focus()
      setFormStage('files', 'Four files verified')
      recordConsole('success', 'Form conversion returned four verified files.')
    } catch (error) {
      if (current === generation) $('status').textContent = signal.aborted ? 'Conversion timed out. You can review and retry.'
        : `Could not create this pack: ${error.message}. Check the supported syntax and try again.`
      if (current === generation) {
        setFormStage('prepare', 'Review to try again')
        recordConsole('failed', signal.aborted ? 'Form conversion timed out.' : 'Form conversion failed.')
      }
    } finally {
      clearTimeout(timeout)
      if (current === generation) { controller = null; $('cancel').hidden = true; setReviewEnabled(reviewEnabled) }
    }
  })
  root.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', () => showFile(Number(button.dataset.file))))
  root.querySelectorAll('[data-preview-file]').forEach(button => button.addEventListener('click', () => {
    if (pack) { showFile(Number(button.dataset.previewFile)); $('preview').focus() }
    else { $('status').textContent = 'Review your source to create the four included formats.'; $('source').focus() }
  }))
  $('api-url').textContent = endpoint.href
  $('mcp-url').textContent = $('console-mcp-url').textContent = new URL('mcp', service).href
  const unavailableMessage = 'The service is unavailable. Try again shortly.'
  const ready = readiness(available => {
    // Once verified, the local form can still review source during a network outage.
    reviewEnabled = available || (reviewEnabled && navigator.onLine === false)
    $('console-service').textContent = available ? 'Ready' : 'Unavailable'
    setReviewEnabled(reviewEnabled && !controller)
    if (!reviewEnabled) {
      closeReview()
      $('status').textContent = unavailableMessage
    }
    else if ($('status').textContent === unavailableMessage) $('status').textContent = 'Review your source to create a fresh pack.'
    recordConsole(available ? 'success' : 'failed', available ? 'Service manifest verified.' : 'Service manifest unavailable.')
  })
  // Current WebMCP uses Document. Retain only a contract-level adapter for older hosts.
  let registration
  async function registerConversion() {
    if (modelContext?.registerTool) {
      if (registration && !registration.signal.aborted) return
      const current = registration = new AbortController()
      const retire = () => { if (current === registration) retireConversion() }
      let registrationTimeout
      try {
        await Promise.race([Promise.resolve(modelContext.registerTool({ name: toolName, description: 'Convert supported Python to a free Workspace Program Pack without executing it.',
          inputSchema: { type: 'object', required: ['title', 'source', 'sourceDigest'], additionalProperties: false,
            properties: { title: { type: 'string', maxLength: 80 }, source: { type: 'string', maxLength: 32768 }, sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
          annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
          execute: async (input, options) => {
            toolCalls++; recordConsole('running', 'Browser tool invoked.')
            try {
              const result = await requestPack(input,
                AbortSignal.any([current.signal, AbortSignal.timeout(8000), ...(options?.signal ? [options.signal] : [])]))
              recordConsole('success', 'Browser tool returned a verified pack.')
              return { content: [{ type: 'text', text: JSON.stringify(result) }] }
            } catch (error) { recordConsole('failed', 'Browser tool ended without a verified pack.'); throw error }
          } },
        { signal: current.signal })), new Promise((_, reject) => {
          registrationTimeout = setTimeout(() => reject(Error('webmcp_registration_timeout')), 2000)
        })])
        if (current.signal.aborted) return
        $('webmcp-status').textContent = 'Browser WebMCP tool registered.'
        $('console-browser-tool').textContent = 'Registered'
        browserRegistered = true; updateStatus(); consoleApi?.refreshLive()
        recordConsole('success', 'Browser WebMCP tool registered; no agent connection inferred.')
      } catch { if (current.signal.aborted) return; retire(); $('webmcp-status').textContent = 'Browser tool registration unavailable. Use the MCP or API endpoint.'; $('console-browser-tool').textContent = 'Unavailable'; browserRegistered = false; updateStatus(); consoleApi?.refreshLive(); recordConsole('failed', 'Browser tool registration unavailable.') }
      finally { clearTimeout(registrationTimeout) }
    } else { $('webmcp-status').textContent = 'This browser does not expose WebMCP. The MCP and API endpoints remain available.'; $('console-browser-tool').textContent = 'Unsupported'; browserRegistered = false; updateStatus(); consoleApi?.refreshLive(); recordConsole('info', 'This browser does not expose WebMCP.') }
  }
  function retireConversion() {
    if (!registration || registration.signal.aborted) return
    registration.abort()
    if (modelContext !== document.modelContext) modelContext.unregisterTool?.(toolName)
    browserRegistered = false; updateStatus()
  }
  function leave() {
    consoleIntent++
    disposePackSetupGuide()
    if (controller) invalidate()
    closeReview()
    if ($('console-sheet').open) $('console-sheet').close()
    setConsoleOpen(false, false)
    consoleApi?.setActive(false)
    retireConversion()
    document.documentElement.style.removeProperty('--agentic-floating-panel-bottom-offset')
  }
  addEventListener('pagehide', leave)
  return {
    async enter(defaultConsole = false) {
      if (defaultConsole) setConsoleOpen(matchMedia('(min-width: 1100px)').matches, false)
      syncPackLocation()
      consoleApi?.setActive(true)
      await ready
      if (active()) await registerConversion()
    },
    leave,
  }
}

const dock = document.getElementById('pack-toolbar-dock')
if (dock) {
  const toolbar = mountCommerceChrome(dock, { packPage: true, workspaceHome: dock.dataset.workspaceHome ?? null })
  const view = mountWorkspacePack({ root: document, toolbar, service: location.href, active: () => true,
    readiness: changed => observePackService(toolbar, changed) })
  await view.enter(!location.hash)
  addEventListener('hashchange', () => void view.enter())
}
