const $ = id => document.getElementById(id)
const sample = '# Add up a small order\ndef order_total(quantity, unit_price):\n    return quantity * unit_price\n\ntotal = 0\nfor quantity in range(1, 4):\n    total = total + order_total(quantity, 5)\n\nprint(total)\n'
const endpoint = new URL('./api', location.href), toolName = 'commerce.workspace.program-pack.create'
const sha = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('')
let generation = 0, controller = null, pack = null, urls = [], ready = false, review = null
const reviewDialog = $('request-review')
function closeReview() {
  review = null
  if (reviewDialog.open) { reviewDialog.close(); $('create').focus() }
}
function invalidate() {
  closeReview()
  generation++; controller?.abort(); controller = null; pack = null
  urls.forEach(url => URL.revokeObjectURL(url)); urls = []
  $('result').hidden = true; $('empty').hidden = false; $('cancel').hidden = true
  $('result-heading').textContent = 'Ready when you are.'; $('result-badge').textContent = 'No current pack'
  $('create').disabled = !ready; $('status').textContent = 'Review your source to create a fresh pack.'
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
$('cancel').addEventListener('click', () => { invalidate(); $('status').textContent = 'Conversion cancelled. Your source is unchanged.' })
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
  invalidate()
  const current = generation, source = $('source').value, title = $('title').value
  const bytes = new TextEncoder().encode(source).length
  if (bytes > 32768) { $('status').textContent = 'Keep the Python source within 32 KiB.'; return }
  $('create').disabled = true
  try {
    const input = { title, source, sourceDigest: await sha(source) }
    if (current !== generation) return
    review = { generation: current, input }
    $('review-title').textContent = title
    $('review-size').textContent = `${bytes.toLocaleString()} bytes of Python · 4 files included`
    reviewDialog.showModal()
    $('status').textContent = 'Review your request. Your source has not been sent.'
  } catch { $('status').textContent = 'Request review is unavailable. Your source has not been sent.' }
  finally { if (current === generation) $('create').disabled = !ready }
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
  $('create').disabled = true; $('cancel').hidden = false; $('status').textContent = 'Creating and verifying your four files…'
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
  } catch (error) {
    if (current === generation) $('status').textContent = signal.aborted ? 'Conversion timed out. You can review and retry.'
      : `Could not create this pack: ${error.message}. Check the supported syntax and try again.`
  } finally {
    clearTimeout(timeout)
    if (current === generation) { controller = null; $('cancel').hidden = true; $('create').disabled = !ready }
  }
})
document.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', () => showFile(Number(button.dataset.file))))
$('api-url').textContent = endpoint.href; $('mcp-url').textContent = new URL('./mcp', location.href).href
try {
  const response = await fetch('./service.json', { credentials: 'omit' })
  if (!response.ok) throw Error('unavailable')
  const service = await response.json()
  if (service.id !== toolName || service.price.mode !== 'free') throw Error('identity')
  ready = true; $('connection').textContent = 'Service ready'; $('create').disabled = false
} catch { $('connection').textContent = 'Service unavailable'; $('status').textContent = 'The service is unavailable. Try again shortly.' }
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
      execute: async (input, options) => ({ content: [{ type: 'text', text: JSON.stringify(await requestPack(input,
        AbortSignal.any([registration.signal, AbortSignal.timeout(8000), ...(options?.signal ? [options.signal] : [])]))) }] }) },
    { signal: registration.signal })), new Promise((_, reject) => {
      registrationTimeout = setTimeout(() => reject(Error('webmcp_registration_timeout')), 2000)
    })])
    if (registration.signal.aborted) throw Error('webmcp_registration_cancelled')
    $('webmcp-status').textContent = 'Browser WebMCP tool registered.'
  } catch { retire(); $('webmcp-status').textContent = 'Browser tool registration unavailable. Use the MCP or API endpoint.' }
  finally { clearTimeout(registrationTimeout) }
} else $('webmcp-status').textContent = 'This browser does not expose WebMCP. The MCP and API endpoints remain available.'
