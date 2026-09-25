const $ = id => document.getElementById(id)
const sample = '# Add up a small order\ndef order_total(quantity, unit_price):\n    return quantity * unit_price\n\ntotal = 0\nfor quantity in range(1, 4):\n    total = total + order_total(quantity, 5)\n\nprint(total)\n'
const endpoint = new URL('./api', location.href), toolName = 'commerce.workspace.program-pack.create'
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('')
let generation = 0, controller = null, pack = null, urls = [], ready = false, review = null
const reviewDialog = $('request-review')
let reviewTrigger = $('create')
const consolePanel = $('console-panel'), consoleToggle = $('console-toggle')
let consoleEventCount = 0
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
}
function setConsoleOpen(open, focus = true) {
  consolePanel.hidden = !open
  consoleToggle.setAttribute('aria-expanded', String(open))
  if (!focus) return
  if (open) $('console-close').focus()
  else consoleToggle.focus()
}
consoleToggle.addEventListener('click', () => setConsoleOpen(consolePanel.hidden))
$('console-close').addEventListener('click', () => setConsoleOpen(false))
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !consolePanel.hidden && !reviewDialog.open) { event.preventDefault(); setConsoleOpen(false) }
})
setConsoleOpen(matchMedia('(min-width: 1100px)').matches, false)
function setFormStage(stage, message) {
  $('console-form-state').textContent = message
  document.querySelectorAll('[data-stage]').forEach(step => {
    if (step.dataset.stage === stage) step.setAttribute('aria-current', 'step')
    else step.removeAttribute('aria-current')
  })
}
function setReviewEnabled(enabled) {
  $('create').disabled = $('console-review').disabled = !enabled
}
$('console-review').addEventListener('click', () => $('pack-form').requestSubmit())
recordConsole('info', 'Console ready. Events are limited to this tab.')
// Load the fixture model only when a visitor runs a rehearsal.
let simulationModule = null, simulationImport = null, simulation = null, simulationGeneration = 0
const responseStages = [...document.querySelectorAll('[data-response-stage]')]
function resetSimulation() {
  simulationGeneration++; simulation = null
  $('simulation-run').disabled = false
  $('simulation-report').hidden = true
  $('simulation-status').textContent = 'Choose a scenario and run the rehearsal.'
  responseStages.forEach(button => {
    button.disabled = true
    button.setAttribute('aria-pressed', String(button.dataset.responseStage === 'triage'))
  })
}
function renderSimulation() {
  const view = simulationModule.inspectSimulation(simulation)
  $('simulation-report').hidden = false
  $('simulation-status').textContent = `${view.name} · ${view.recovered ? 'Simulation complete' : 'Simulated condition loaded'}`
  $('simulation-report-heading').textContent = view.heading
  $('simulation-scope').textContent = `Run ${view.runId} · ${view.scope}`
  $('simulation-signal').textContent = `Fixture HTTP ${view.outcome.status}${view.outcome.code ? ` · ${view.outcome.code}` : ''}`
  $('simulation-explanation').textContent = view.explanation
  $('simulation-result').hidden = !view.result
  $('simulation-result').textContent = view.result ?? ''
  $('simulation-recover').hidden = view.stage !== 'recovery'
  $('simulation-recover').disabled = view.recovered
  $('simulation-recover').dataset.runId = String(view.runId)
  responseStages.forEach(button => {
    button.disabled = false
    button.setAttribute('aria-pressed', String(button.dataset.responseStage === view.stage))
  })
}
$('simulation-scenario').addEventListener('change', resetSimulation)
$('simulation-reset').addEventListener('click', () => { resetSimulation(); $('simulation-run').focus() })
$('simulation-run').addEventListener('click', async () => {
  const current = ++simulationGeneration, scenario = $('simulation-scenario').value
  $('simulation-run').disabled = true
  $('simulation-status').textContent = 'Loading local rehearsal…'
  try {
    simulationImport ??= import('./workspace-pack.simulation.js')
    const model = await simulationImport
    if (current !== simulationGeneration) return
    simulationModule = model
    simulation = model.startSimulation(scenario, current)
    renderSimulation()
  } catch {
    if (current === simulationGeneration) {
      simulationImport = null; simulation = null; $('simulation-report').hidden = true
      responseStages.forEach(button => { button.disabled = true })
      $('simulation-status').textContent = 'Rehearsal unavailable. Reload when connected and try again.'
    }
  } finally { if (current === simulationGeneration) $('simulation-run').disabled = false }
})
responseStages.forEach(button => button.addEventListener('click', () => {
  if (!simulation) return
  simulation = simulationModule.selectStage(simulation, button.dataset.responseStage)
  renderSimulation()
}))
$('simulation-recover').addEventListener('click', () => {
  if (!simulation || simulation.stage !== 'recovery' || simulation.recovered) return
  simulation = simulationModule.applyRecovery(simulation, Number($('simulation-recover').dataset.runId))
  renderSimulation()
})
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
  setReviewEnabled(ready); setFormStage('prepare', 'Prepare your source'); $('status').textContent = 'Review your source to create a fresh pack.'
  $('source-size').textContent = `${(new TextEncoder().encode($('source').value).length / 1024).toFixed(1)} / 32 KiB`
}
function showFile(index) {
  if (!pack) return
  const file = pack.files[index]
  $('preview').textContent = file.content
  $('file-info').textContent = `${file.name} · ${file.bytes.toLocaleString()} bytes`
  $('download').href = urls[index]; $('download').download = file.name
  document.querySelectorAll('[data-file]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.file) === index)))
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
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
})
reviewDialog.addEventListener('click', event => {
  if (event.target !== reviewDialog) return
  const rect = reviewDialog.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeReview()
})
$('pack-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (!ready || controller) return
  const trigger = document.activeElement === $('console-review') ? $('console-review') : $('create')
  invalidate()
  const current = generation, source = $('source').value, title = $('title').value
  const bytes = new TextEncoder().encode(source).length
  if (bytes > 32768) { $('status').textContent = 'Keep the Python source within 32 KiB.'; return }
  setReviewEnabled(false)
  try {
    const input = { title, source, sourceDigest: await sha(source) }
    if (current !== generation) return
    review = { generation: current, input }
    reviewTrigger = trigger
    $('review-title').textContent = title
    $('review-size').textContent = `${bytes.toLocaleString()} bytes of Python · 4 files included`
    reviewDialog.showModal()
    $('status').textContent = 'Review your request. Your source has not been sent.'
    setFormStage('review', 'Waiting for your review')
    recordConsole('info', 'Form review opened. Source not sent.')
  } catch { $('status').textContent = 'Request review is unavailable. Your source has not been sent.' }
  finally { if (current === generation) setReviewEnabled(ready) }
})
$('confirm-request').addEventListener('click', async () => {
  if (!review || controller) return
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
    if (current === generation) { controller = null; $('cancel').hidden = true; setReviewEnabled(ready) }
  }
})
document.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', () => showFile(Number(button.dataset.file))))
$('api-url').textContent = endpoint.href
$('mcp-url').textContent = $('console-mcp-url').textContent = new URL('./mcp', location.href).href
try {
  const response = await fetch('./service.json', { credentials: 'omit' })
  if (!response.ok) throw Error('unavailable')
  const service = await response.json()
  if (service.id !== toolName || service.price.mode !== 'free') throw Error('identity')
  ready = true; $('connection').textContent = 'Service ready'; $('console-service').textContent = 'Ready'; setReviewEnabled(true)
  recordConsole('success', 'Service manifest verified.')
} catch { $('connection').textContent = 'Service unavailable'; $('console-service').textContent = 'Unavailable'; $('status').textContent = 'The service is unavailable. Try again shortly.'; recordConsole('failed', 'Service manifest unavailable.') }
// Current WebMCP uses Document. Retain only a contract-level adapter for older hosts.
const modelContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext
if (modelContext?.registerTool) {
  const registration = new AbortController()
  const retire = () => { registration.abort(); if (modelContext !== document.modelContext) modelContext.unregisterTool?.(toolName) }
  addEventListener('pagehide', retire, { once: true })
  let registrationTimeout
  try {
    await Promise.race([Promise.resolve(modelContext.registerTool({ name: toolName, description: 'Convert supported Python to a free Workspace Program Pack without executing it.',
      inputSchema: { type: 'object', required: ['title', 'source', 'sourceDigest'], additionalProperties: false,
        properties: { title: { type: 'string', maxLength: 80 }, source: { type: 'string', maxLength: 32768 }, sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
      execute: async (input, options) => {
        recordConsole('running', 'Browser tool invoked.')
        try {
          const result = await requestPack(input,
            AbortSignal.any([registration.signal, AbortSignal.timeout(8000), ...(options?.signal ? [options.signal] : [])]))
          recordConsole('success', 'Browser tool returned a verified pack.')
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) { recordConsole('failed', 'Browser tool ended without a verified pack.'); throw error }
      } },
    { signal: registration.signal })), new Promise((_, reject) => {
      registrationTimeout = setTimeout(() => reject(Error('webmcp_registration_timeout')), 2000)
    })])
    if (registration.signal.aborted) throw Error('webmcp_registration_cancelled')
    $('webmcp-status').textContent = 'Browser WebMCP tool registered.'
    $('console-browser-tool').textContent = 'Registered'
    $('console-tool-count').textContent = '1 browser tool'
    recordConsole('success', 'Browser WebMCP tool registered; no agent connection inferred.')
  } catch { retire(); $('webmcp-status').textContent = 'Browser tool registration unavailable. Use the MCP or API endpoint.'; $('console-browser-tool').textContent = 'Unavailable'; $('console-tool-count').textContent = '0 browser tools'; recordConsole('failed', 'Browser tool registration unavailable.') }
  finally { clearTimeout(registrationTimeout) }
} else { $('webmcp-status').textContent = 'This browser does not expose WebMCP. The MCP and API endpoints remain available.'; $('console-browser-tool').textContent = 'Unsupported'; $('console-tool-count').textContent = '0 browser tools'; recordConsole('info', 'This browser does not expose WebMCP.') }
