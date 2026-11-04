import { invokeSmePackTool, PACK_INDEX, TOOL_SCHEMAS } from './sme-business-pack-core.js'
import { getOrCreateSingleton } from './workspace-singleton.js'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./sme-business-pack.css?v=sme-e2e-workflow-multidim-5', import.meta.url).href
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
  const tableHost = $('#sme-table-host'), tableRegion = $('#sme-results-table-region')
  const workflowTableHost = $('#sme-workflow-table-host'), workflowTableRegion = $('#sme-workflow-table-region')
  const workflowEditor = $('#sme-workflow-editor'), claimInputs = $('#sme-workflow-claim-inputs')
  const evidenceEditor = $('#sme-workflow-evidence-editor'), resultStatus = $('#result-status')
  const workflowStatus = $('#workflow-status'), serviceStatus = $('#service-status')
  const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
  let currentFields = [], currentProtocol, registration, active = false, previousScrollRestoration = null,
    comparisonGeneration = 0, packGeneration = 0, comparisonPending = false, tableOrientation = 'columns',
    workflowOrientation = 'rows', tableMessage = null, selectedWorkflowField = null, tableAdapter = null
  const comparisonSlotElements = ['A', 'B', 'C'].map(slot => ({ slot, claims: {}, evidence: [] }))
  const resultTableMount = { handle: null, ready: null, generation: 0 }
  const workflowTableMount = { handle: null, ready: null, generation: 0 }
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element }
  const option = (select, value, label) => { const item = node('option', label); item.value = value; select.append(item) }
  const enumLabel = value => value.replaceAll('_', ' ').replace(/^\w/, letter => letter.toUpperCase())
  const inputControl = (field, prefix) => {
    const wrap = node('section', undefined, 'field')
    const label = node('label', field.label + (field.unit ? ' · ' + field.unit : ''))
    const id = prefix + '-' + field.name, scope = prefix === 'compare-evidence' ? 'Evidence value' : `Set ${prefix.at(-1).toUpperCase()}`
    if (field.type === 'enum' || field.type === 'boolean') {
      const control = node('select'); control.id = id; control.dataset.claim = field.name; control.autocomplete = 'off'
      option(control, '', 'Choose…')
      const values = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.values.map(value => [value, enumLabel(value)])
      for (const value of values) option(control, value[0], value[1])
      label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${field.label}`); control.setAttribute('aria-required', String(Boolean(field.required))); wrap.append(label, control); return wrap
    }
    if (field.type === 'money') {
      const currency = currentProtocol?.pack.currency || 'SGD', range = node('div', undefined, 'cash-range-input')
      const heading = node('span', field.label + ' · ' + currency, 'field-label')
      range.setAttribute('role', 'group'); range.setAttribute('aria-label', field.label + ' range')
      for (const bound of ['low', 'high']) {
        const control = node('input'); control.type = 'number'; control.min = '0'; control.max = '100000000'; control.step = '1'
        control.inputMode = 'numeric'; control.autocomplete = 'off'
        control.id = id + '-' + bound; control.dataset.claim = field.name; control.dataset.bound = bound
        control.setAttribute('aria-label', `${scope} ${field.label} ${bound === 'low' ? 'minimum' : 'maximum'} amount in ${currency}${bound === 'high' ? ' (optional)' : ''}`)
        control.setAttribute('aria-required', String(Boolean(field.required) && bound === 'low'))
        control.placeholder = bound === 'low' ? 'Amount' : 'Optional'
        const boundLabel = node('label', `${bound === 'low' ? 'Minimum' : 'Maximum'} · ${currency}`, 'cash-bound')
        boundLabel.htmlFor = control.id; boundLabel.append(control); range.append(boundLabel)
      }
      const hint = node('span', 'Whole amounts · enter one value or a low–high range; leave maximum blank for one amount.', 'field-help')
      hint.id = id + '-range-help'
      for (const control of range.querySelectorAll('input')) control.setAttribute('aria-describedby', hint.id)
      wrap.append(heading, range, hint); return wrap
    }
    const control = node('input'); control.type = 'number'; control.step = '1'; control.inputMode = 'numeric'
    control.min = String(field.min ?? 0); control.max = String(field.max ?? 100000000)
    control.id = id; control.dataset.claim = field.name; control.autocomplete = 'off'
    label.htmlFor = id; control.setAttribute('aria-label', `${scope} ${label.textContent}`); control.setAttribute('aria-required', String(Boolean(field.required))); wrap.append(label, control); return wrap
  }
  const readValue = (field, prefix) => {
    const id = prefix + '-' + field.name, raw = (field.type === 'money' ? $('#' + id + '-low') : $('#' + id))?.value
    if (field.type === 'enum' || field.type === 'boolean') return raw === '' || raw === undefined ? undefined : field.type === 'boolean' ? raw === 'true' : raw
    if (field.type === 'money') { const highText = $('#' + id + '-high')?.value; if (raw === '' || raw === undefined) return undefined; const low = Number(raw), high = highText === '' ? low : Number(highText); return highText === '' ? low : { low, high } }
    return raw === '' || raw === undefined ? undefined : Number(raw)
  }
  const readClaims = item => ({ ...item.claims })
  function writeValue(field, prefix, value, scope = root) {
    const id = prefix + '-' + field.name
    if (field.type === 'money') {
      const range = value === undefined ? null : typeof value === 'number' ? { low: value, high: value } : value
      const low = scope.querySelector('#' + id + '-low'), high = scope.querySelector('#' + id + '-high')
      if (low) low.value = range ? String(range.low) : ''
      if (high) high.value = range && range.high !== range.low ? String(range.high) : ''
    } else {
      const control = scope.querySelector('#' + id)
      if (control) control.value = value === undefined ? '' : String(value)
    }
  }
  const formatMoney = (value, currency = currentProtocol?.pack.currency || 'SGD') => new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
  const lineLabel = id => currentFields.find(field => field.name === id)?.label || id.replaceAll('_', ' ')
  function download(name, mime, content) { const url = URL.createObjectURL(new Blob([content], { type: mime })); const anchor = node('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
  const provenanceValues = [
    ['seller_stated', 'Seller stated · T0'], ['buyer_assumed', 'Buyer assumed · T0'],
    ['observed_on_site', 'Observed on site · T1'], ['measured_on_foot', 'Measured on foot · T1'],
    ['counted_on_site', 'Counted on site · T1'], ['document_sighted', 'Document sighted · T2'],
    ['third_party_confirmed', 'Third party confirmed · T3'],
  ]
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
  function fieldGuidance(field) {
    const details = node('dl', undefined, 'workflow-parameter-grid')
    const add = (name, value) => { const row = node('div'); row.append(node('dt', name), node('dd', value)); details.append(row) }
    const protocols = currentProtocol?.protocols ?? []
    const protocol = protocols.find(row => row.claim_kind === field.name)
    const lines = (currentProtocol?.budget_lines ?? []).filter(row => row.claim_kinds.includes(field.name))
    const bounds = field.type === 'money' ? `0–${formatMoney(100000000)} · whole amounts; single value or range`
      : field.type === 'integer' ? `${field.min ?? 0}–${field.max ?? 'no upper limit'}${field.unit ? ' ' + field.unit : ''} · whole numbers`
        : field.type === 'enum' ? field.values.map(enumLabel).join(' · ')
          : field.type === 'boolean' ? 'Yes · No' : field.type
    add('Input', field.type === 'money' ? `Amount · ${currentProtocol?.pack.currency || 'SGD'}` : field.type === 'integer' ? `Whole number${field.unit ? ' · ' + field.unit : ''}` : field.type === 'enum' ? 'Choose one' : 'Yes or no')
    add('Completeness', field.required ? 'Required for a complete local check · blank stays unknown' : 'Optional pack field')
    add(field.type === 'enum' || field.type === 'boolean' ? 'Allowed values' : field.type === 'money' || field.type === 'integer' ? 'Entry limits' : 'Entry rule', bounds)
    if (lines.length) add('Budget use', lines.map(line => `${line.id} · ${line.label}${line.formula ? ` (${line.formula})` : ''}`).join(' · ')); add('Evidence target', protocol ? `${protocol.tier} · ${protocol.provenance.replaceAll('_', ' ')}${protocol.effort_min ? ` · ${protocol.effort_min} min planned` : ''}` : field.retiring_tier ? `${field.retiring_tier} target · see the pack review note` : 'No evidence tier defined for this input')
    if (protocol) add('Next evidence check', protocol.task); return details
  }
  function tableSlots(value) {
    const supplied = new Map((value?.slots ?? []).map(slot => [slot.slot, slot]))
    return comparisonSlotElements.map((item, index) => {
      const slot = supplied.get(item.slot), visible = index < Number(comparisonCount.value)
      return { ...slot, slot: item.slot, status: slot?.status ?? (visible ? 'ready' : 'not_supplied'), report: slot?.report ?? null }
    })
  }
  function tableDimensions(value, slots) {
    const first = slots.find(slot => slot.report)?.report
    const lines = first?.budget.budget.lines ?? currentProtocol?.budget_lines ?? []
    const reportValue = (slot, read) => slot.status === 'not_supplied' ? 'Not supplied.' : slot.report ? read(slot.report) : 'Unknown · run local check'
    const missing = report => report.check.completeness.missing_claims.join(', ') || 'None reported'
    const tiers = report => Object.entries(report.check.claim_counts_by_tier).map(([tier, count]) => tier + ' ' + count).join(' · ')
    const evidenceDifferences = report => report.check.raw_differences.length
      ? report.check.raw_differences.map(row => `${lineLabel(row.claim_kind)} · claim ${JSON.stringify(row.claimed)} · sighted ${JSON.stringify(row.observed)}`).join(' · ')
      : 'No numeric difference recorded.'
    const tasks = report => report.tasks?.length ? report.tasks.map(task => `${task.order}. ${task.label} · ${formatMoney(task.cash_retired_midpoint)} · ${task.tasks.map(item => item.task).join(' ')}`).join(' · ') : 'No next check reported.'
    const dimensions = [
      { id: 'option', name: 'Option', read: slot => slot.status === 'not_supplied' ? 'Not supplied.' : slot.slot },
      { id: 'cash-to-close', name: 'Cash to close', read: slot => reportValue(slot, report => formatComparisonRange(report.budget.budget.cash_to_close)) },
      { id: 'gap-above-asking', name: 'Gap above asking price', read: slot => reportValue(slot, report => formatComparisonRange(report.budget.budget.gap_above_asking_price)) },
      { id: 'opening-runway', name: 'Opening runway', read: slot => reportValue(slot, report => { const runway = report.budget.budget.opening_runway; return runway?.months ? runway.months.low + '–' + runway.months.high + ' months' : runway?.status === 'no_monthly_shortfall' ? 'No monthly shortfall indicated' : runway?.status ? 'Unknown · ' + runway.status.replaceAll('_', ' ') : 'Unknown · incomplete' }) },
      { id: 'lease-exposure', name: 'Lease exposure', read: slot => reportValue(slot, report => formatComparisonRange(report.budget.budget.lease_exposure)) },
      { id: 'unchecked-share', name: 'Unchecked share', read: slot => reportValue(slot, report => report.budget.budget.unchecked_share === null ? 'Unknown · incomplete' : Math.round(report.budget.budget.unchecked_share * 100) + '%') },
      { id: 'missing-claims', name: 'Missing claims', read: slot => reportValue(slot, missing) },
      { id: 'arithmetic', name: 'Arithmetic observations', read: slot => reportValue(slot, report => arithmeticText(report.budget.budget.arithmetic_flags)) },
      ...lines.map(line => ({ id: 'line-' + line.id, name: 'Budget · ' + line.label, read: slot => reportValue(slot, report => { const item = report.budget.budget.lines.find(row => row.id === line.id); return item?.complete ? formatComparisonRange(item) + (item.checked ? ' · tier reached' : ' · evidence needed') : 'Unknown · incomplete' }) })),
      { id: 'claim-tiers', name: 'Claims by tier', read: slot => reportValue(slot, tiers) },
      { id: 'evidence-differences', name: 'Evidence differences', read: slot => reportValue(slot, evidenceDifferences) },
      { id: 'next-checks', name: 'Next checks', read: slot => reportValue(slot, tasks) },
      { id: 'disclaimer', name: 'Review note', read: slot => reportValue(slot, report => report.check.disclaimer) },
      { id: 'pack', name: 'Pack', read: () => { const pack = value?.pack ?? currentProtocol?.pack; return pack ? `${pack.country} · ${pack.currency} · v${pack.version} · ${pack.as_of} · ${pack.review_status}` : 'Loading pack…' } },
    ]
    if (tableMessage) dimensions.splice(1, 0, { id: 'table-message', name: 'Local tool response', read: slot => slot.slot === 'A' ? tableMessage : 'Not applicable.' })
    return dimensions
  }
  function tableView(value) {
    const slots = tableSlots(value), dimensions = tableDimensions(value, slots)
    return { columns: dimensions.map(({ id, name }) => ({ id, name })), rows: slots.map(slot => ({ id: slot.slot, cells: dimensions.map(dimension => dimension.read(slot)) })),
      layout: 'multiDimensional', orientation: tableOrientation, ariaLabel: 'SME calculated results, evidence checks and next steps Multi-dimensional Table',
      onOrientationChange: orientation => {
        if (!tableHost.isConnected) return
        tableOrientation = orientation
        const region = tableHost.closest('.comparison-table-scroll')
        region.dataset.orientation = orientation
        region.setAttribute('aria-label', orientation === 'columns'
          ? 'SME calculated results; options and cash, lease, evidence and next-check dimensions.'
          : 'SME calculated results pivoted to dimensions as records.')
        void renderSharedTable(tableHost, tableView(value), resultTableMount)
      } }
  }
  function workflowTableView() {
    const slots = comparisonSlotElements.slice(0, Number(comparisonCount.value))
    const columns = [{ id: 'workflow-step', name: 'Workflow item' }, ...slots.map(item => ({ id: 'set-' + item.slot, name: 'Set ' + item.slot }))]
    const rows = currentFields.map((field, index) => ({ id: field.name, cells: [`Step ${index + 1} · ${field.label}${field.unit ? ' · ' + field.unit : ''}`,
      ...slots.map(item => {
        const count = item.evidence.filter(row => row.claim_kind === field.name).length
        return formatClaim(field, item.claims[field.name]) + (count ? ` · ${count} evidence ${count === 1 ? 'entry' : 'entries'}` : '')
      })] }))
    return { columns, rows, layout: 'multiDimensional', orientation: workflowOrientation,
      ariaLabel: 'SME E2E workflow claims and evidence Multi-dimensional Table', selectedRowId: selectedWorkflowField ?? undefined,
      onActivateRow: fieldId => { selectedWorkflowField = fieldId; renderWorkflowEditor(); workflowStatus.textContent = 'Editing ' + lineLabel(fieldId) + '. Values stay on this device.'; void renderWorkflowTable() },
      onOrientationChange: orientation => {
        workflowOrientation = orientation; workflowTableRegion.dataset.orientation = orientation
        workflowTableRegion.setAttribute('aria-label', orientation === 'rows'
          ? 'SME E2E workflow; claim items are rows and active sets are columns.' : 'SME E2E workflow pivoted to active sets as rows.')
        void renderWorkflowTable()
      } }
  }
  async function renderWorkflowTable() {
    if (!await renderSharedTable(workflowTableHost, workflowTableView(), workflowTableMount))
      workflowStatus.textContent = 'Shared workflow table unavailable. Reload this page to retry.'
  }
  function renderWorkflowEditor() {
    const field = currentFields.find(row => row.name === selectedWorkflowField)
    workflowEditor.hidden = !field
    claimInputs.replaceChildren(); evidenceEditor.replaceChildren()
    if (!field) return
    $('#sme-workflow-editor-heading').textContent = 'Edit · ' + field.label
    $('#sme-workflow-editor-note').textContent = 'Enter one value per active set. Blank stays unknown; values stay in this tab and evidence is not authenticated.'
    $('#sme-workflow-parameter-details').replaceChildren(fieldGuidance(field))
    for (const item of comparisonSlotElements.slice(0, Number(comparisonCount.value))) {
      const prefix = 'compare-' + item.slot.toLowerCase(), fieldset = node('fieldset', undefined, 'workflow-edit-set')
      fieldset.append(node('legend', 'Set ' + item.slot))
      const control = inputControl(field, prefix); fieldset.append(control); writeValue(field, prefix, item.claims[field.name], fieldset)
      for (const input of fieldset.querySelectorAll('input, select')) input.addEventListener(input instanceof HTMLSelectElement ? 'change' : 'input', () => {
        const value = readValue(field, prefix)
        if (value === undefined) delete item.claims[field.name]; else item.claims[field.name] = value
        invalidateComparison()
      })
      claimInputs.append(fieldset)
    }
    if (!field.retiring_tier) { evidenceEditor.append(node('p', 'No evidence tier is defined for this workflow item.', 'muted')); return }
    const setField = node('section', undefined, 'field'), setLabel = node('label', 'Evidence set'), setSelect = node('select')
    setSelect.id = 'sme-evidence-set'; setLabel.htmlFor = setSelect.id
    for (const item of comparisonSlotElements.slice(0, Number(comparisonCount.value))) option(setSelect, item.slot, 'Set ' + item.slot)
    setField.append(setLabel, setSelect)
    const provenance = node('select'); provenance.id = 'sme-evidence-provenance'; option(provenance, '', 'Evidence source…')
    for (const row of provenanceValues) option(provenance, row[0], row[1])
    const role = node('select'); role.id = 'sme-evidence-role'; option(role, '', 'Observer role…')
    for (const name of ['buyer', 'adviser', 'field_checker']) option(role, name, name.replaceAll('_', ' '))
    const date = node('input'); date.type = 'date'; date.id = 'sme-evidence-date'
    const metadata = node('div', undefined, 'evidence-fields')
    for (const [control, labelText] of [[provenance, 'Provenance'], [role, 'Observer'], [date, 'Date']]) {
      const fieldWrap = node('section', undefined, 'field'), label = node('label', labelText)
      label.htmlFor = control.id; fieldWrap.append(label, control); metadata.append(fieldWrap)
    }
    const valuePrefix = 'compare-evidence', valueControl = inputControl(field, valuePrefix)
    const list = node('ul', undefined, 'sme-evidence-list'), add = node('button', 'Add evidence'); add.type = 'button'; add.id = 'sme-evidence-add'
    const renderEvidenceRows = () => {
      list.replaceChildren()
      const item = comparisonSlotElements.find(row => row.slot === setSelect.value)
      item?.evidence.forEach((row, index) => {
        if (row.claim_kind !== field.name) return
        const entry = node('li', `${formatClaim(field, row.value)} · ${row.provenance.replaceAll('_', ' ')} · ${row.observer_role.replaceAll('_', ' ')} · ${row.date}`)
        const remove = node('button', 'Remove'); remove.type = 'button'
        remove.addEventListener('click', () => { item.evidence.splice(index, 1); invalidateComparison(); renderWorkflowEditor() })
        entry.append(remove); list.append(entry)
      })
    }
    setSelect.addEventListener('change', renderEvidenceRows)
    add.addEventListener('click', () => {
      const item = comparisonSlotElements.find(row => row.slot === setSelect.value), value = readValue(field, valuePrefix)
      if (!item || value === undefined || !provenance.value || !role.value || !date.value || item.evidence.length >= 40) {
        workflowStatus.textContent = item?.evidence.length >= 40 ? 'A set can include at most 40 evidence entries.'
          : 'Choose a value, provenance, observer and date before adding evidence.'; return
      }
      item.evidence.push({ claim_kind: field.name, value, provenance: provenance.value, observer_role: role.value, date: date.value })
      invalidateComparison(); renderWorkflowEditor()
    })
    evidenceEditor.append(setField, metadata, valueControl, add, list); renderEvidenceRows()
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
    selectedWorkflowField = currentFields[0]?.name ?? null
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
    resultStatus.textContent = 'Worksheet imported in this tab. Run a new check to recompute.'
  }
  async function refreshFields(packId = packSelect.value) {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packId })
    if (packId !== packSelect.value) return false
    currentProtocol = protocol
    currentFields = currentProtocol.claim_kinds
    if (!currentFields.some(field => field.name === selectedWorkflowField)) selectedWorkflowField = null
    serviceStatus.textContent = `${currentProtocol.pack.country} · ${currentProtocol.pack.currency} · v${currentProtocol.pack.version} · ${currentProtocol.pack.review_status}`
    return true
  }
  function updateComparisonSlotVisibility() {
    const count = Number(comparisonCount.value)
    for (const [index, item] of comparisonSlotElements.entries()) {
      if (index >= count) { item.claims = {}; item.evidence.length = 0 }
    }
    renderWorkflowEditor()
    compareButton.textContent = count === 1 ? 'Run local check' : `Compare ${count} sets locally`
  }
  function invalidateComparison() {
    const generation = ++comparisonGeneration
    comparisonPending = false; compareButton.disabled = false
    tableMessage = null
    resultStatus.textContent = 'Inputs changed. Run a local check to refresh the results table.'
    workflowStatus.textContent = 'Input values are shown in the workflow table. They remain on this device.'
    void renderWorkflowTable()
    void renderComparison(null, generation)
  }
  function clearComparison() {
    tableMessage = null; comparisonCount.value = '1'
    for (const item of comparisonSlotElements) {
      item.claims = {}; item.evidence.length = 0
    }
    selectedWorkflowField = null; renderWorkflowEditor()
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
  async function renderComparison(value, generation) {
    const ok = await renderSharedTable(tableHost, tableView(value), resultTableMount, () => generation === comparisonGeneration)
    if (!ok && generation === comparisonGeneration) resultStatus.textContent = 'Shared results table unavailable. Reload this page to retry.'
    return ok
  }
  async function runComparison() {
    const count = Number(comparisonCount.value), identity = PACK_INDEX.find(pack => pack.id === packSelect.value)
    if (!identity) { resultStatus.textContent = 'Check refused. The selected pack is unavailable.'; return }
    const claimSets = comparisonSlotElements.slice(0, count).map(item => ({ pack_id: identity.id, pack_version: identity.version,
      currency: identity.currency, claims: readClaims(item), ...(item.evidence.length ? { evidence: item.evidence } : {}) }))
    const generation = ++comparisonGeneration
    comparisonPending = true; compareButton.disabled = true; tableMessage = null
    resultStatus.textContent = count === 1 ? 'Checking locally…' : 'Comparing locally…'
    let deadline, timedOut = false
    try {
      const pending = count === 1 ? runPlan(comparisonSlotElements[0])
        .then(report => ({ schema: 'sme-business-pack/table-report/v1', pack: currentProtocol.pack,
          slots: [{ slot: 'A', status: 'included', report }], persisted: false, inference_tokens: 0 }))
        : invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: claimSets })
      const value = await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = true; reject(Error('sme_pack_comparison_deadline')) }, 2000) })])
      if (generation !== comparisonGeneration || document.body.dataset.workspaceRole !== 'sme') return
      if (!await renderComparison(value, generation)) throw Error('shared_table_unavailable')
      resultStatus.textContent = count === 1 ? 'On-device calculation · inputs and reports are not saved or sent' : 'Local comparison · inputs and reports are not saved or sent'
    } catch {
      if (generation === comparisonGeneration && document.body.dataset.workspaceRole === 'sme') {
        resultStatus.textContent = timedOut ? 'Check exceeded 2 seconds; no report was kept.' : 'Check refused. Review closed inputs and the shared pack identity.'
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
  const syncOrientation = () => {
    tableRegion.dataset.orientation = tableOrientation
    tableRegion.setAttribute('aria-label', tableOrientation === 'columns'
      ? 'SME calculated results; options and cash, lease, evidence and next-check dimensions.'
      : 'SME calculated results pivoted to dimensions as records.')
  }
  syncOrientation()
  workflowTableRegion.setAttribute('aria-label', 'SME E2E workflow; claim items are rows and active sets are columns.')
  void renderWorkflowTable()
  void renderComparison(null, comparisonGeneration)
  comparisonCount.addEventListener('change', () => { updateComparisonSlotVisibility(); invalidateComparison() })
  packSelect.addEventListener('change', async () => {
    const generation = ++packGeneration
    clearComparison()
    if (await refreshFields(packSelect.value) && generation === packGeneration) {
      renderWorkflowEditor(); void renderWorkflowTable(); void renderComparison(null, comparisonGeneration)
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
      if (!await renderComparison(null, generation)) return
      resultStatus.textContent = value.available ? 'Checklist is shown in the same table.' : `Checklist unavailable: ${tableMessage}`
    }
    catch { if (generation === comparisonGeneration) resultStatus.textContent = 'Checklist request refused.' }
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
    item.evidence.length = 0; selectedWorkflowField = currentFields.find(field => field.name === 'price')?.name ?? currentFields[0]?.name
    renderWorkflowEditor(); invalidateComparison()
    resultStatus.textContent = 'Sample values are illustrative buyer inputs and remain in this tab.'
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
      resultStatus.textContent = 'Print view opened. Use the browser dialog to print or save locally.'
    } catch (error) {
      sheet?.remove(); document.body.classList.remove('sme-printing')
      resultStatus.dataset.printError = error instanceof Error ? error.message : 'unknown'
      resultStatus.textContent = 'Print worksheet refused. Review the entered values.'
    }
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
    if ('scrollRestoration' in history) {
      previousScrollRestoration = history.scrollRestoration
      history.scrollRestoration = 'manual'
    }
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
      if (active && !controller.signal.aborted) $('#webmcp-status').textContent = 'Seven optional Singapore browser tools registered.'
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
    const targetId = section === 'sme-compare' ? 'sme-workflow' : section
    const activeHash = targetId === 'sme-report' ? '#sme-report' : '#sme-workflow'
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
