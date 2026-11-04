import { invokeSmePackTool, PACK_INDEX, TOOL_SCHEMAS } from './sme-business-pack-core.js'
import { getOrCreateSingleton } from './workspace-singleton.js'
import { createSmeWorkflowEditor } from './sme-workflow-editor.js'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./sme-business-pack.css?v=business-plan-table-v1', import.meta.url).href
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
  const dictionaryHost = $('#sme-dictionary-table-host'), dictionaryRegion = $('#sme-dictionary-table-region')
  const dictionaryStatus = $('#sme-dictionary-status'), overview = $('#sme-overview'), dictionary = $('#sme-dictionary')
  const workflowEditor = $('#sme-workflow-editor'), inputFields = $('#sme-workflow-inputs')
  const evidenceEditor = $('#sme-workflow-evidence-editor')
  const workflowStatus = $('#workflow-status'), serviceStatus = $('#service-status')
  const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
  let currentFields = [], currentProtocol, registration, active = false, previousScrollRestoration = null,
    comparisonGeneration = 0, packGeneration = 0, comparisonPending = false, tableOrientation = 'rows',
    comparisonValue = null, selectedWorkflowSet = null, selectedEvidenceField = null,
    tableAdapter = null, dictionaryModule = null, dictionaryOrientation = 'rows'
  const comparisonSlotElements = ['A', 'B', 'C'].map(slot => ({ slot, inputs: {}, evidence: [] }))
  const workflowTableMount = { handle: null, ready: null, generation: 0 }
  const dictionaryTableMount = { handle: null, ready: null, generation: 0 }
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element }
  const option = (select, value, label) => { const item = node('option', label); item.value = value; select.append(item) }
  const enumLabel = value => value.replaceAll('_', ' ').replace(/^\w/, letter => letter.toUpperCase())
  const readInputs = item => ({ ...item.inputs })
  const formatMoney = (value, currency) => {
    const amount = new Intl.NumberFormat(document.documentElement.lang || 'en', { maximumFractionDigits: 4 }).format(value)
    return /^[A-Z]{3}$/u.test(currency ?? '') ? `${currency} ${amount}` : amount
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
  function formatFieldValue(field, value, currency) {
    if (value === undefined) return 'Unknown · not entered'
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (typeof value === 'number') return field.type === 'money' ? formatMoney(value, currency) : `${new Intl.NumberFormat().format(value)}${field.unit ? ' ' + field.unit : ''}`
    if (typeof value === 'object' && value !== null && Number.isFinite(value.low) && Number.isFinite(value.high))
      return formatMoney(value.low, currency) + (value.high === value.low ? '' : '–' + formatMoney(value.high, currency))
    return field.type === 'enum' ? enumLabel(value) : String(value)
  }
  const workflowEditorView = createSmeWorkflowEditor({
    workflowEditor, inputFields, evidenceEditor, heading: $('#sme-workflow-editor-heading'), note: $('#sme-workflow-editor-note'),
    evidenceHeading: $('#sme-workflow-evidence-heading'), parameterDetails: $('#sme-workflow-parameter-details'), workflowStatus,
    getFields: () => currentFields, getProtocol: () => currentProtocol,
    getSlots: () => comparisonSlotElements.slice(0, Number(comparisonCount.value)), getSelectedSlot: () => selectedWorkflowSet,
    getEvidenceField: () => selectedEvidenceField, setEvidenceField: value => { selectedEvidenceField = value },
    node, option, enumLabel, formatFieldValue, formatMoney, invalidate: invalidateComparison,
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
    const reportValue = (slot, read) => slot.status === 'not_supplied' ? 'Not in this comparison.' : slot.report ? read(slot.report) : 'Not built · build local plan'
    const evidenceRecords = slot => slot.evidence.length
      ? slot.evidence.map((row, index) => {
        const field = currentFields.find(item => item.name === row.field_key)
        const inputs = comparisonSlotElements.find(item => item.slot === slot.slot)?.inputs
        const value = field ? formatFieldValue(field, row.value, inputs?.currency_code) : JSON.stringify(row.value)
        return `${index + 1}. ${lineLabel(row.field_key)} · ${value} · ${enumLabel(row.provenance)} · ${enumLabel(row.observer_role)} · ${row.date}`
      }).join(' · ')
      : 'No evidence entries recorded.'
    const modelOutputs = currentProtocol?.model_outputs ?? []
    const dimensions = [
      { id: 'plan-contract', name: 'Plan · contract', read: () => currentProtocol?.pack ? `${currentProtocol.pack.label} · v${currentProtocol.pack.version} · ${currentProtocol.pack.review_status}` : 'Loading plan…' },
      { id: 'plan-completeness', name: 'Plan · required inputs', read: slot => reportValue(slot, report => {
        const status = report.check.completeness, missing = status.required - status.supplied
        return missing ? `Incomplete · ${status.supplied}/${status.required} supplied · ${missing} unknown` : `Entered · ${status.supplied}/${status.required} required fields`
      }) },
      { id: 'data-validation', name: 'Plan · invalid entries', read: slot => reportValue(slot, report =>
        report.check.completeness.invalid_fields.length
          ? report.check.completeness.invalid_fields.map(lineLabel).join(' · ')
          : 'No invalid entries reported.') },
      { id: 'evidence-records', name: 'Plan · recorded evidence', read: slot => slot.status === 'not_supplied' ? 'Not in this comparison.' : evidenceRecords(slot) },
      { id: 'model-coverage', name: 'Model · calculated outputs', read: slot => reportValue(slot, report => {
        const rows = Object.values(report.model.missing_inputs), complete = rows.filter(values => values.length === 0).length
        return `${complete}/${rows.length} outputs have their required inputs`
      }) },
      ...modelOutputs.map(output => ({ id: `model-${output.id}`, name: `Model · ${output.label}`, read: slot =>
        reportValue(slot, report => report.model_display[output.id]) })),
      { id: 'pitch-deck-outline', name: 'Pitch · deck outline', read: slot => reportValue(slot, report =>
        report.pitch_deck_outline.map(row => `Slide ${row.slide}. ${row.section}: ${row.content}`).join(' · ')) },
      { id: 'next-checks', name: 'Plan · next checks', read: slot => reportValue(slot, report => report.next_checks.length
        ? report.next_checks.map(row => `${row.order}. ${row.action}`).join(' · ') : 'No next checks from the entered fields.') },
    ]
    return dimensions
  }
  function workflowTableView() {
    const slots = comparisonSlotElements.slice(0, Number(comparisonCount.value))
    const resultSlots = tableSlots(comparisonValue)
    const dimensions = tableDimensions()
    const columns = [{ id: 'scenario', name: 'Plan scenario' }, ...currentFields.map(field => ({ id: field.name, name: 'Input · ' + field.label + (field.unit ? ' · ' + field.unit : '') })),
      ...dimensions.map(({ id, name }) => ({ id, name }))]
    const rows = slots.map(item => ({ id: item.slot, cells: [`Scenario ${item.slot}`,
      ...currentFields.map(field => {
        const count = item.evidence.filter(row => row.field_key === field.name).length
        return formatFieldValue(field, item.inputs[field.name], item.inputs.currency_code) + (count ? ` · ${count} evidence ${count === 1 ? 'entry' : 'entries'}` : '')
      }), ...dimensions.map(dimension => dimension.read(resultSlots.find(slot => slot.slot === item.slot)))] }))
    return { columns, rows, layout: 'multiDimensional', orientation: tableOrientation,
      ariaLabel: 'SME business plan; scenarios are rows and every plan field, evidence record, model output and next check is a column.', selectedRowId: selectedWorkflowSet ?? undefined,
      onActivateRow: slot => {
        if (!slots.some(item => item.slot === slot)) return
        selectedWorkflowSet = slot; renderWorkflowEditor()
        workflowStatus.textContent = `Editing Scenario ${slot}. Values and evidence stay on this device.`
        void renderWorkflowTable()
      }, onOrientationChange: orientation => {
        if (!workflowTableHost.isConnected) return
        tableOrientation = orientation
        workflowTableRegion.dataset.orientation = orientation
        workflowTableRegion.setAttribute('aria-label', orientation === 'rows'
          ? 'Plan scenarios as rows; all plan fields, evidence, model outputs and next checks as columns.'
          : 'The same business plan pivoted to fields and outputs as records.')
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
    return invokeSmePackTool('business.plan.build', { pack_id: packSelect.value, inputs: readInputs(item), evidence: item.evidence })
  }
  async function fillWorksheet(worksheet) {
    if (worksheet?.schema !== 'sme-business-plan/worksheet/v1' || worksheet.pack_id !== packSelect.value
      || worksheet.pack_version !== currentProtocol.pack.version
      || !worksheet.inputs || typeof worksheet.inputs !== 'object' || !Array.isArray(worksheet.evidence)) throw Error('worksheet_invalid')
    const candidate = { pack_id: worksheet.pack_id, inputs: worksheet.inputs, evidence: worksheet.evidence }
    await invokeSmePackTool('business.plan.build', candidate)
    const item = comparisonSlotElements[0]
    item.inputs = { ...worksheet.inputs }
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
    const worksheet = { schema: 'sme-business-plan/worksheet/v1', pack_id: packSelect.value, pack_version: currentProtocol.pack.version, inputs: {}, evidence: [] }
    for (const [kind, key, value, provenance, observer_role, date] of rows.slice(1)) {
      if (kind === 'input') worksheet.inputs[key] = JSON.parse(value)
      else if (kind === 'evidence') worksheet.evidence.push({ field_key: key, value: JSON.parse(value), provenance, observer_role, date })
      else throw Error('worksheet_csv_invalid')
    }
    return worksheet
  }
  async function importWorksheet(file) {
    const text = await file.text(), suffix = file.name.split('.').pop().toLowerCase()
    let worksheet
    if (suffix === 'md' || suffix === 'markdown') {
      const fence = '~~~json'
      const start = text.indexOf(fence), end = start < 0 ? -1 : text.indexOf('~~~', start + fence.length)
      if (start < 0 || end < 0) throw Error('worksheet_markdown_invalid')
      worksheet = JSON.parse(text.slice(start + fence.length, end).trim())
    } else if (suffix === 'csv') worksheet = parseCsv(text)
    else worksheet = JSON.parse(text)
    await fillWorksheet(worksheet)
    workflowStatus.textContent = 'Worksheet imported in this tab. Build the plan to refresh model and readiness columns.'
  }
  async function refreshFields(packId = packSelect.value) {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packId })
    if (packId !== packSelect.value) return false
    currentProtocol = protocol
    currentFields = currentProtocol.input_fields
    serviceStatus.textContent = `${currentProtocol.pack.label} · v${currentProtocol.pack.version} · ${currentProtocol.pack.review_status} · local protocol`
    if (location.hash.slice(1).split('?')[0] === 'sme-dictionary') void renderDictionaryTable()
    return true
  }
  function updateComparisonSlotVisibility() {
    const count = Number(comparisonCount.value)
    for (const [index, item] of comparisonSlotElements.entries()) {
      if (index >= count) { item.inputs = {}; item.evidence.length = 0 }
    }
    if (selectedWorkflowSet && !comparisonSlotElements.slice(0, count).some(item => item.slot === selectedWorkflowSet)) selectedWorkflowSet = 'A'
    renderWorkflowEditor()
    compareButton.textContent = count === 1 ? 'Build local plan' : `Compare ${count} scenarios locally`
  }
  function invalidateComparison() {
    ++comparisonGeneration
    comparisonPending = false; compareButton.disabled = false
    comparisonValue = null
    workflowStatus.textContent = 'Inputs changed. Build the local plan to refresh model and readiness columns.'
    void renderWorkflowTable()
  }
  function clearComparison() {
    comparisonCount.value = '1'
    for (const item of comparisonSlotElements) {
      item.inputs = {}; item.evidence.length = 0
    }
    selectedWorkflowSet = null; renderWorkflowEditor()
    updateComparisonSlotVisibility(); invalidateComparison()
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
  async function renderDictionaryTable() {
    if (!currentProtocol || !dictionaryHost?.isConnected) return
    try {
      dictionaryModule ??= await import('./sme-pack-dictionary.js?v=business-plan-dictionary-v1')
      const view = dictionaryModule.createSmePackDictionaryView(currentProtocol, dictionaryOrientation, orientation => {
        if (!dictionaryHost.isConnected) return
        dictionaryOrientation = orientation
        dictionaryRegion.dataset.orientation = orientation
        dictionaryRegion.setAttribute('aria-label', orientation === 'rows'
          ? 'Protocol records as rows; definitions and canonical owners as columns.'
          : 'The same dictionary pivoted to definitions as records.')
        void renderDictionaryTable()
      }, TOOL_SCHEMAS)
      if (await renderSharedTable(dictionaryHost, view, dictionaryTableMount,
        () => location.hash.slice(1).split('?')[0] === 'sme-dictionary')) {
        dictionaryStatus.textContent = `${currentProtocol.pack.label} · v${currentProtocol.pack.version} · ${view.rows.length} read-only schema and owner records`
      }
    } catch {
      dictionaryStatus.textContent = 'Dictionary unavailable. The active pack protocol could not be rendered.'
    }
  }
  async function runComparison() {
    const count = Number(comparisonCount.value), identity = PACK_INDEX.find(pack => pack.id === packSelect.value)
    if (!identity) { workflowStatus.textContent = 'Check refused. The selected pack is unavailable.'; return }
    const planSets = comparisonSlotElements.slice(0, count).map(item => ({ pack_id: identity.id, pack_version: identity.version,
      inputs: readInputs(item), ...(item.evidence.length ? { evidence: item.evidence } : {}) }))
    const generation = ++comparisonGeneration
    comparisonPending = true; compareButton.disabled = true; comparisonValue = null
    workflowStatus.textContent = count === 1 ? 'Building plan locally…' : 'Comparing scenarios locally…'
    void renderWorkflowTable()
    let deadline, timedOut = false
    try {
      const pending = count === 1 ? runPlan(comparisonSlotElements[0])
        .then(report => ({ schema: 'sme-business-plan/comparison/v1', pack: currentProtocol.pack,
          slots: [{ slot: 'A', status: 'included', report }], persisted: false, inference_tokens: 0 }))
        : invokeSmePackTool('business.plan.compare', { plan_sets: planSets })
      const value = await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = true; reject(Error('sme_pack_comparison_deadline')) }, 2000) })])
      if (generation !== comparisonGeneration || document.body.dataset.workspaceRole !== 'sme') return
      comparisonValue = value
      if (!await renderWorkflowTable()) throw Error('shared_table_unavailable')
      workflowStatus.textContent = count === 1 ? 'Local plan built · inputs and report stay in this tab' : 'Local scenario comparison · inputs and reports stay in this tab'
    } catch {
      if (generation === comparisonGeneration && document.body.dataset.workspaceRole === 'sme') {
        comparisonValue = null; void renderWorkflowTable()
        workflowStatus.textContent = timedOut ? 'Plan exceeded 2 seconds; no report was kept.' : 'Plan refused. Review entered values and the shared protocol.'
      }
    } finally {
      clearTimeout(deadline)
      if (generation === comparisonGeneration) { comparisonPending = false; compareButton.disabled = false }
    }
  }
  for (const pack of PACK_INDEX) option(packSelect, pack.id, `${pack.label} · v${pack.version} · ${pack.review_status}`)
  packSelect.value = PACK_INDEX[0].id
  $('#sample').textContent = 'Load illustrative inputs'
  runtimeMode.textContent = 'BUSINESS PLAN · LOCAL WORKSPACE'
  runtimeStatus.textContent = 'Local computation ready. No service request is needed.'
  $('#mcp-url').textContent = new URL('services/sme-business-pack/mcp', document.baseURI).href
  $('#webmcp-status').textContent = 'Browser tools are optional; local checks work without a network.'
  await refreshFields()
  comparisonCount.value = '1'; updateComparisonSlotVisibility()
  workflowTableRegion.setAttribute('aria-label', 'Plan scenarios as rows; all pitch, financial, evidence, model and readiness fields as columns.')
  void renderWorkflowTable()
  comparisonCount.addEventListener('change', () => { updateComparisonSlotVisibility(); invalidateComparison() })
  packSelect.addEventListener('change', async () => {
    const generation = ++packGeneration
    clearComparison()
    if (await refreshFields(packSelect.value) && generation === packGeneration) {
      renderWorkflowEditor(); void renderWorkflowTable()
      if (location.hash.slice(1).split('?')[0] === 'sme-dictionary') void renderDictionaryTable()
    }
  })
  form.addEventListener('submit', event => { event.preventDefault(); void runComparison() })
  $('#sample').addEventListener('click', () => {
    const sample = {
      venture_name: 'Illustrative project', venture_stage: 'validation', currency_code: 'USD',
      problem_statement: 'A defined user group has a recurring task that takes time to complete.',
      target_customer: 'A specific group the team can reach for interviews and trials.',
      solution_offer: 'A simple service that helps users complete the task.',
      business_model: 'A user-selected price per completed service.', go_to_market: 'Direct interviews and a small opt-in trial.',
      key_risks: 'Demand, delivery effort, and repeat use are unverified.', milestones: 'Interview users, run a trial, review costs.',
      price_per_unit: 20, units_per_month: 300, variable_cost_per_unit: 4, fixed_costs_per_month: 1800,
      payroll_per_month: 2500, setup_costs: 1200, cash_available: 5000, runway_target_months: 4, funding_requested: 4000,
    }
    comparisonCount.value = '1'; updateComparisonSlotVisibility()
    const item = comparisonSlotElements[0]; item.inputs = {}
    for (const field of currentFields) {
      const value = sample[field.name]
      if (value === undefined) continue
      item.inputs[field.name] = value
    }
    item.evidence.length = 0; selectedWorkflowSet = 'A'; selectedEvidenceField = currentProtocol.protocols[0]?.field_key ?? currentFields[0]?.name ?? null
    renderWorkflowEditor(); invalidateComparison()
    workflowStatus.textContent = 'Illustrative values only; they are not market data and remain in this tab.'
  })
  for (const button of worksheetActions.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
    try {
      const plan = await runPlan(), format = button.dataset.export
      const suffix = format === 'markdown' ? 'md' : format
      const content = plan.worksheet[format]
      if (typeof content !== 'string') throw Error('worksheet_format_missing')
      download('business-plan-worksheet.' + suffix, format === 'json' ? 'application/json'
        : format === 'csv' ? 'text/csv' : 'text/markdown', content)
      workflowStatus.textContent = 'Worksheet downloaded locally. No report was uploaded.'
    } catch { workflowStatus.textContent = 'Worksheet export refused. Review the entered values.' }
  })
  printButton.addEventListener('click', async () => {
    let sheet
    try {
      const plan = await runPlan(), worksheet = JSON.parse(plan.worksheet.json)
      if (worksheet.schema !== 'sme-business-plan/worksheet/v1' || worksheet.evidence.length > 40) throw Error('worksheet_evidence_limit')
      sheet = node('article', undefined, 'sme-print-sheet')
      sheet.append(node('h1', worksheet.inputs.venture_name || 'Business plan draft'), node('p', 'Plan contract v' + plan.pack.version + ' · ' + plan.pack.review_status + ' · ' + worksheet.currency_code + ' · ' + plan.as_of))
      const table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody'), addRow = (kind, field, value) => {
        const row = node('tr'); row.append(node('th', kind), node('td', field), node('td', value)); body.append(row)
      }
      for (const label of ['Kind', 'Field', 'User entry / evidence']) header.append(node('th', label))
      head.append(header); table.append(head, body)
      for (const row of plan.pitch_deck_outline) addRow(`Pitch · slide ${row.slide}`, row.section, row.content)
      for (const [key, value] of Object.entries(plan.model_display)) addRow('Model', key.replaceAll('_', ' '), value)
      for (const [key, value] of Object.entries(worksheet.inputs)) addRow('Input', lineLabel(key), JSON.stringify(value))
      for (const row of worksheet.evidence) addRow('Evidence', lineLabel(row.field_key), JSON.stringify(row.value) + ' · ' + row.provenance + ' · ' + row.observer_role + ' · ' + row.date)
      sheet.append(table, node('h2', 'Next checks'))
      const tasks = node('ol')
      for (const task of plan.next_checks) tasks.append(node('li', task.action))
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
    const isDictionary = section === 'sme-dictionary'
    const targetId = ['sme-compare', 'sme-check-form', 'sme-report'].includes(section) ? 'sme-workflow' : section
    overview.hidden = isDictionary
    dictionary.hidden = !isDictionary
    for (const link of document.querySelectorAll('#sme-navigation .service-nav a')) {
      if (link.hash === '#sme-dictionary' && isDictionary || link.hash === '#sme-workflow' && isSmeSection && !isDictionary) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
    if (isDictionary) void renderDictionaryTable()
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
