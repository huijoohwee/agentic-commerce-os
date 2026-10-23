import { invokeSmePackTool, PACK_INDEX, TOOL_NAMES } from './sme-business-pack-core.js'

const $ = selector => document.querySelector(selector)
const form = $('#check-form'), packSelect = $('#pack-id'), fieldsElement = $('#fields')
const resultElement = $('#result'), resultStatus = $('#result-status'), serviceStatus = $('#service-status')
const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
const requiredToolInputs = {
  'pack.list': { type: 'object', properties: {}, additionalProperties: false },
  'pack.required_fields': { type: 'object', required: ['pack_id'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map(pack => pack.id) } }, additionalProperties: false },
  'takeover.check_listing': { type: 'object', required: ['pack_id', 'facts'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map(pack => pack.id) }, facts: { type: 'object', maxProperties: 40 } }, additionalProperties: false },
  'takeover.transfer_checklist': { type: 'object', required: ['pack_id'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map(pack => pack.id) } }, additionalProperties: false },
}
let currentFields = [], registration

function show(value, source) {
  resultElement.textContent = JSON.stringify(value, null, 2)
  resultStatus.textContent = source
}
async function invoke(name, args) {
  return { value: await invokeSmePackTool(name, args), source: 'On-device calculation · inputs stay in this browser' }
}
async function checkRuntimeAvailability() {
  try {
    const response = await fetch('./service.json', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw Error('service_unavailable')
    const service = await response.json()
    if (service.schema !== 'sme-business-pack-service/v1' || service.persistence !== 'none'
      || service.api !== './api' && service.api !== '/agentic-commerce-os/services/sme-business-pack/api'
      || service.mcp !== './mcp' && service.mcp !== '/agentic-commerce-os/services/sme-business-pack/mcp') throw Error('service_contract_invalid')
    runtimeMode.textContent = service.availability === 'local-development'
      ? 'SME BUSINESS PACK · R1 LOCAL PREVIEW' : 'SME BUSINESS PACK · R1 EDGE SERVICE'
    runtimeStatus.textContent = service.availability === 'local-development'
      ? 'Local service descriptor reached · browser checks run on-device.'
      : 'Edge service descriptor reached · browser checks run on-device.'
  } catch {
    runtimeMode.textContent = 'SME BUSINESS PACK · OFFLINE PREVIEW'
    runtimeStatus.textContent = 'Edge endpoint status unavailable. The browser form and tools still compute on-device.'
  }
}
function inputFor(field) {
  const label = document.createElement('label'), select = document.createElement('select')
  select.name = field.name; select.id = 'field-' + field.name; select.required = field.required
  label.htmlFor = select.id; label.textContent = field.label + (field.required ? ' · required' : ' · optional')
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose…'; select.append(empty)
  const labels = { cafe: 'Cafe', restaurant: 'Restaurant', food_stall: 'Food stall', bakery: 'Bakery', other: 'Other',
    under_1: 'Under 1 year', '1_3': '1–3 years', '3_5': '3–5 years', '5_plus': '5+ years', unknown: 'Unknown',
    sole_proprietor: 'Sole proprietor', partnership: 'Partnership', private_limited: 'Private limited',
    held: 'Held', not_held: 'Not held', relocation: 'Relocation', retirement: 'Retirement',
    business_change: 'Business change', SG: 'Singapore', MY: 'Malaysia' }
  const values = field.type === 'boolean' ? [{ code: 'true', label: 'Yes' }, { code: 'false', label: 'No' }]
    : field.values.map(value => typeof value === 'string' ? { code: value, label: labels[value] ?? value.replaceAll('_', ' ') }
      : { code: value.code, label: value.label ?? `${value.code} · ${field.currency} ${value.min.toLocaleString()}–${value.max.toLocaleString()}` })
  for (const value of values) {
    const option = document.createElement('option'); option.value = value.code; option.textContent = value.label; select.append(option)
  }
  const wrap = document.createElement('section'); wrap.className = 'field'; wrap.append(label, select); return wrap
}
async function refreshFields() {
  const packId = packSelect.value
  const { value: result } = await invoke('pack.required_fields', { pack_id: packId })
  currentFields = result.fields; fieldsElement.replaceChildren(...currentFields.map(inputFor))
  const summary = result.pack
  serviceStatus.textContent = `${summary.country} · ${summary.currency} · v${summary.version} · ${summary.review_status}`
}
function factsFromForm() {
  const facts = {}
  for (const field of currentFields) {
    const input = $('#field-' + field.name), raw = input?.value
    if (!raw) continue
    facts[field.name] = field.type === 'boolean' ? raw === 'true' : raw
  }
  return facts
}
form.addEventListener('submit', async event => {
  event.preventDefault()
  const button = form.querySelector('button[type="submit"]'); button.disabled = true
  resultStatus.textContent = 'Checking facts…'
  try {
    const { value, source } = await invoke('takeover.check_listing', { pack_id: packSelect.value, facts: factsFromForm() })
    show(value, source)
  } catch { resultStatus.textContent = 'Check refused. Review the selected pack and closed field values.' }
  finally { button.disabled = false }
})
$('#checklist').addEventListener('click', async () => {
  try { const { value, source } = await invoke('takeover.transfer_checklist', { pack_id: packSelect.value }); show(value, source) }
  catch { resultStatus.textContent = 'Checklist request refused.' }
})
$('#sample').addEventListener('click', () => {
  const sample = { asset_subtype: 'cafe', business_age_band: '3_5', legal_form: 'private_limited', seating_band: 'b2', staff_band: 'b2',
    asking_price_band: 'b3', monthly_sales_band: 'b3', monthly_rent_band: 'b2', lease_remaining_band: 'b3', licence_status: 'unknown',
    equipment_included: true, inventory_included: false, sale_reason: 'relocation', handover_support_band: 'b2' }
  for (const [name, value] of Object.entries(sample)) { const input = $('#field-' + name); if (input) input.value = String(value) }
})
packSelect.addEventListener('change', () => { void refreshFields().catch(() => { serviceStatus.textContent = 'Pack data unavailable.' }) })

for (const pack of PACK_INDEX) {
  const option = document.createElement('option'); option.value = pack.id
  option.textContent = `${pack.country} · ${pack.asset_type.toUpperCase()} · ${pack.currency} · ${pack.review_status}`
  packSelect.append(option)
}
$('#mcp-url').textContent = new URL('./mcp', location.href).href
void checkRuntimeAvailability()
await refreshFields()
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('../../sw.js', { updateViaCache: 'none' }).catch(() => {
    serviceStatus.textContent += ' · Offline cache unavailable'
  })
}

const modelContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext
if (modelContext?.registerTool) {
  registration = new AbortController(); let deadline
  try {
    await Promise.race([Promise.all(TOOL_NAMES.map(name => modelContext.registerTool({ name,
      description: `SME takeover pack tool ${name}. Provisional and compute-only; no user facts persist.`,
      inputSchema: requiredToolInputs[name], annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
      execute: async (input, options) => {
        const signal = AbortSignal.any([registration.signal, AbortSignal.timeout(2500), ...(options?.signal ? [options.signal] : [])])
        if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
        const { value } = await invoke(name, input)
        if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      },
    }, { signal: registration.signal }))), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('timeout')), 2000) })])
    $('#webmcp-status').textContent = 'Four optional browser tools registered in this document.'
  } catch {
    registration.abort(); $('#webmcp-status').textContent = 'Browser tool registration unavailable. Use the MCP endpoint or local form.'
  } finally { clearTimeout(deadline) }
} else $('#webmcp-status').textContent = 'This browser does not expose WebMCP. Use the MCP endpoint or local form.'
addEventListener('pagehide', () => {
  registration?.abort()
  if (modelContext !== document.modelContext) for (const name of TOOL_NAMES) modelContext?.unregisterTool?.(name)
}, { once: true })
