import { invokeSmePackTool, PACK_INDEX, TOOL_NAMES } from './sme-business-pack-core.js'
import { getOrCreateSingleton } from './workspace-singleton.js'

const style = document.createElement('link')
style.rel = 'stylesheet'; style.href = new URL('./sme-business-pack.css?v=sme-pack-theme-singleton-9', import.meta.url).href
let stylePromise
const attachStyles = () => {
  if (!stylePromise) stylePromise = new Promise((resolve, reject) => {
    style.onload = resolve; style.onerror = () => { style.remove(); stylePromise = null; reject(Error('sme_business_pack_styles_unavailable')) }
    document.head.append(style)
  })
  return stylePromise
}
export const prepareSmeBusinessPackStyles = attachStyles

export function mountSmeBusinessPack() {
  return getOrCreateSingleton('sme-business-pack-mount', createSmeBusinessPack)
}

async function createSmeBusinessPack() {
const root = document.querySelector('#sme .workspace-content')
if (!(root instanceof HTMLElement)) throw Error('sme_business_pack_mount_missing')
const $ = selector => root.querySelector(selector)
const displayLocale = document.documentElement.lang || 'en'
const form = $('#sme-check-form'), packSelect = $('#pack-id'), fieldsElement = $('#fields')
const resultElement = $('#result'), resultStatus = $('#result-status'), serviceStatus = $('#service-status')
const resultSummary = $('#result-summary'), rawReport = $('#report-raw')
const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
const serviceRoot = new URL('services/sme-business-pack/', document.baseURI)
let currentFields = [], registration, active = false
const node = (tag, text, className) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}
const requiredToolInputs = {
  'pack.list': { type: 'object', properties: {}, additionalProperties: false },
  'pack.required_fields': { type: 'object', required: ['pack_id'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map(pack => pack.id) } }, additionalProperties: false },
  'takeover.check_listing': { type: 'object', required: ['pack_id', 'facts'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map(pack => pack.id) }, facts: { type: 'object', maxProperties: 40 } }, additionalProperties: false },
  'takeover.transfer_checklist': { type: 'object', required: ['pack_id'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map(pack => pack.id) } }, additionalProperties: false },
}
function updateSectionNavigation() {
  const section = location.hash.slice(1).split('?')[0] || 'sme'
  for (const link of document.querySelectorAll('#sme-navigation .service-nav a')) {
    if (link.hash === `#${section}`) link.setAttribute('aria-current', 'location')
    else link.removeAttribute('aria-current')
  }
}
window.addEventListener('hashchange', updateSectionNavigation)
updateSectionNavigation()

function show(value, source) {
  resultElement.textContent = JSON.stringify(value, null, 2)
  renderResult(value)
  rawReport.hidden = false
  resultStatus.textContent = source
}
function fieldLabel(name) {
  return currentFields.find(field => field.name === name)?.label || name.replaceAll('_', ' ')
}
function addPill(parent, text, tone = 'quiet') {
  parent.append(document.createElement('span'))
  const pill = parent.lastElementChild; pill.className = `report-pill ${tone}`; pill.textContent = text
}
function renderResult(value) {
  resultSummary.replaceChildren()
  if (value?.schema === 'sme-business-pack/check-report/v1') {
    const context = document.createElement('div'); context.className = 'report-context'
    addPill(context, `${value.pack.country} · ${value.pack.currency}`)
    addPill(context, `Pack v${value.pack.version}`)
    addPill(context, value.persisted === false ? 'Inputs not saved' : 'Storage status unknown')
    const supplied = value.completeness?.supplied ?? 0, required = value.completeness?.required ?? 0
    const percent = Math.max(0, Math.min(100, Number(value.completeness?.percent) || 0))
    const completeness = document.createElement('section'); completeness.className = 'report-completeness'
    const header = document.createElement('div'); header.className = 'report-completeness-head'
    const title = document.createElement('div'); title.append(node('h3', 'Required facts'), node('p', `${supplied} of ${required} supplied`))
    header.append(title, node('strong', `${percent}%`))
    const progress = document.createElement('progress'); progress.max = 100; progress.value = percent
    progress.setAttribute('aria-label', `${percent}% of required facts supplied`)
    completeness.append(header, progress); resultSummary.append(context, completeness)
    const ratios = Array.isArray(value.ratios) ? value.ratios : []
    if (ratios.length) {
      const section = document.createElement('section'); section.className = 'report-section'
      section.append(node('h3', 'Arithmetic checks'))
      for (const ratio of ratios) {
        const row = document.createElement('article'); row.className = 'report-ratio'
        const label = ratio.id === 'rent_to_sales' ? 'Rent to sales' : fieldLabel(ratio.id)
        const number = Number.isFinite(ratio.value)
          ? new Intl.NumberFormat(displayLocale, { style: 'percent', maximumFractionDigits: 1 }).format(ratio.value)
          : 'Not calculated'
        row.append(node('span', label), node('strong', number), node('small', ratio.status === 'calculated' ? 'Midpoint arithmetic · sanity check only' : 'Enter both rent and sales bands to calculate'))
        section.append(row)
      }
      resultSummary.append(section)
    }
    const missing = Array.isArray(value.missing_fields) ? value.missing_fields : []
    const invalid = Array.isArray(value.invalid_fields) ? value.invalid_fields : []
    if (missing.length || invalid.length) {
      const issues = document.createElement('section'); issues.className = 'report-issues'
      issues.append(node('h3', 'Needs a closer look'))
      for (const name of missing) issues.append(node('p', `Missing · ${fieldLabel(name)}`))
      for (const name of invalid) issues.append(node('p', `Check · ${fieldLabel(name)}`))
      resultSummary.append(issues)
    }
    const flags = Array.isArray(value.flags) ? value.flags : []
    if (flags.length) {
      const signals = document.createElement('section'); signals.className = 'report-issues'
      signals.append(node('h3', 'Review signals'))
      for (const flag of flags) signals.append(node('p', flag.code === 'pack_country_mismatch'
        ? 'Listing country differs from the selected pack.'
        : flag.code === 'rent_midpoint_exceeds_sales_midpoint'
          ? 'Rent midpoint is above the monthly sales midpoint.' : 'This report contains a review signal.'))
      resultSummary.append(signals)
    }
    if (value.unknown_fields_dropped > 0) resultSummary.append(node('p', `${value.unknown_fields_dropped} unrecognized field${value.unknown_fields_dropped === 1 ? ' was' : 's were'} omitted.`, 'report-note'))
    if (value.stale) {
      const stale = document.createElement('section'); stale.className = 'report-issues'
      stale.append(node('p', 'This pack may be out of date. Verify its review status before using the result.'))
      resultSummary.append(stale)
    }
    resultSummary.append(node('p', value.disclaimer, 'report-disclaimer'))
    return
  }
  if (value?.withheld) {
    const notice = document.createElement('section'); notice.className = 'report-issues'
    notice.append(node('h3', 'Transfer checklist not available'), node('p', 'The current pack is provisional. A qualified reviewer must approve it before checklist content is available.'))
    resultSummary.append(notice); return
  }
  resultSummary.append(node('section', undefined, 'report-fallback'))
  resultSummary.firstElementChild.append(node('h3', 'Response ready'), node('p', 'Open the raw report data for the complete tool response.'))
}
async function invoke(name, args) {
  return { value: await invokeSmePackTool(name, args), source: 'On-device calculation · inputs stay in this browser' }
}
async function checkRuntimeAvailability() {
  try {
    const response = await fetch(new URL('service.json', serviceRoot), { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw Error('service_unavailable')
    const service = await response.json()
    if (service.schema !== 'sme-business-pack-service/v1' || service.persistence !== 'none'
      || service.api !== './api' && service.api !== '/agentic-commerce-os/services/sme-business-pack/api'
      || service.mcp !== './mcp' && service.mcp !== '/agentic-commerce-os/services/sme-business-pack/mcp') throw Error('service_contract_invalid')
    runtimeMode.textContent = 'SME BUSINESS PACK · LISTING CHECK'
    runtimeStatus.textContent = 'Pack details ready.'
  } catch {
    runtimeMode.textContent = 'SME BUSINESS PACK · LOCAL CHECK'
    runtimeStatus.textContent = 'Pack status unavailable · the local check is still available.'
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
  serviceStatus.textContent = `${summary.country} · ${summary.currency} · v${summary.version}`
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
$('#mcp-url').textContent = new URL('mcp', serviceRoot).href
void checkRuntimeAvailability()
await refreshFields()
const modelContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext
async function activate() {
  if (active) return
  active = true
  await attachStyles()
  if (!active) return
  if (!modelContext?.registerTool) { $('#webmcp-status').textContent = 'This browser does not expose WebMCP. Use the MCP endpoint or local form.'; return }
  const controller = new AbortController(); registration = controller; let deadline
  try {
    await Promise.race([Promise.all(TOOL_NAMES.map(name => modelContext.registerTool({ name,
      description: `SME takeover pack tool ${name}. Provisional and compute-only; no user facts persist.`,
      inputSchema: requiredToolInputs[name], annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
      execute: async (input, options) => {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2500), ...(options?.signal ? [options.signal] : [])])
        if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
        const { value } = await invoke(name, input)
        if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      },
    }, { signal: controller.signal }))), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('timeout')), 2000) })])
    if (!active || controller.signal.aborted) return
    $('#webmcp-status').textContent = 'Four optional browser tools registered in this document.'
  } catch {
    controller.abort(); if (registration === controller) registration = null
    if (active) $('#webmcp-status').textContent = 'Browser tool registration unavailable. Use the MCP endpoint or local form.'
  } finally { clearTimeout(deadline) }
}
function deactivate() {
  active = false; const registered = Boolean(registration); registration?.abort(); registration = null
  if (registered) for (const name of TOOL_NAMES) modelContext?.unregisterTool?.(name)
}
window.addEventListener('pagehide', deactivate, { once: true })
window.addEventListener('pageshow', () => { if (document.body.dataset.workspaceRole === 'sme') void activate() })
return { activate, deactivate, updateSectionNavigation }
}
