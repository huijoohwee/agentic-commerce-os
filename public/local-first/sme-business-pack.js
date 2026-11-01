import { invokeSmePackTool, PACK_INDEX, TOOL_SCHEMAS } from './sme-business-pack-core.js'
import { getOrCreateSingleton } from './workspace-singleton.js'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./sme-business-pack.css?v=sme-cash-to-close-compare-print-2', import.meta.url).href
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
  let currentFields = [], evidenceRows = [], registration, active = false, previousScrollRestoration = null,
    comparisonGeneration = 0, comparisonPending = false, lastResultKind = null
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element }
  const option = (select, value, label) => { const item = node('option', label); item.value = value; select.append(item) }
  const inputControl = (field, prefix) => {
    const wrap = node('section', undefined, 'field')
    const label = node('label', field.label + (field.unit ? ' · ' + field.unit : ''))
    const id = prefix + '-' + field.name
    if (field.type === 'enum' || field.type === 'boolean') {
      const control = node('select'); control.id = id; control.dataset.claim = field.name; control.autocomplete = 'off'
      option(control, '', 'Choose…')
      const values = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.values.map(value => [value, value.replaceAll('_', ' ')])
      for (const value of values) option(control, value[0], value[1])
      label.htmlFor = id; wrap.append(label, control); return wrap
    }
    if (field.type === 'money') {
      const range = node('div', undefined, 'cash-range-input')
      for (const bound of ['low', 'high']) {
        const control = node('input'); control.type = 'number'; control.min = '0'; control.max = '100000000'; control.step = '1'
        control.inputMode = 'numeric'; control.autocomplete = 'off'
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
    const id = prefix + '-' + field.name, raw = (field.type === 'money' ? $('#' + id + '-low') : $('#' + id))?.value
    if (field.type === 'enum' || field.type === 'boolean') return raw === '' || raw === undefined ? undefined : field.type === 'boolean' ? raw === 'true' : raw
    if (field.type === 'money') { const highText = $('#' + id + '-high')?.value; if (raw === '' || raw === undefined) return undefined; const low = Number(raw), high = highText === '' ? low : Number(highText); return highText === '' ? low : { low, high } }
    return raw === '' || raw === undefined ? undefined : Number(raw)
  }
  const readClaims = () => Object.fromEntries(currentFields.map(field => [field.name, readValue(field, 'claim')]).filter(([, value]) => value !== undefined))
  const formatMoney = value => new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency: 'SGD', maximumFractionDigits: 0 }).format(value)
  const lineLabel = id => currentFields.find(field => field.name === id)?.label || id.replaceAll('_', ' ')
  function download(name, mime, content) { const url = URL.createObjectURL(new Blob([content], { type: mime })); const anchor = node('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
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
  const printButton = node('button', 'Print worksheet', 'secondary'); printButton.type = 'button'
  worksheetActions.append(printButton)
  for (const [format, title] of [['json', 'Download JSON'], ['csv', 'Download CSV'], ['markdown', 'Download Markdown']]) {
    const button = node('button', title, 'secondary'); button.type = 'button'; button.dataset.export = format; worksheetActions.append(button)
  }
  const importLabel = node('label', 'Import worksheet', 'button secondary'); importLabel.htmlFor = 'sme-worksheet-import'
  const importInput = node('input'); importInput.type = 'file'; importInput.id = 'sme-worksheet-import'
  importInput.accept = '.json,.csv,.md,.markdown,application/json,text/csv,text/markdown'; importInput.className = 'file-input'
  worksheetActions.append(importLabel, importInput); worksheetSection.append(worksheetActions)
  const comparisonSection = node('section', undefined, 'sme-comparison')
  comparisonSection.id = 'sme-compare'
  comparisonSection.append(node('h3', 'Anonymous claim comparison'), node('p',
    'Enter two or three closed Singapore claim sets. Slots stay in entry order; no winner or ranking is produced.', 'muted'))
  const comparisonCountLabel = node('label', 'Number of claim sets'); comparisonCountLabel.htmlFor = 'sme-compare-count'
  const comparisonCount = node('select'); comparisonCount.id = 'sme-compare-count'
  option(comparisonCount, '2', '2 claim sets'); option(comparisonCount, '3', '3 claim sets')
  const comparisonSlots = node('div', undefined, 'comparison-input-slots'), comparisonSlotElements = []
  for (const slot of ['A', 'B', 'C']) {
    const fieldset = node('fieldset', undefined, 'comparison-input-slot'), fields = node('div', undefined, 'fields')
    fieldset.append(node('legend', 'Set ' + slot), fields); comparisonSlots.append(fieldset)
    comparisonSlotElements.push({ slot, fieldset, fields, evidence: [] })
  }
  const compareButton = node('button', 'Compare claim sets'); compareButton.type = 'button'; compareButton.id = 'sme-compare-run'
  const comparisonActions = node('div', undefined, 'actions'); comparisonActions.append(compareButton)
  comparisonSection.append(comparisonCountLabel, comparisonCount, comparisonSlots, comparisonActions)
  const actions = $('.actions')
  form.insertBefore(evidenceSection, actions); form.insertBefore(worksheetSection, actions); form.insertBefore(comparisonSection, actions)
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
    const arithmetic = node('section', undefined, 'report-section'); arithmetic.append(node('h3', 'Arithmetic observations'))
    arithmetic.append(node('p', arithmeticText(budget.budget.arithmetic_flags), 'report-note')); resultSummary.append(arithmetic)
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
  function show(value, source) { resultElement.textContent = JSON.stringify(value, null, 2); renderResult(value); rawReport.hidden = false; resultStatus.textContent = source; lastResultKind = 'check' }
  async function runPlan() { return invokeSmePackTool('takeover.plan', { pack_id: packSelect.value, claims: readClaims(), evidence: evidenceRows }) }
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
  function updateComparisonSlotVisibility() {
    const count = Number(comparisonCount.value)
    for (const [index, item] of comparisonSlotElements.entries()) {
      item.fieldset.hidden = index >= count
      for (const control of item.fieldset.querySelectorAll('input, select')) {
        control.disabled = index >= count
        if (index >= count) control.value = ''
      }
      if (index >= count) { item.evidence.length = 0; item.evidenceList?.replaceChildren() }
    }
  }
  function clearDisplayedResult(message) {
    resultElement.textContent = ''; rawReport.hidden = true; resultStatus.textContent = ''
    resultSummary.replaceChildren(node('p', message, 'muted')); lastResultKind = null
  }
  function invalidateComparison() {
    comparisonGeneration++
    const clearResult = lastResultKind === 'comparison' || comparisonPending
    comparisonPending = false; compareButton.disabled = false
    if (!clearResult) return
    clearDisplayedResult('Run a local check or comparison to see a report.')
  }
  function clearComparison() {
    invalidateComparison(); comparisonCount.value = '2'; updateComparisonSlotVisibility()
    for (const item of comparisonSlotElements) {
      item.evidence.length = 0; item.evidenceList?.replaceChildren()
      for (const control of item.fieldset.querySelectorAll('input, select')) control.value = ''
    }
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
  function addComparisonEvidenceEditor(item) {
    const prefix = 'compare-evidence-' + item.slot.toLowerCase(), details = node('details', undefined, 'comparison-evidence')
    details.id = prefix + '-details'; details.append(node('summary', 'Evidence for set ' + item.slot))
    const controls = node('div', undefined, 'evidence-fields'), kind = node('select'), provenance = node('select')
    const role = node('select'), date = node('input'), value = node('div'), list = node('ul')
    kind.id = prefix + '-kind'; provenance.id = prefix + '-provenance'; role.id = prefix + '-role'
    date.id = prefix + '-date'; date.type = 'date'; value.id = prefix + '-value'; list.id = prefix + '-list'
    option(kind, '', 'Claim kind…'); for (const field of currentFields.filter(row => row.retiring_tier)) option(kind, field.name, field.label)
    option(provenance, '', 'Evidence source…'); for (const row of provenanceValues) option(provenance, row[0], row[1])
    option(role, '', 'Observer role…'); for (const name of ['buyer', 'adviser', 'field_checker']) option(role, name, name.replaceAll('_', ' '))
    for (const [control, label] of [[kind, 'Claim kind'], [provenance, 'Provenance'], [role, 'Observer'], [date, 'Date']]) {
      const field = node('section', undefined, 'field'), caption = node('label', label)
      caption.htmlFor = control.id; field.append(caption, control); controls.append(field)
    }
    const renderValue = () => {
      value.replaceChildren()
      const field = currentFields.find(row => row.name === kind.value)
      if (field) {
        value.append(inputControl(field, prefix))
        for (const control of value.querySelectorAll('input, select')) control.addEventListener('input', invalidateComparison)
      }
    }
    const renderRows = () => {
      list.replaceChildren()
      item.evidence.forEach((row, index) => {
        const entry = node('li', lineLabel(row.claim_kind) + ' · ' + JSON.stringify(row.value) + ' · ' + row.provenance.replaceAll('_', ' ') + ' · ' + row.date)
        const remove = node('button', 'Remove'); remove.type = 'button'
        remove.addEventListener('click', () => { item.evidence.splice(index, 1); renderRows(); invalidateComparison() })
        entry.append(remove); list.append(entry)
      })
    }
    const add = node('button', 'Add evidence'); add.type = 'button'; add.id = prefix + '-add'
    add.addEventListener('click', () => {
      const field = currentFields.find(row => row.name === kind.value), observed = field && readValue(field, prefix)
      if (!field || observed === undefined || !provenance.value || !role.value || !date.value || item.evidence.length >= 40) {
        resultStatus.textContent = item.evidence.length >= 40 ? 'A set can include at most 40 evidence entries.'
          : 'Choose a claim, value, provenance, observer and date.'; return
      }
      item.evidence.push({ claim_kind: field.name, value: observed, provenance: provenance.value, observer_role: role.value, date: date.value })
      renderRows(); invalidateComparison(); value.replaceChildren(); kind.value = ''; provenance.value = ''; role.value = ''; date.value = ''
    })
    kind.addEventListener('change', renderValue)
    for (const control of [kind, provenance, role, date]) control.addEventListener('input', invalidateComparison)
    item.evidenceList = list
    details.append(controls, value, add, list); item.fieldset.append(details)
  }
  function renderComparison(value) {
    resultSummary.replaceChildren()
    const context = node('div', undefined, 'report-context')
    context.append(node('span', 'Singapore · ' + value.pack.currency, 'report-pill'),
      node('span', 'Pack v' + value.pack.version, 'report-pill'), node('span', 'As of ' + value.pack.as_of, 'report-pill'),
      node('span', 'No winner reported', 'report-pill quiet'))
    resultSummary.append(context)
    for (const slot of value.slots) {
      const card = node('section', undefined, 'report-section comparison-card')
      card.append(node('h3', 'Slot ' + slot.slot))
      if (!slot.report) { card.append(node('p', 'Not supplied.', 'report-note')); resultSummary.append(card); continue }
      const budget = slot.report.budget.budget, missing = slot.report.check.completeness.missing_claims
      const tiers = slot.report.check.claim_counts_by_tier
      const runway = budget.opening_runway
      const runwayText = runway?.months ? runway.months.low + '–' + runway.months.high + ' months'
        : runway?.status === 'no_monthly_shortfall' ? 'No monthly shortfall indicated'
          : runway?.status ? 'Unknown · ' + runway.status.replaceAll('_', ' ') : 'Unknown · incomplete'
      const rows = [
        ['Cash to close', formatComparisonRange(budget.cash_to_close)],
        ['Gap above asking price', formatComparisonRange(budget.gap_above_asking_price)],
        ['Opening runway', runwayText],
        ['Lease exposure', formatComparisonRange(budget.lease_exposure)],
        ['Unchecked share', budget.unchecked_share === null ? 'Unknown · incomplete' : Math.round(budget.unchecked_share * 100) + '%'],
        ['Missing claims', missing.length ? missing.join(', ') : 'None'],
        ['Arithmetic observations', arithmeticText(budget.arithmetic_flags)],
        ...budget.lines.map(line => [line.label, line.complete ? formatComparisonRange(line) : 'Unknown · incomplete']),
      ]
      const list = node('dl', undefined, 'comparison-report-rows')
      for (const [label, answer] of rows) {
        const row = node('div', undefined, 'comparison-report-row'); row.append(node('dt', label), node('dd', answer)); list.append(row)
      }
      card.append(list, node('p', `Claims by tier: T0 ${tiers.T0} · T1 ${tiers.T1} · T2 ${tiers.T2} · T3 ${tiers.T3}`, 'report-note'),
        node('p', slot.report.check.disclaimer, 'report-disclaimer')); resultSummary.append(card)
    }
    resultSummary.append(node('p', 'Indicative, not verified. Sighted evidence is not authenticated; no professional advice is provided.', 'report-disclaimer'))
    resultElement.textContent = JSON.stringify(value, null, 2); rawReport.hidden = false
    resultStatus.textContent = 'Local comparison · inputs and reports are not saved or sent'; lastResultKind = 'comparison'
  }
  async function runComparison() {
    const count = Number(comparisonCount.value), identity = PACK_INDEX.find(pack => pack.id === packSelect.value)
    if (!identity) { resultStatus.textContent = 'Comparison refused. The selected pack is unavailable.'; return }
    const claimSets = comparisonSlotElements.slice(0, count).map(item => {
      const claims = {}
      for (const field of currentFields) {
        const value = readValue(field, 'compare-' + item.slot.toLowerCase())
        if (value !== undefined) claims[field.name] = value
      }
      return { pack_id: identity.id, pack_version: identity.version, currency: identity.currency, claims,
        ...(item.evidence.length ? { evidence: item.evidence } : {}) }
    })
    const generation = ++comparisonGeneration
    comparisonPending = true; compareButton.disabled = true
    clearDisplayedResult('Comparison is running locally. No prior report is shown.')
    resultStatus.textContent = 'Comparing locally…'
    let deadline, timedOut = false
    try {
      const value = await Promise.race([
        invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: claimSets }),
        new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = true; reject(Error('sme_pack_comparison_deadline')) }, 2000) }),
      ])
      if (generation !== comparisonGeneration || document.body.dataset.workspaceRole !== 'sme') return
      renderComparison(value)
    } catch {
      if (generation === comparisonGeneration && document.body.dataset.workspaceRole === 'sme') {
        resultStatus.textContent = timedOut ? 'Comparison exceeded 2 seconds; no report was kept.'
          : 'Comparison refused. Review closed values and the shared pack identity.'
      }
    } finally {
      clearTimeout(deadline)
      if (generation === comparisonGeneration) { comparisonPending = false; compareButton.disabled = false }
    }
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
  for (const item of comparisonSlotElements) {
    item.fields.replaceChildren(...currentFields.map(field => inputControl(field, 'compare-' + item.slot.toLowerCase())))
    for (const control of item.fields.querySelectorAll('input, select')) control.addEventListener('input', invalidateComparison)
    addComparisonEvidenceEditor(item)
  }
  comparisonCount.value = '2'; updateComparisonSlotVisibility()
  comparisonCount.addEventListener('change', () => { invalidateComparison(); updateComparisonSlotVisibility() })
  compareButton.addEventListener('click', () => void runComparison())
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
  printButton.addEventListener('click', async () => {
    let sheet
    try {
      const plan = await runPlan(), worksheet = JSON.parse(plan.worksheet.json)
      if (worksheet.schema !== 'sme-business-pack/worksheet/v1' || worksheet.evidence.length > 40) throw Error('worksheet_evidence_limit')
      sheet = node('article', undefined, 'sme-print-sheet')
      sheet.append(node('h1', 'SME takeover worksheet'), node('p', 'Singapore · SGD · pack v' + plan.pack.version + ' · as of ' + plan.pack.as_of + ' · provisional'))
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
    for (const link of document.querySelectorAll('#sme-navigation .service-nav a')) {
      if (link.hash === '#' + section) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
    if (section === 'sme' || section.startsWith('sme-')) requestAnimationFrame(() => requestAnimationFrame(() => {
      if (location.hash.slice(1).split('?')[0] !== section) return
      const target = section === 'sme' ? root : document.getElementById(section)
      target?.scrollIntoView({ block: 'start' })
    }))
  }
  window.addEventListener('hashchange', updateSectionNavigation)
  window.addEventListener('pagehide', deactivate, { once: true })
  window.addEventListener('pageshow', () => { if (document.body.dataset.workspaceRole === 'sme') void activate() })
  updateSectionNavigation()
  return { activate, deactivate, updateSectionNavigation }
}
