import { invokeSmePackTool, PACK_INDEX, TOOL_SCHEMAS } from './sme-business-pack-core.js'
import { getOrCreateSingleton } from './workspace-singleton.js'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./sme-business-pack.css?v=sme-cash-to-close-1', import.meta.url).href
let stylePromise
const attachStyles = () => {
  if (!stylePromise) stylePromise = new Promise((resolve, reject) => {
    style.onload = resolve
    style.onerror = () => { style.remove(); stylePromise = null; reject(Error('sme_business_pack_styles_unavailable')) }
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
  const form = $('#sme-check-form'), packSelect = $('#pack-id'), fieldsElement = $('#fields')
  const resultElement = $('#result'), resultStatus = $('#result-status'), serviceStatus = $('#service-status')
  const resultSummary = $('#result-summary'), rawReport = $('#report-raw')
  const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
  let currentFields = [], evidenceRows = [], registration, active = false
  const node = (tag, text, className) => {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className) element.className = className
    return element
  }
  const option = (select, value, label) => {
    const item = node('option', label); item.value = value; select.append(item)
  }
  const inputControl = (field, prefix) => {
    const wrap = node('section', undefined, 'field')
    const label = node('label', field.label + (field.unit ? ' · ' + field.unit : ''))
    const id = prefix + '-' + field.name
    if (field.type === 'enum' || field.type === 'boolean') {
      const control = node('select'); control.id = id; control.dataset.claim = field.name
      control.autocomplete = 'off'
      option(control, '', 'Choose…')
      const values = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.values.map(value => [value, value.replaceAll('_', ' ')])
      for (const value of values) option(control, value[0], value[1])
      label.htmlFor = id; wrap.append(label, control); return wrap
    }
    if (field.type === 'money') {
      const range = node('div', undefined, 'cash-range-input')
      for (const bound of ['low', 'high']) {
        const control = node('input'); control.type = 'number'; control.min = '0'; control.max = '100000000'
        control.step = '1'; control.inputMode = 'numeric'; control.autocomplete = 'off'
        control.id = id + '-' + bound; control.dataset.claim = field.name; control.dataset.bound = bound
        control.setAttribute('aria-label', field.label + ' ' + bound)
        control.placeholder = bound === 'low' ? 'SGD · minimum' : 'SGD · maximum (optional)'
        range.append(control)
      }
      wrap.append(label, range); return wrap
    }
    const control = node('input'); control.type = 'number'; control.step = '1'; control.inputMode = 'numeric'
    control.min = String(field.min ?? 0); control.max = String(field.max ?? 100000000)
    control.id = id; control.dataset.claim = field.name; control.autocomplete = 'off'
    label.htmlFor = id; wrap.append(label, control); return wrap
  }
  const readValue = (field, prefix) => {
    const id = prefix + '-' + field.name
    if (field.type === 'enum' || field.type === 'boolean') {
      const raw = $('#' + id)?.value
      return raw === '' || raw === undefined ? undefined : field.type === 'boolean' ? raw === 'true' : raw
    }
    if (field.type === 'money') {
      const lowText = $('#' + id + '-low')?.value, highText = $('#' + id + '-high')?.value
      if (lowText === '' || lowText === undefined) return undefined
      const low = Number(lowText), high = highText === '' ? low : Number(highText)
      return highText === '' ? low : { low, high }
    }
    const raw = $('#' + id)?.value
    return raw === '' || raw === undefined ? undefined : Number(raw)
  }
  const readClaims = () => {
    const claims = {}
    for (const field of currentFields) {
      const value = readValue(field, 'claim')
      if (value !== undefined) claims[field.name] = value
    }
    return claims
  }
  const formatMoney = value => new Intl.NumberFormat(document.documentElement.lang || 'en', {
    style: 'currency', currency: 'SGD', maximumFractionDigits: 0,
  }).format(value)
  const lineLabel = id => currentFields.find(field => field.name === id)?.label || id.replaceAll('_', ' ')
  function download(name, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const anchor = node('a'); anchor.href = url; anchor.download = name; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const evidenceSection = node('section', undefined, 'sme-evidence')
  evidenceSection.append(node('h3', 'Evidence gathered offline'), node('p',
    'Enter closed-field observations or document sightings. Entries stay in this tab and are not authenticated.', 'muted'))
  const evidenceFields = node('div', undefined, 'evidence-fields')
  const evidenceKind = node('select'); evidenceKind.id = 'sme-evidence-kind'
  const evidenceProvenance = node('select'); evidenceProvenance.id = 'sme-evidence-provenance'
  const evidenceRole = node('select'); evidenceRole.id = 'sme-evidence-role'
  const evidenceDate = node('input'); evidenceDate.id = 'sme-evidence-date'; evidenceDate.type = 'date'
  const evidenceValue = node('div'); evidenceValue.id = 'sme-evidence-value'
  const provenanceValues = [
    ['seller_stated', 'Seller stated · T0'], ['buyer_assumed', 'Buyer assumed · T0'],
    ['observed_on_site', 'Observed on site · T1'], ['measured_on_foot', 'Measured on foot · T1'],
    ['counted_on_site', 'Counted on site · T1'], ['document_sighted', 'Document sighted · T2'],
    ['third_party_confirmed', 'Third party confirmed · T3'],
  ]
  option(evidenceProvenance, '', 'Evidence source…')
  for (const row of provenanceValues) option(evidenceProvenance, row[0], row[1])
  option(evidenceRole, '', 'Observer role…')
  for (const role of ['buyer', 'adviser', 'field_checker']) option(evidenceRole, role, role.replaceAll('_', ' '))
  const evidenceLabels = [node('label', 'Claim kind'), node('label', 'Provenance'), node('label', 'Observer'), node('label', 'Date')]
  evidenceLabels[0].htmlFor = evidenceKind.id; evidenceLabels[1].htmlFor = evidenceProvenance.id
  evidenceLabels[2].htmlFor = evidenceRole.id; evidenceLabels[3].htmlFor = evidenceDate.id
  const evidenceControls = [evidenceKind, evidenceProvenance, evidenceRole, evidenceDate]
  for (let index = 0; index < evidenceControls.length; index++) {
    const field = node('section', undefined, 'field'); field.append(evidenceLabels[index], evidenceControls[index]); evidenceFields.append(field)
  }
  evidenceSection.append(evidenceFields, evidenceValue)
  const addEvidence = node('button', 'Add evidence entry'); addEvidence.type = 'button'; addEvidence.id = 'sme-add-evidence'
  evidenceSection.append(addEvidence)
  const evidenceList = node('ul', undefined, 'sme-evidence-list'); evidenceList.id = 'sme-evidence-list'
  evidenceSection.append(evidenceList)
  const worksheetSection = node('section', undefined, 'worksheet-controls')
  worksheetSection.append(node('h3', 'Offline worksheet'))
  const worksheetActions = node('div', undefined, 'actions')
  for (const [format, title] of [['json', 'Download JSON'], ['csv', 'Download CSV'], ['markdown', 'Download Markdown']]) {
    const button = node('button', title, 'secondary'); button.type = 'button'; button.dataset.export = format; worksheetActions.append(button)
  }
  const importLabel = node('label', 'Import worksheet', 'button secondary'); importLabel.htmlFor = 'sme-worksheet-import'
  const importInput = node('input'); importInput.type = 'file'; importInput.id = 'sme-worksheet-import'
  importInput.accept = '.json,.csv,.md,.markdown,application/json,text/csv,text/markdown'; importInput.className = 'file-input'
  worksheetActions.append(importLabel, importInput); worksheetSection.append(worksheetActions)
  const actions = $('.actions')
  form.insertBefore(evidenceSection, actions); form.insertBefore(worksheetSection, actions)
  function renderEvidenceValue() {
    evidenceValue.replaceChildren()
    const field = currentFields.find(item => item.name === evidenceKind.value)
    if (!field) return
    evidenceValue.append(inputControl(field, 'evidence'))
  }
  function renderEvidenceRows() {
    evidenceList.replaceChildren()
    evidenceRows.forEach((row, index) => {
      const item = node('li', lineLabel(row.claim_kind) + ' · ' + row.provenance.replaceAll('_', ' ')
        + ' · ' + row.date + ' · ' + JSON.stringify(row.value))
      const remove = node('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove evidence entry ' + (index + 1))
      remove.addEventListener('click', () => { evidenceRows.splice(index, 1); renderEvidenceRows() })
      item.append(remove); evidenceList.append(item)
    })
  }
  function renderResult(value) {
    resultSummary.replaceChildren()
    const check = value?.check, budget = value?.budget
    if (!check || !budget) {
      const notice = node('section', undefined, 'report-issues')
      notice.append(node('h3', value?.withheld ? 'Transfer checklist not available' : 'Response ready'),
        node('p', value?.withheld ? 'A qualified reviewer must approve the provisional pack before checklist content is available.' : 'Open the raw report data for the complete tool response.'))
      resultSummary.append(notice); return
    }
    const context = node('div', undefined, 'report-context')
    context.append(node('span', 'Singapore · SGD', 'report-pill'), node('span', 'Pack v' + check.pack.version, 'report-pill'),
      node('span', 'Inputs not saved', 'report-pill'))
    resultSummary.append(context)
    const totals = node('section', undefined, 'report-section')
    totals.append(node('h3', 'Cash to close'))
    const cash = budget.budget.cash_to_close
    totals.append(node('p', cash.high === null
      ? cash.low === null ? 'No cash amounts entered. Total incomplete; missing lines are unknown, not zero.'
        : 'Known entered subtotal: at least ' + formatMoney(cash.low) + '. Total incomplete; missing lines are unknown, not zero.'
      : formatMoney(cash.low) + (cash.high === cash.low ? '' : '–' + formatMoney(cash.high))))
    const gap = budget.budget.gap_above_asking_price
    totals.append(node('p', gap ? 'Gap above asking price: ' + formatMoney(gap.low) + (gap.high === gap.low ? '' : '–' + formatMoney(gap.high)) : 'Gap above asking price: unavailable until price and all cash lines are entered.'))
    const lease = budget.budget.lease_exposure
    totals.append(node('p', 'Lease exposure: ' + (lease ? formatMoney(lease.low) + (lease.high === lease.low ? '' : '–' + formatMoney(lease.high)) : 'incomplete')))
    const share = budget.budget.unchecked_share
    totals.append(node('p', 'Cash on lines below their provisional evidence tier: ' + (share === null ? 'unavailable until the budget is complete' : Math.round(share * 100) + '%')))
    if (budget.budget.break_even_monthly_sales) totals.append(node('p', 'Break-even monthly sales arithmetic: '
      + formatMoney(budget.budget.break_even_monthly_sales.low) + '–' + formatMoney(budget.budget.break_even_monthly_sales.high)))
    if (budget.budget.opening_runway) totals.append(node('p', 'Opening runway: '
      + (budget.budget.opening_runway.months ? budget.budget.opening_runway.months.low + '–' + budget.budget.opening_runway.months.high + ' months' : budget.budget.opening_runway.status.replaceAll('_', ' '))))
    resultSummary.append(totals)
    const lineSection = node('section', undefined, 'report-section'); lineSection.append(node('h3', 'Cash lines'))
    const lineList = node('ol', undefined, 'cash-line-list')
    for (const line of budget.budget.lines) {
      const valueText = line.complete ? formatMoney(line.low) + (line.high === line.low ? '' : '–' + formatMoney(line.high)) : 'Incomplete · unknown'
      lineList.append(node('li', line.id + ' · ' + line.label + ' · ' + valueText
        + ' · ' + (line.checked ? 'tier reached' : 'evidence needed')))
    }
    lineSection.append(lineList); resultSummary.append(lineSection)
    const evidence = node('section', undefined, 'report-section'); evidence.append(node('h3', 'Evidence comparison'))
    evidence.append(node('p', 'All claim statuses remain unsupported while the pack is provisional. Numeric differences are shown without an unreviewed tolerance.'))
    for (const row of check.raw_differences) evidence.append(node('p',
      row.claim_kind + ' · claimed ' + JSON.stringify(row.claimed) + ' · sighted ' + JSON.stringify(row.observed), 'report-note'))
    resultSummary.append(evidence)
    const plan = value.tasks || []
    const taskSection = node('section', undefined, 'report-section'); taskSection.append(node('h3', 'Next checks by cash amount'))
    if (!plan.length) taskSection.append(node('p', budget.budget.incomplete
      ? 'Complete the known cash lines to rank the remaining offline checks.'
      : 'No cash line is waiting for a higher provisional evidence tier.'))
    const taskList = node('ol', undefined, 'cash-line-list')
    for (const task of plan) taskList.append(node('li', 'Step ' + task.order + ' · ' + task.label + ' · ' + formatMoney(task.cash_retired_midpoint)
      + ' · ' + task.tasks.map(item => item.task).join(' ')))
    taskSection.append(taskList); resultSummary.append(taskSection)
    resultSummary.append(node('p', check.disclaimer, 'report-disclaimer'))
  }
  function show(value, source) {
    resultElement.textContent = JSON.stringify(value, null, 2)
    renderResult(value); rawReport.hidden = false; resultStatus.textContent = source
  }
  async function runPlan() {
    return invokeSmePackTool('takeover.plan', { pack_id: packSelect.value, claims: readClaims(), evidence: evidenceRows })
  }
  async function fillWorksheet(worksheet) {
    if (worksheet?.schema !== 'sme-business-pack/worksheet/v1' || worksheet.pack_id !== packSelect.value
      || !worksheet.claims || typeof worksheet.claims !== 'object' || !Array.isArray(worksheet.evidence)) throw Error('worksheet_invalid')
    const candidate = { pack_id: worksheet.pack_id, claims: worksheet.claims, evidence: worksheet.evidence }
    await invokeSmePackTool('takeover.check', candidate)
    for (const field of currentFields) {
      const value = worksheet.claims[field.name]
      if (value === undefined) continue
      if (field.type === 'money') {
        const range = typeof value === 'number' ? { low: value, high: value } : value
        $('#' + 'claim-' + field.name + '-low').value = String(range.low)
        $('#' + 'claim-' + field.name + '-high').value = range.high === range.low ? '' : String(range.high)
      } else {
        const control = $('#claim-' + field.name); if (control) control.value = String(value)
      }
    }
    evidenceRows = worksheet.evidence.map(row => ({ ...row })); renderEvidenceRows()
  }
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', quoted = false
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index++; continue }
      if (char === '"') { quoted = !quoted; continue }
      if (!quoted && char === ',') { row.push(cell); cell = ''; continue }
      if (!quoted && (char === '\n' || char === '\r')) {
        if (char === '\r' && text[index + 1] === '\n') index++
        row.push(cell); if (row.some(value => value !== '')) rows.push(row)
        row = []; cell = ''; continue
      }
      cell += char
    }
    if (quoted) throw Error('worksheet_csv_invalid')
    if (cell || row.length) { row.push(cell); rows.push(row) }
    if (rows[0]?.join(',') !== 'kind,key,value,provenance,observer_role,date') throw Error('worksheet_csv_invalid')
    const worksheet = { schema: 'sme-business-pack/worksheet/v1', pack_id: packSelect.value, claims: {}, evidence: [] }
    for (const [kind, key, value, provenance, observer_role, date] of rows.slice(1)) {
      if (kind === 'claim') worksheet.claims[key] = JSON.parse(value)
      else if (kind === 'evidence') worksheet.evidence.push({ claim_kind: key, value: JSON.parse(value), provenance, observer_role, date })
      else throw Error('worksheet_csv_invalid')
    }
    return worksheet
  }
  async function importWorksheet(file) {
    const text = await file.text(), suffix = file.name.split('.').pop().toLowerCase()
    let worksheet
    if (suffix === 'md' || suffix === 'markdown') {
      const fence = String.fromCharCode(96).repeat(3) + 'json'
      const start = text.indexOf(fence), end = start < 0 ? -1 : text.indexOf(String.fromCharCode(96).repeat(3), start + fence.length)
      if (start < 0 || end < 0) throw Error('worksheet_markdown_invalid')
      worksheet = JSON.parse(text.slice(start + fence.length, end).trim())
    } else if (suffix === 'csv') worksheet = parseCsv(text)
    else worksheet = JSON.parse(text)
    await fillWorksheet(worksheet)
    resultStatus.textContent = 'Worksheet imported in this tab. Run a new check to recompute.'
  }
  async function refreshFields() {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packSelect.value })
    currentFields = protocol.claim_kinds
    fieldsElement.replaceChildren(...currentFields.map(field => inputControl(field, 'claim')))
    evidenceKind.replaceChildren(); option(evidenceKind, '', 'Choose claim kind…')
    for (const field of currentFields.filter(item => item.retiring_tier)) option(evidenceKind, field.name, field.label)
    serviceStatus.textContent = 'Singapore · SGD · v' + protocol.pack.version + ' · provisional'
    renderEvidenceValue()
  }
  for (const pack of PACK_INDEX) option(packSelect, pack.id, pack.country + ' · ' + pack.asset_type.toUpperCase() + ' · ' + pack.currency + ' · ' + pack.review_status)
  packSelect.value = PACK_INDEX[0].id
  $('#sme-heading').textContent = 'Check an F&B business takeover'
  root.querySelector('#sme-overview .lede').textContent = 'Estimate cash to take over and open, show the lease exposure, then plan which buyer-held claims to check first.'
  root.querySelector('#sme-overview .notice > p').textContent = 'The Singapore pack is provisional. All amounts are your inputs, not market estimates. Evidence is sighted, not authenticated; this is not valuation, legal, tax or transaction advice.'
  root.querySelector('#sme-check-form .facts-heading strong').textContent = 'Buyer claims and cash inputs'
  root.querySelector('#sme-check-form .facts-heading span').textContent = 'Whole SGD amounts or ranges · blanks stay unknown'
  root.querySelector('#sme-check-form button[type="submit"]').textContent = 'Run cash-to-close check'
  $('#sample').textContent = 'Load illustrative inputs'
  runtimeMode.textContent = 'SME BUSINESS PACK · CASH TO CLOSE'
  runtimeStatus.textContent = 'Local computation ready. No service request is needed.'
  $('#mcp-url').textContent = new URL('services/sme-business-pack/mcp', document.baseURI).href
  $('#webmcp-status').textContent = 'Browser tools are optional; local checks work without a network.'
  await refreshFields()
  evidenceKind.addEventListener('change', renderEvidenceValue)
  addEvidence.addEventListener('click', () => {
    const field = currentFields.find(item => item.name === evidenceKind.value)
    const value = field && readValue(field, 'evidence')
    if (!field || value === undefined || !evidenceProvenance.value || !evidenceRole.value || !evidenceDate.value) {
      resultStatus.textContent = 'Choose a claim, value, provenance, observer and date before adding evidence.'; return
    }
    evidenceRows.push({ claim_kind: field.name, value, provenance: evidenceProvenance.value,
      observer_role: evidenceRole.value, date: evidenceDate.value })
    renderEvidenceRows(); resultStatus.textContent = 'Evidence entry held in this tab only.'
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const button = form.querySelector('button[type="submit"]'); button.disabled = true
    resultStatus.textContent = 'Computing locally…'
    try { show(await runPlan(), 'On-device calculation · no inputs saved or sent') }
    catch { resultStatus.textContent = 'Check refused. Review closed values and evidence fields.' }
    finally { button.disabled = false }
  })
  $('#checklist').addEventListener('click', async () => {
    try { show(await invokeSmePackTool('takeover.transfer_checklist', { pack_id: packSelect.value }), 'Local pack response') }
    catch { resultStatus.textContent = 'Checklist request refused.' }
  })
  $('#sample').addEventListener('click', () => {
    const sample = {
      listing_source: 'classifieds', subtype: 'cafe', price: 150000, equipment_included: true,
      equipment_cost: 0, rent_monthly: 6000, lease_remaining_months: 24, deposit_months: 3,
      utilities_deposits: 2500, transfer_cost: 8000, repairs_provision: 12000, monthly_sales: 45000,
      staff_count: 5, payroll_monthly: 14000, utilities_monthly: 900, runway_months: 3,
      variable_cost_bps: 3500, licence_status: 'unknown',
    }
    for (const field of currentFields) {
      const value = sample[field.name]
      if (value === undefined) continue
      if (field.type === 'money') $('#' + 'claim-' + field.name + '-low').value = String(value)
      else $('#claim-' + field.name).value = String(value)
    }
    evidenceRows = []; renderEvidenceRows(); resultStatus.textContent = 'Sample values are illustrative buyer inputs and remain in this tab.'
  })
  for (const button of worksheetActions.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
    try {
      const plan = await runPlan(), format = button.dataset.export
      const suffix = format === 'markdown' ? 'md' : format
      const content = plan.worksheet[format]
      if (typeof content !== 'string') throw Error('worksheet_format_missing')
      download('sme-takeover-worksheet.' + suffix, format === 'json' ? 'application/json'
        : format === 'csv' ? 'text/csv' : 'text/markdown', content)
      resultStatus.textContent = 'Worksheet downloaded locally. No report was uploaded.'
    } catch { resultStatus.textContent = 'Worksheet export refused. Review the entered values.' }
  })
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]; if (!file) return
    try { await importWorksheet(file) }
    catch { resultStatus.textContent = 'Worksheet import refused. Use an unmodified JSON, CSV or Markdown worksheet.' }
    finally { importInput.value = '' }
  })
  const modelContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext
  async function activate() {
    if (active) return
    active = true
    if (!modelContext?.registerTool) { $('#webmcp-status').textContent = 'This browser does not expose WebMCP. Use the MCP endpoint or local form.'; return }
    const controller = new AbortController(); registration = controller; let deadline
    try {
      await Promise.race([Promise.all(TOOL_SCHEMAS.map(tool => modelContext.registerTool({
        name: tool.name, description: tool.name.replaceAll('.', ' ') + ' · Singapore only · provisional · no user facts persist',
        inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
        execute: async (input, options) => {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2500), ...(options?.signal ? [options.signal] : [])])
          if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
          const value = await invokeSmePackTool(tool.name, input)
          if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
          return { content: [{ type: 'text', text: JSON.stringify(value) }] }
        },
      }, { signal: controller.signal }))), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('timeout')), 2000) })])
      if (active && !controller.signal.aborted) $('#webmcp-status').textContent = 'Six optional Singapore browser tools registered.'
    } catch {
      controller.abort(); if (registration === controller) registration = null
      if (active) $('#webmcp-status').textContent = 'Browser tool registration unavailable. Local checks still work offline.'
      active = false
    } finally { clearTimeout(deadline) }
  }
  function deactivate() {
    active = false
    const registered = Boolean(registration); registration?.abort(); registration = null
    if (registered) for (const tool of TOOL_SCHEMAS) modelContext?.unregisterTool?.(tool.name)
  }
  window.addEventListener('pagehide', deactivate, { once: true })
  window.addEventListener('pageshow', () => { if (document.body.dataset.workspaceRole === 'sme') void activate() })
  return { activate, deactivate }
}
