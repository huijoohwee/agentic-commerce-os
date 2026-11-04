import { invokeSmePackTool, PACK_INDEX, TOOL_SCHEMAS } from './sme-business-pack-core.js'
import { getOrCreateSingleton } from './workspace-singleton.js'
import { createSmeWorkflowEditor } from './sme-workflow-editor.js'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./sme-business-pack.css?v=sme-e2e-workflow-multidim-7', import.meta.url).href
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
  const form = $('#sme-check-form'), packSelect = $('#pack-id'), comparisonCount = $('#sme-compare-count')
  const workflowTableHost = $('#sme-workflow-table-host'), workflowTableRegion = $('#sme-workflow-table-region')
  const workflowEditor = $('#sme-workflow-editor'), claimInputs = $('#sme-workflow-claim-inputs')
  const evidenceEditor = $('#sme-workflow-evidence-editor')
  const workflowStatus = $('#workflow-status'), serviceStatus = $('#service-status')
  const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
  let currentFields = [], currentProtocol, registration, active = false, previousScrollRestoration = null,
    comparisonGeneration = 0, packGeneration = 0, comparisonPending = false, tableOrientation = 'rows',
    comparisonValue = null, tableMessage = null, selectedWorkflowSet = null, selectedEvidenceField = null, tableAdapter = null
  const comparisonSlotElements = ['A', 'B', 'C'].map(slot => ({ slot, claims: {}, evidence: [] }))
  const workflowTableMount = { handle: null, ready: null, generation: 0 }
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element }
  const option = (select, value, label) => { const item = node('option', label); item.value = value; select.append(item) }
  const enumLabel = value => value.replaceAll('_', ' ').replace(/^\w/, letter => letter.toUpperCase())
  const readClaims = item => ({ ...item.claims })
  const formatMoney = (value, currency = currentProtocol?.pack.currency) => {
    if (!/^[A-Z]{3}$/u.test(currency ?? '')) throw Error('sme_pack_currency_missing')
    return new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
  }
  const lineLabel = id => currentFields.find(field => field.name === id)?.label || id.replaceAll('_', ' ')
  function download(name, mime, content) { const url = URL.createObjectURL(new Blob([content], { type: mime })); const anchor = node('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
  const worksheetSection = node('section', undefined, 'worksheet-controls')
  worksheetSection.append(node('h3', 'Offline worksheet'))
  const worksheetActions = node('div', undefined, 'actions')
  const printButton = node('button', 'Print worksheet', 'secondary'); printButton.type = 'button'; printButton.id = 'sme-print'
  worksheetActions.append(printButton)
  for (const [format, title] of [['json', 'Download JSON'], ['csv', 'Download CSV'], ['markdown', 'Download Markdown']]) {
    const button = node('button', title, 'secondary'); button.type = 'button'; button.dataset.export = format; worksheetActions.append(button)
  }
  const importLabel = node('label', 'Import worksheet', 'button secondary'); importLabel.htmlFor = 'sme-worksheet-import'
  const importInput = node('input'); importInput.type = 'file'; importInput.id = 'sme-worksheet-import'
  importInput.accept = '.json,.csv,.md,.markdown,application/json,text/csv,text/markdown'; importInput.className = 'file-input'
  worksheetActions.append(importLabel, importInput); worksheetSection.append(worksheetActions)
  $('#sme-worksheet-actions').replaceChildren(worksheetSection)
  const compareButton = $('#sme-compare-run')
  function formatClaim(field, value) {
    if (value === undefined) return 'Unknown · not entered'
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (typeof value === 'number') return field.type === 'money' ? formatMoney(value) : `${new Intl.NumberFormat().format(value)}${field.unit ? ' ' + field.unit : ''}`
    if (typeof value === 'object' && value !== null && Number.isFinite(value.low) && Number.isFinite(value.high))
      return formatMoney(value.low) + (value.high === value.low ? '' : '–' + formatMoney(value.high))
    return field.type === 'enum' ? enumLabel(value) : String(value).replaceAll('_', ' ')
  }
  const workflowEditorView = createSmeWorkflowEditor({
    workflowEditor, claimInputs, evidenceEditor, heading: $('#sme-workflow-editor-heading'), note: $('#sme-workflow-editor-note'),
    evidenceHeading: $('#sme-workflow-evidence-heading'), parameterDetails: $('#sme-workflow-parameter-details'), workflowStatus,
    getFields: () => currentFields, getProtocol: () => currentProtocol,
    getSlots: () => comparisonSlotElements.slice(0, Number(comparisonCount.value)), getSelectedSlot: () => selectedWorkflowSet,
    getEvidenceField: () => selectedEvidenceField, setEvidenceField: value => { selectedEvidenceField = value },
    node, option, enumLabel, formatClaim, formatMoney, invalidate: invalidateComparison,
  })
  function renderWorkflowEditor() { workflowEditorView.render() }
  function tableSlots(value) {
    const supplied = new Map((value?.slots ?? []).map(slot => [slot.slot, slot]))
    return comparisonSlotElements.map((item, index) => {
      const slot = supplied.get(item.slot), visible = index < Number(comparisonCount.value)
      return { ...slot, slot: item.slot, status: slot?.status ?? (visible ? 'ready' : 'not_supplied'), report: slot?.report ?? null, evidence: item.evidence }
    })
  }
  function tableDimensions() {
    const lines = currentProtocol?.budget_lines ?? []
    const parameterDimensions = (currentProtocol?.parameters ?? []).map((parameter, index) => ({
      id: 'pack-parameter-' + (index + 1),
      name: 'Pack parameter · ' + (parameter?.label ?? parameter?.name ?? parameter?.id ?? index + 1),
      read: () => JSON.stringify(parameter) ?? 'Not supplied.',
    }))
    const reportValue = (slot, read) => slot.status === 'not_supplied' ? 'Not in this comparison.' : slot.report ? read(slot.report) : 'Not run · run local check'
    const completeness = report => report.check.completeness
    const tierSummary = report => Object.entries(report.check.claim_counts_by_tier).map(([tier, count]) => `${tier} ${count}`).join(' · ')
    const evidenceDifferences = report => report.check.raw_differences.length
      ? report.check.raw_differences.map(row => `${lineLabel(row.claim_kind)} · entered ${JSON.stringify(row.claimed)} · sighted ${JSON.stringify(row.observed)}`).join(' · ')
      : 'No numeric difference recorded.'
    const evidenceRecords = slot => slot.evidence.length
      ? slot.evidence.map((row, index) => {
        const field = currentFields.find(item => item.name === row.claim_kind)
        const value = field ? formatClaim(field, row.value) : JSON.stringify(row.value)
        return `${index + 1}. ${lineLabel(row.claim_kind)} · ${value} · ${enumLabel(row.provenance)} · ${enumLabel(row.observer_role)} · ${row.date}`
      }).join(' · ')
      : 'No evidence entries recorded.'
    const tasks = report => report.tasks?.length
      ? report.tasks.map(task => `${task.order}. ${task.label} · ${formatMoney(task.cash_retired_midpoint)} · ${task.tasks.map(item => item.task).join(' ')}`).join(' · ')
      : 'No ordered evidence-led check from current amounts.'
    const dimensions = [
      { id: 'pack-context', name: 'Workflow · pack context', read: () => currentProtocol?.pack ? `${currentProtocol.pack.country} · ${currentProtocol.pack.currency} · v${currentProtocol.pack.version} · ${currentProtocol.pack.review_status}` : 'Loading pack…' },
      ...parameterDimensions,
      { id: 'workflow-completeness', name: 'Workflow · required inputs', read: slot => reportValue(slot, report => {
        const status = completeness(report), missing = status.required - status.supplied
        return missing ? `Incomplete · ${status.supplied}/${status.required} required fields · ${missing} unknown` : `Entered · ${status.supplied}/${status.required} required fields`
      }) },
      { id: 'workflow-evidence-records', name: 'Workflow · evidence records', read: slot => slot.status === 'not_supplied' ? 'Not in this comparison.' : evidenceRecords(slot) },
      { id: 'workflow-evidence', name: 'Workflow · evidence tiers', read: slot => reportValue(slot, tierSummary) },
      { id: 'workflow-calculation', name: 'Workflow · calculation state', read: slot => reportValue(slot, report => report.budget.budget.incomplete ? 'Incomplete · one or more cash lines unknown' : 'Calculated · provisional inputs and evidence') },
      { id: 'cash-to-close', name: 'Outcome · cash to close', read: slot => reportValue(slot, report => formatComparisonRange(report.budget.budget.cash_to_close)) },
      { id: 'gap-above-asking', name: 'Outcome · gap above asking price', read: slot => reportValue(slot, report => formatComparisonRange(report.budget.budget.gap_above_asking_price)) },
      { id: 'opening-runway', name: 'Outcome · opening runway', read: slot => reportValue(slot, report => { const runway = report.budget.budget.opening_runway; return runway?.months ? runway.months.low + '–' + runway.months.high + ' months' : runway?.status === 'no_monthly_shortfall' ? 'No monthly shortfall indicated' : runway?.status ? 'Unknown · ' + runway.status.replaceAll('_', ' ') : 'Unknown · incomplete' }) },
      { id: 'lease-exposure', name: 'Outcome · lease exposure', read: slot => reportValue(slot, report => formatComparisonRange(report.budget.budget.lease_exposure)) },
      { id: 'unchecked-share', name: 'Outcome · unchecked cash share', read: slot => reportValue(slot, report => report.budget.budget.unchecked_share === null ? 'Unknown · incomplete' : Math.round(report.budget.budget.unchecked_share * 100) + '%') },
      ...lines.map(line => ({ id: 'line-' + line.id, name: `Cash line · ${line.id.toUpperCase()} · ${line.label}`, read: slot => reportValue(slot, report => {
        const item = report.budget.budget.lines.find(row => row.id === line.id)
        if (!item?.complete) return 'Unknown · incomplete' + (item?.missing_claims?.length ? ' · ' + item.missing_claims.map(lineLabel).join(', ') : '')
        return formatComparisonRange(item) + (item.checked ? ' · evidence tier reached' : ' · evidence needed')
      }) })),
      { id: 'arithmetic', name: 'Workflow · arithmetic observations', read: slot => reportValue(slot, report => arithmeticText(report.budget.budget.arithmetic_flags)) },
      { id: 'evidence-differences', name: 'Workflow · evidence differences', read: slot => reportValue(slot, evidenceDifferences) },
      { id: 'next-checks', name: 'Workflow · next checks', read: slot => reportValue(slot, tasks) },
      { id: 'transfer-checklist', name: 'Workflow · transfer checklist', read: slot => tableMessage ? slot.slot === 'A' ? tableMessage : 'Pack-level checklist · see Set A.' : 'Not requested.' },
    ]
    return dimensions
  }
  function workflowTableView() {
    const slots = comparisonSlotElements.slice(0, Number(comparisonCount.value))
    const resultSlots = tableSlots(comparisonValue)
    const dimensions = tableDimensions()
    const columns = [{ id: 'claim-set', name: 'Claim set' }, ...currentFields.map(field => ({ id: field.name, name: 'Input · ' + field.label + (field.unit ? ' · ' + field.unit : '') })),
      ...dimensions.map(({ id, name }) => ({ id, name }))]
    const rows = slots.map(item => ({ id: item.slot, cells: [`Set ${item.slot}`,
      ...currentFields.map(field => {
        const count = item.evidence.filter(row => row.claim_kind === field.name).length
        return formatClaim(field, item.claims[field.name]) + (count ? ` · ${count} evidence ${count === 1 ? 'entry' : 'entries'}` : '')
      }), ...dimensions.map(dimension => dimension.read(resultSlots.find(slot => slot.slot === item.slot)))] }))
    return { columns, rows, layout: 'multiDimensional', orientation: tableOrientation,
      ariaLabel: 'SME E2E workflow; claim sets are rows and every pack field, evidence check and outcome is a column.', selectedRowId: selectedWorkflowSet ?? undefined,
      onActivateRow: slot => {
        if (!slots.some(item => item.slot === slot)) return
        selectedWorkflowSet = slot; renderWorkflowEditor()
        workflowStatus.textContent = `Editing Set ${slot}. Values and evidence stay on this device.`
        void renderWorkflowTable()
      }, onOrientationChange: orientation => {
        if (!workflowTableHost.isConnected) return
        tableOrientation = orientation
        workflowTableRegion.dataset.orientation = orientation
        workflowTableRegion.setAttribute('aria-label', orientation === 'rows'
          ? 'Claim sets as rows; all input fields, workflow checks and outcomes as columns.'
          : 'The same E2E workflow pivoted to fields and outcomes as records.')
        void renderWorkflowTable()
      } }
  }
  async function renderWorkflowTable(expectedGeneration = comparisonGeneration) {
    const current = () => expectedGeneration === comparisonGeneration
    const ok = await renderSharedTable(workflowTableHost, workflowTableView(), workflowTableMount, current)
    if (!ok && current())
      workflowStatus.textContent = 'Shared workflow table unavailable. Reload this page to retry.'
    return ok || !current()
  }
  async function runPlan(item = comparisonSlotElements[0]) {
    return invokeSmePackTool('takeover.plan', { pack_id: packSelect.value, claims: readClaims(item), evidence: item.evidence })
  }
  async function fillWorksheet(worksheet) {
    if (worksheet?.schema !== 'sme-business-pack/worksheet/v1' || worksheet.pack_id !== packSelect.value
      || !worksheet.claims || typeof worksheet.claims !== 'object' || !Array.isArray(worksheet.evidence)) throw Error('worksheet_invalid')
    const candidate = { pack_id: worksheet.pack_id, claims: worksheet.claims, evidence: worksheet.evidence }
    await invokeSmePackTool('takeover.check', candidate)
    const item = comparisonSlotElements[0]
    item.claims = { ...worksheet.claims }
    item.evidence.splice(0, item.evidence.length, ...worksheet.evidence.map(row => ({ ...row })))
    selectedWorkflowSet = 'A'
    renderWorkflowEditor(); invalidateComparison()
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
    workflowStatus.textContent = 'Worksheet imported in this tab. Run a local check to calculate its workflow columns.'
  }
  async function refreshFields(packId = packSelect.value) {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packId })
    if (packId !== packSelect.value) return false
    currentProtocol = protocol
    currentFields = currentProtocol.claim_kinds
    serviceStatus.textContent = `${currentProtocol.pack.country} · ${currentProtocol.pack.currency} · v${currentProtocol.pack.version} · ${currentProtocol.pack.review_status}`
    return true
  }
  function updateComparisonSlotVisibility() {
    const count = Number(comparisonCount.value)
    for (const [index, item] of comparisonSlotElements.entries()) {
      if (index >= count) { item.claims = {}; item.evidence.length = 0 }
    }
    if (selectedWorkflowSet && !comparisonSlotElements.slice(0, count).some(item => item.slot === selectedWorkflowSet)) selectedWorkflowSet = 'A'
    renderWorkflowEditor()
    compareButton.textContent = count === 1 ? 'Run local check' : `Compare ${count} sets locally`
  }
  function invalidateComparison() {
    ++comparisonGeneration
    comparisonPending = false; compareButton.disabled = false
    comparisonValue = null; tableMessage = null
    workflowStatus.textContent = 'Inputs changed. Run a local check to refresh workflow and outcome columns.'
    void renderWorkflowTable()
  }
  function clearComparison() {
    tableMessage = null; comparisonCount.value = '1'
    for (const item of comparisonSlotElements) {
      item.claims = {}; item.evidence.length = 0
    }
    selectedWorkflowSet = null; renderWorkflowEditor()
    updateComparisonSlotVisibility(); invalidateComparison()
  }
  function formatComparisonRange(range) {
    if (!range || range.low === null || range.high === null) {
      return range?.low === null || !range ? 'Unknown · incomplete' : 'Known subtotal ≥ ' + formatMoney(range.low) + ' · total unknown'
    }
    return formatMoney(range.low) + (range.high === range.low ? '' : '–' + formatMoney(range.high))
  }
  function arithmeticText(flags = []) {
    if (!flags.length) return 'None from pack-defined arithmetic checks.'
    return flags.map(flag => flag.code === 'rent_to_sales_arithmetic_bound'
      ? flag.observation === 'above' ? 'Rent-to-sales ratio exceeds the pack arithmetic-only bound.'
        : 'Rent-to-sales range crosses the pack arithmetic-only bound.'
      : 'Break-even arithmetic exceeds the claimed sales range.').join(' ')
  }
  async function renderSharedTable(host, view, mount, isCurrent = () => true) {
    const generation = ++mount.generation
    try {
      const adapter = await (tableAdapter ??= import('./agentic-base-data-view.js?v=base-0cd7602-sme-workflow-table-v2')
        .catch(error => { tableAdapter = null; throw error }))
      if (generation !== mount.generation || !isCurrent() || !host.isConnected) return false
      let target = host.shadowRoot?.querySelector('[data-sme-table-target]')
      if (!target) {
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' }), stylesheet = document.createElement('link')
        target = node('div'); target.dataset.smeTableTarget = 'true'; target.style.cssText = 'width:100%;height:100%'
        stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./agentic-base-data-view.css?v=base-0cd7602-sme-workflow-table-v2', import.meta.url).href
        for (const [name, token] of Object.entries({ '--agentic-base-text': '--commerce-ink', '--agentic-base-surface': '--commerce-surface', '--agentic-base-border': '--commerce-border', '--agentic-base-muted': '--commerce-text-muted', '--agentic-base-header': '--commerce-surface-subtle', '--agentic-base-selected': '--commerce-accent-soft', '--agentic-base-hover': '--commerce-accent-soft', '--agentic-base-focus': '--commerce-focus' })) host.style.setProperty(name, `var(${token})`)
        mount.ready = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('shared_table_styles_unavailable')), 8000)
          stylesheet.onload = () => { clearTimeout(timer); resolve() }
          stylesheet.onerror = () => { clearTimeout(timer); reject(Error('shared_table_styles_unavailable')) }
        })
        shadow.append(stylesheet, target)
      }
      await mount.ready
      if (generation !== mount.generation || !isCurrent() || !host.isConnected) return false
      mount.handle ? mount.handle.update(view) : mount.handle = adapter.mountDataView(target, view)
      return true
    } catch {
      if (!mount.handle) host.shadowRoot?.replaceChildren()
      mount.ready = null
      return false
    }
  }
  async function runComparison() {
    const count = Number(comparisonCount.value), identity = PACK_INDEX.find(pack => pack.id === packSelect.value)
    if (!identity) { workflowStatus.textContent = 'Check refused. The selected pack is unavailable.'; return }
    const claimSets = comparisonSlotElements.slice(0, count).map(item => ({ pack_id: identity.id, pack_version: identity.version,
      currency: identity.currency, claims: readClaims(item), ...(item.evidence.length ? { evidence: item.evidence } : {}) }))
    const generation = ++comparisonGeneration
    comparisonPending = true; compareButton.disabled = true; tableMessage = null; comparisonValue = null
    workflowStatus.textContent = count === 1 ? 'Checking locally…' : 'Comparing locally…'
    void renderWorkflowTable()
    let deadline, timedOut = false
    try {
      const pending = count === 1 ? runPlan(comparisonSlotElements[0])
        .then(report => ({ schema: 'sme-business-pack/table-report/v1', pack: currentProtocol.pack,
          slots: [{ slot: 'A', status: 'included', report }], persisted: false, inference_tokens: 0 }))
        : invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: claimSets })
      const value = await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = true; reject(Error('sme_pack_comparison_deadline')) }, 2000) })])
      if (generation !== comparisonGeneration || document.body.dataset.workspaceRole !== 'sme') return
      comparisonValue = value
      if (!await renderWorkflowTable()) throw Error('shared_table_unavailable')
      workflowStatus.textContent = count === 1 ? 'On-device calculation · inputs and reports are not saved or sent' : 'Local comparison · inputs and reports are not saved or sent'
    } catch {
      if (generation === comparisonGeneration && document.body.dataset.workspaceRole === 'sme') {
        comparisonValue = null; void renderWorkflowTable()
        workflowStatus.textContent = timedOut ? 'Check exceeded 2 seconds; no report was kept.' : 'Check refused. Review closed inputs and the shared pack identity.'
      }
    } finally {
      clearTimeout(deadline)
      if (generation === comparisonGeneration) { comparisonPending = false; compareButton.disabled = false }
    }
  }
  for (const pack of PACK_INDEX) option(packSelect, pack.id, pack.country + ' · ' + pack.asset_type.toUpperCase() + ' · ' + pack.currency + ' · ' + pack.review_status)
  packSelect.value = PACK_INDEX[0].id
  $('#sample').textContent = 'Load illustrative inputs'
  runtimeMode.textContent = 'SME BUSINESS PACK · LOCAL WORKSPACE'
  runtimeStatus.textContent = 'Local computation ready. No service request is needed.'
  $('#mcp-url').textContent = new URL('services/sme-business-pack/mcp', document.baseURI).href
  $('#webmcp-status').textContent = 'Browser tools are optional; local checks work without a network.'
  await refreshFields()
  comparisonCount.value = '1'; updateComparisonSlotVisibility()
  workflowTableRegion.setAttribute('aria-label', 'Claim sets as rows; all input fields, workflow checks and outcomes as columns.')
  void renderWorkflowTable()
  comparisonCount.addEventListener('change', () => { updateComparisonSlotVisibility(); invalidateComparison() })
  packSelect.addEventListener('change', async () => {
    const generation = ++packGeneration
    clearComparison()
    if (await refreshFields(packSelect.value) && generation === packGeneration) {
      renderWorkflowEditor(); void renderWorkflowTable()
    }
  })
  form.addEventListener('submit', event => { event.preventDefault(); void runComparison() })
  $('#checklist').addEventListener('click', async () => {
    const generation = ++comparisonGeneration, packId = packSelect.value
    comparisonPending = false; compareButton.disabled = false; tableMessage = null
    try {
      const value = await invokeSmePackTool('takeover.transfer_checklist', { pack_id: packId })
      if (generation !== comparisonGeneration || packId !== packSelect.value) return
      tableMessage = value.available ? value.checklist.map((item, index) => `${index + 1}. ${item}`).join(' · ')
        : `Withheld · ${String(value.reason || 'review required').replaceAll('_', ' ')}`
      if (!await renderWorkflowTable()) return
      workflowStatus.textContent = value.available ? 'Checklist is shown in the E2E workflow table.' : `Checklist unavailable: ${tableMessage}`
    }
    catch { if (generation === comparisonGeneration) workflowStatus.textContent = 'Checklist request refused.' }
  })
  $('#sample').addEventListener('click', () => {
    const sample = {
      listing_source: 'classifieds', subtype: 'cafe', price: 150000, equipment_included: true,
      equipment_cost: 0, rent_monthly: 6000, lease_remaining_months: 24, deposit_months: 3,
      utilities_deposits: 2500, transfer_cost: 8000, repairs_provision: 12000, monthly_sales: 45000,
      staff_count: 5, payroll_monthly: 14000, utilities_monthly: 900, runway_months: 3,
      variable_cost_bps: 3500, licence_status: 'unknown',
    }
    comparisonCount.value = '1'; updateComparisonSlotVisibility()
    const item = comparisonSlotElements[0]; item.claims = {}
    for (const field of currentFields) {
      const value = sample[field.name]
      if (value === undefined) continue
      item.claims[field.name] = value
    }
    item.evidence.length = 0; selectedWorkflowSet = 'A'; selectedEvidenceField = currentFields.find(field => field.retiring_tier)?.name ?? currentFields[0]?.name ?? null
    renderWorkflowEditor(); invalidateComparison()
    workflowStatus.textContent = 'Sample values are illustrative buyer inputs and remain in this tab.'
  })
  for (const button of worksheetActions.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
    try {
      const plan = await runPlan(), format = button.dataset.export
      const suffix = format === 'markdown' ? 'md' : format
      const content = plan.worksheet[format]
      if (typeof content !== 'string') throw Error('worksheet_format_missing')
      download('sme-takeover-worksheet.' + suffix, format === 'json' ? 'application/json'
        : format === 'csv' ? 'text/csv' : 'text/markdown', content)
      workflowStatus.textContent = 'Worksheet downloaded locally. No report was uploaded.'
    } catch { workflowStatus.textContent = 'Worksheet export refused. Review the entered values.' }
  })
  printButton.addEventListener('click', async () => {
    let sheet
    try {
      const plan = await runPlan(), worksheet = JSON.parse(plan.worksheet.json)
      if (worksheet.schema !== 'sme-business-pack/worksheet/v1' || worksheet.evidence.length > 40) throw Error('worksheet_evidence_limit')
      sheet = node('article', undefined, 'sme-print-sheet')
      sheet.append(node('h1', 'SME takeover worksheet'), node('p', plan.pack.country + ' · ' + plan.pack.currency + ' · pack v' + plan.pack.version + ' · as of ' + plan.pack.as_of + ' · ' + plan.pack.review_status))
      const table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody'), addRow = (kind, field, value) => {
        const row = node('tr'); row.append(node('th', kind), node('td', field), node('td', value)); body.append(row)
      }
      for (const label of ['Kind', 'Field', 'Buyer entry / evidence']) header.append(node('th', label))
      head.append(header); table.append(head, body)
      addRow('Budget', 'Cash to close · low–high', JSON.stringify(plan.budget.budget.cash_to_close))
      for (const [key, value] of Object.entries(worksheet.claims)) addRow('Buyer claim', lineLabel(key), JSON.stringify(value))
      for (const row of worksheet.evidence) addRow('Evidence', lineLabel(row.claim_kind), JSON.stringify(row.value) + ' · ' + row.provenance + ' · ' + row.observer_role + ' · ' + row.date)
      sheet.append(table, node('h2', 'Next checks by cash amount'))
      const tasks = node('ol')
      for (const task of plan.tasks) tasks.append(node('li', 'Step ' + task.order + ' · ' + task.label + ' · ' + formatMoney(task.cash_retired_midpoint) + ' · ' + task.tasks.map(item => item.task).join(' ')))
      sheet.append(tasks, node('p', plan.check.disclaimer))
      const cleanup = () => { sheet.remove(); document.body.classList.remove('sme-printing') }
      document.body.append(sheet); document.body.classList.add('sme-printing')
      window.addEventListener('afterprint', cleanup, { once: true }); window.print()
      workflowStatus.textContent = 'Print view opened. Use the browser dialog to print or save locally.'
    } catch (error) {
      sheet?.remove(); document.body.classList.remove('sme-printing')
      workflowStatus.dataset.printError = error instanceof Error ? error.message : 'unknown'
      workflowStatus.textContent = 'Print worksheet refused. Review the entered values.'
    }
  })
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]; if (!file) return
    try { await importWorksheet(file) }
    catch { workflowStatus.textContent = 'Worksheet import refused. Use an unmodified JSON, CSV or Markdown worksheet.' }
    finally { importInput.value = '' }
  })
  const modelContext = document.modelContext?.registerTool ? document.modelContext : navigator.modelContext
  async function activate() {
    if (active) return
    active = true
    if ('scrollRestoration' in history) {
      previousScrollRestoration = history.scrollRestoration
      history.scrollRestoration = 'manual'
    }
    if (!modelContext?.registerTool) { $('#webmcp-status').textContent = 'This browser does not expose WebMCP. Use the MCP endpoint or local form.'; return }
    const controller = new AbortController(); registration = controller; let deadline
    try {
      await Promise.race([Promise.all(TOOL_SCHEMAS.map(tool => modelContext.registerTool({
        name: tool.name, description: tool.name.replaceAll('.', ' ') + ' · pack-scoped · no user facts persist',
        inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
        execute: async (input, options) => {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2500), ...(options?.signal ? [options.signal] : [])])
          if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
          const value = await invokeSmePackTool(tool.name, input)
          if (signal.aborted) throw Error('sme_pack_browser_tool_cancelled')
          return { content: [{ type: 'text', text: JSON.stringify(value) }] }
        },
      }, { signal: controller.signal }))), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('timeout')), 2000) })])
      if (active && !controller.signal.aborted) $('#webmcp-status').textContent = `${TOOL_SCHEMAS.length} optional pack tools registered.`
    } catch {
      controller.abort(); if (registration === controller) registration = null
      if (active) $('#webmcp-status').textContent = 'Browser tool registration unavailable. Local checks still work offline.'
      active = false
    } finally { clearTimeout(deadline) }
  }
  function deactivate() {
    active = false
    if (previousScrollRestoration !== null) {
      history.scrollRestoration = previousScrollRestoration; previousScrollRestoration = null
    }
    clearComparison()
    const registered = Boolean(registration); registration?.abort(); registration = null
    if (registered) for (const tool of TOOL_SCHEMAS) modelContext?.unregisterTool?.(tool.name)
  }
  function updateSectionNavigation() {
    const section = location.hash.slice(1).split('?')[0] || 'sme'
    const isSmeSection = section === 'sme' || section.startsWith('sme-')
    const targetId = ['sme-compare', 'sme-check-form', 'sme-report'].includes(section) ? 'sme-workflow' : section
    const activeHash = '#sme-workflow'
    for (const link of document.querySelectorAll('#sme-navigation .service-nav a')) {
      if (link.hash === activeHash && isSmeSection) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
    if (isSmeSection) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (location.hash.slice(1).split('?')[0] !== section) return
      const target = section === 'sme' ? root : document.getElementById(targetId)
      target?.scrollIntoView({ block: 'start' })
    }))
  }
  window.addEventListener('hashchange', updateSectionNavigation)
  window.addEventListener('pagehide', deactivate, { once: true })
  window.addEventListener('pageshow', () => { if (document.body.dataset.workspaceRole === 'sme') void activate() })
  updateSectionNavigation()
  return { activate, deactivate, updateSectionNavigation }
}
