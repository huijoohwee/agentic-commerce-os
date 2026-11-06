import { invokeSmePackTool, PACK_INDEX, TOOL_SCHEMAS, readSmeWorksheets, serializeSmeWorksheets } from './sme-business-pack-core.js?v=business-plan-contract-v6'
import { getOrCreateSingleton } from './workspace-singleton.js'
import { createSmeWorkflowEditor } from './sme-workflow-editor.js'
import { createSmeReviewWorkflow } from './sme-review-workflow.js'

const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./sme-business-pack.css?v=business-plan-table-v2', import.meta.url).href
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
  const form = $('#sme-check-form'), packSelect = $('#pack-id'), planModeSelect = $('#sme-plan-mode'), comparisonCount = $('#sme-compare-count')
  const comparisonCountLabel = $('#sme-compare-count-label'), planModeDescription = $('#sme-plan-mode-description')
  const workflowTableHost = $('#sme-workflow-table-host'), workflowTableRegion = $('#sme-workflow-table-region'), workflowPivot = $('#sme-workflow-pivot')
  const dictionaryHost = $('#sme-dictionary-table-host'), dictionaryRegion = $('#sme-dictionary-table-region')
  const dictionaryStatus = $('#sme-dictionary-status'), overview = $('#sme-overview'), dictionary = $('#sme-dictionary')
  const workflowEditor = $('#sme-workflow-editor'), inputFields = $('#sme-workflow-inputs')
  const evidenceEditor = $('#sme-workflow-evidence-editor')
  const workflowStatus = $('#workflow-status'), serviceStatus = $('#service-status')
  const runtimeMode = $('#runtime-mode'), runtimeStatus = $('#runtime-status')
  let currentFields = [], currentProtocol, registration, active = false, previousScrollRestoration = null,
    comparisonGeneration = 0, workflowGeneration = 0, packGeneration = 0, importGeneration = 0, comparisonPending = false, tableOrientation = 'rows',
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
  const currentMode = () => currentProtocol?.plan_modes?.find(mode => mode.id === planModeSelect.value)
  const rowLabel = slot => `${currentMode()?.row_label ?? 'Plan option'} ${slot}`
  const pluralRows = () => currentMode()?.id === 'scenario' ? 'scenarios' : 'plan options'
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
    getMode: currentMode,
    getSlots: () => comparisonSlotElements.slice(0, Number(comparisonCount.value)), getSelectedSlot: () => selectedWorkflowSet,
    getEvidenceField: () => selectedEvidenceField, setEvidenceField: value => { selectedEvidenceField = value },
    node, option, enumLabel, formatFieldValue, formatMoney, invalidate: invalidateComparison,
  })
  function renderWorkflowEditor() { workflowEditorView.render() }
  const review = createSmeReviewWorkflow({ root,
    getState: () => ({ protocol: currentProtocol, mode: currentMode(), slots: comparisonSlotElements.slice(0, Number(comparisonCount.value)), format: formatFieldValue }),
    createTableView: () => workflowTableView(true),
    renderTable: (view, current) => renderSharedTable(workflowTableHost, view, workflowTableMount, current),
    focusField: (slot, key) => { selectedWorkflowSet = slot; renderWorkflowEditor(); const control = inputFields.querySelector(`[data-input="${key}"]`); control?.focus({ preventScroll: true }) },
    onViewChange: () => { void renderWorkflowTable() },
  })
  function tableSlots(value) {
    const supplied = new Map((value?.slots ?? []).map(slot => [slot.slot, slot]))
    return comparisonSlotElements.map((item, index) => {
      const slot = supplied.get(item.slot), visible = index < Number(comparisonCount.value)
      return { ...slot, slot: item.slot, status: slot?.status ?? (visible ? 'ready' : 'not_supplied'), report: slot?.report ?? null, evidence: item.evidence }
    })
  }
  const tablePathLabel = parts => parts.map(part => String(part ?? '').trim()).filter(Boolean).join(' › ')
  const inputRequirementLabel = field => {
    if (field.required) return 'required'
    if (field.required_when?.field) {
      const trigger = field.required_when
      return `when ${trigger.field}=${String(trigger.equals ?? trigger.value ?? 'true')}`
    }
    if (field.required_modes?.length) {
      const modes = field.required_modes.map(id => currentProtocol?.plan_modes?.find(mode => mode.id === id)?.label ?? id)
      return `required in ${modes.join(', ')}`
    }
    return 'optional'
  }
  const inputTableLabel = field => field.label
  function tableDimensions() {
    const reportValue = (slot, read) => slot.status === 'not_supplied' ? 'Not in this comparison.' : slot.report ? read(slot.report) : 'Not built · build local plan'
    const evidenceValue = (slot, read) => slot.status === 'not_supplied' ? 'Not in this comparison.' : slot.evidence.length
      ? slot.evidence.map(row => {
        const field = currentFields.find(item => item.name === row.field_key)
        const inputs = comparisonSlotElements.find(item => item.slot === slot.slot)?.inputs
        const value = field ? formatFieldValue(field, row.value, inputs?.currency_code) : JSON.stringify(row.value)
        return read(row, field, `${row.field_key} · ${field?.label ?? lineLabel(row.field_key)}: ${value}`)
      }).join(' · ')
      : 'No evidence entries recorded.'
    const modelOutputs = currentProtocol?.model_outputs ?? []
    const coverageOutputs = currentProtocol?.coverage_outputs ?? []
    const workflowColumns = currentProtocol?.workflow_columns ?? []
    const workflowColumn = (id, read) => {
      const column = workflowColumns.find(item => item.id === id)
      const path = {
        'plan-completeness': ['Readiness', 'Input coverage', 'Required inputs'],
        'data-validation': ['Readiness', 'Validation', 'Invalid entries'],
        'evidence-values': ['Evidence', 'Field context', 'Recorded values'],
        'evidence-provenance': ['Evidence', 'Record attributes', 'Provenance'],
        'evidence-observer': ['Evidence', 'Record attributes', 'Observer role'],
        'evidence-date': ['Evidence', 'Record attributes', 'Date'],
        'evidence-status': ['Evidence', 'Record status', 'Authentication state'],
        'model-coverage': ['Readiness', 'Model coverage', 'Calculated outputs'],
        'next-checks': ['Plan', 'Follow-up', 'Next checks'],
      }[id] ?? ['Workflow', 'Protocol field', column?.label ?? id]
      const label = column?.label?.split(' · ').at(-1) ?? path.at(-1)
      return { id, name: `${tablePathLabel([...path.slice(0, 2), `${label} [${id}]`])}`, section: path[0], group: path[1], parameter: label, read }
    }
    const pitchRoles = currentProtocol?.artifacts?.find(artifact => artifact.id === 'pitch_deck_outline')?.roles ?? []
    const dimensions = [
      { id: 'plan-mode', name: 'Plan › Selection › Mode and contract [plan-mode]', read: () => currentProtocol?.pack && currentMode()
        ? `${currentMode().label} · ${currentProtocol.pack.label} · v${currentProtocol.pack.version} · ${currentProtocol.pack.review_status}` : 'Loading plan…' },
      workflowColumn('plan-completeness', slot => reportValue(slot, report => {
        const status = report.check.completeness, missing = status.required - status.supplied
        return missing ? `Incomplete · ${status.supplied}/${status.required} supplied · ${missing} unknown` : `Entered · ${status.supplied}/${status.required} required fields`
      })),
      workflowColumn('data-validation', slot => reportValue(slot, report =>
        report.check.completeness.invalid_fields.length
          ? report.check.completeness.invalid_fields.map(lineLabel).join(' · ')
          : 'No invalid entries reported.')),
      workflowColumn('evidence-values', slot => evidenceValue(slot, (row, field, value) => `${row.field_key} · ${field?.label ?? lineLabel(row.field_key)}: ${value}`)),
      workflowColumn('evidence-provenance', slot => evidenceValue(slot, (row, field) => `${row.field_key} · ${field?.label ?? lineLabel(row.field_key)}: ${enumLabel(row.provenance)}`)),
      workflowColumn('evidence-observer', slot => evidenceValue(slot, (row, field) => `${row.field_key} · ${field?.label ?? lineLabel(row.field_key)}: ${enumLabel(row.observer_role)}`)),
      workflowColumn('evidence-date', slot => evidenceValue(slot, (row, field) => `${row.field_key} · ${field?.label ?? lineLabel(row.field_key)}: ${row.date}`)),
      workflowColumn('evidence-status', slot => slot.status === 'not_supplied' ? 'Not in this comparison.' : slot.evidence.length ? 'User-recorded · not authenticated' : 'No evidence entries recorded.'),
      ...coverageOutputs.map(output => ({ id: `coverage-${output.id}`, name: `Coverage › ${output.kind} › ${output.label.replace(/^Coverage\s*·\s*/u, '')} [${output.id}]`, read: slot => reportValue(slot, report => {
        const coverage = output.kind === 'evidence' ? report.evidence_coverage : report.projection_coverage?.[output.projection_id]
        if (!coverage) return 'Coverage unavailable.'
        if (output.kind === 'evidence') return `${coverage.evidenced_fields}/${coverage.guided_fields} guided fields have context · ${coverage.evidence_count} records · not authenticated`
        return `${coverage.inputs_supplied}/${coverage.inputs_mapped} mapped inputs supplied · ${coverage.requirements_mapped}/${coverage.requirements_total} requirements mapped · ${coverage.support_status}; coverage only`
      }) })),
      workflowColumn('model-coverage', slot => reportValue(slot, report => {
        const rows = Object.values(report.model.missing_inputs), complete = rows.filter(values => values.length === 0).length
        return `${complete}/${rows.length} outputs have their required inputs`
      })),
      ...modelOutputs.map(output => ({ id: `model-${output.id}`, name: `Model › Calculated outputs › ${output.label} [${output.id}]`, read: slot =>
        reportValue(slot, report => report.model_display[output.id]) })),
      ...pitchRoles.map(role => ({ id: `pitch-${role.id}`, name: `Pitch › Slide ${role.slide} › ${role.label} [${role.id}]`, read: slot =>
        reportValue(slot, report => report.pitch_deck_outline.find(row => row.id === role.id)?.content ?? 'Role output unavailable.') })),
      workflowColumn('next-checks', slot => reportValue(slot, report => report.next_checks.length
        ? report.next_checks.map(row => `${row.order}. ${row.action}`).join(' · ') : 'No next checks from the entered fields.')),
    ]
    return [...dimensions, ...review.dimensions()].map(dimension => ({ ...dimension, field: currentProtocol.workflow_columns.find(field => field.id === dimension.id) }))
  }
  async function workflowTableView(reviewFields = false) {
    const slots = comparisonSlotElements.slice(0, Number(comparisonCount.value))
    const resultSlots = tableSlots(comparisonValue)
    const dimensions = tableDimensions()
    if (reviewFields || tableOrientation === 'columns') {
      const { createSmeWorkflowFieldView } = await import('./sme-pack-dictionary.js?v=business-plan-dictionary-v2')
      return createSmeWorkflowFieldView({ protocol: currentProtocol, slots, dimensions, resultSlots, format: formatFieldValue,
        requirement: inputRequirementLabel, enumLabel, rowLabel, review: reviewFields,
        onActivateField: key => review.activateParameter(selectedWorkflowSet ?? 'A', key) })
    }
    const columns = [{ id: 'plan-row', name: currentMode()?.row_label ?? 'Plan option' }, ...currentFields.map(field => ({ id: field.name, name: inputTableLabel(field) })), ...dimensions.map(({ id, name }) => ({ id, name }))]
    const rows = slots.map(item => ({ id: item.slot, cells: [rowLabel(item.slot), ...currentFields.map(field => formatFieldValue(field, item.inputs[field.name], item.inputs.currency_code)), ...dimensions.map(dimension => dimension.read(resultSlots.find(slot => slot.slot === item.slot)))] }))
    return { columns, rows, layout: 'multiDimensional', orientation: 'rows', ariaLabel: `SME plan; ${pluralRows()} are rows and the selected mode, all contract inputs, evidence, coverage, declared outputs, and next checks are columns.`, selectedRowId: selectedWorkflowSet ?? undefined,
      onActivateRow: slot => { if (!slots.some(item => item.slot === slot)) return; selectedWorkflowSet = slot; renderWorkflowEditor(); workflowStatus.textContent = `Editing ${rowLabel(slot)}. Values and evidence stay on this device.`; void renderWorkflowTable() } }
  }
  function setWorkflowOrientation(orientation) {
    tableOrientation = orientation === 'columns' ? 'columns' : 'rows'
    workflowTableRegion.dataset.orientation = tableOrientation
    updateWorkflowOrientationCopy()
    void renderWorkflowTable()
  }
  function updateWorkflowOrientationCopy() {
    const metadata = tableOrientation === 'columns'
    const rowType = currentMode()?.id === 'scenario' ? 'Scenarios' : 'Plan options'
    workflowTableRegion.setAttribute('aria-label', metadata ? 'Workflow fields and outputs are rows; each metadata attribute and each plan option has its own column.' : `${rowType} are rows; fields and workflow outputs are columns.`)
    workflowPivot.textContent = metadata ? `Show ${pluralRows()} as rows` : 'Show field metadata columns'
    workflowPivot.setAttribute('aria-label', workflowPivot.textContent)
  }
  async function renderWorkflowTable(expectedGeneration = comparisonGeneration) {
    const own = ++workflowGeneration, current = () => own === workflowGeneration && expectedGeneration === comparisonGeneration
    if (await review.render()) return true
    const view = await workflowTableView()
    if (!current()) return true
    const ok = await renderSharedTable(workflowTableHost, view, workflowTableMount, current)
    if (!ok && current())
      workflowStatus.textContent = workflowTableHost.dataset.limitError
        ? 'Table limit reached (4,096 characters per cell; 196,608 bytes per view). Inputs are kept; shorten evidence or use fewer rows.'
        : 'Shared workflow table unavailable. Inputs are kept; reload only after exporting them.'
    return ok || !current()
  }
  async function runPlan(item = comparisonSlotElements[0]) {
    return invokeSmePackTool('business.plan.build', { pack_id: packSelect.value, mode: planModeSelect.value, inputs: readInputs(item), evidence: structuredClone(item.evidence) })
  }
  async function worksheetReports() {
    const generation = comparisonGeneration, pack = currentProtocol.pack, mode = planModeSelect.value
    const sets = comparisonSlotElements.slice(0, Number(comparisonCount.value)).map(item => ({ pack_id: pack.id, pack_version: pack.version,
      inputs: readInputs(item), evidence: structuredClone(item.evidence) }))
    const reports = sets.length === 1 ? [await runPlan()] : (await invokeSmePackTool('business.plan.compare', { mode, plan_sets: sets })).slots.flatMap(slot => slot.report ? [slot.report] : [])
    if (generation !== comparisonGeneration || document.body.dataset.workspaceRole !== 'sme') throw Error('sme_pack_worksheet_cancelled')
    if (reports.some(report => report.check.completeness.invalid_fields.length)) throw Error('sme_pack_worksheet_invalid')
    return reports
  }
  async function importWorksheet(file) {
    const generation = comparisonGeneration, pack = currentProtocol.pack, packVersion = packGeneration, request = ++importGeneration
    if (file.size > 65536) throw Error('sme_pack_worksheet_limit')
    const isCurrent = () => request === importGeneration && generation === comparisonGeneration && packVersion === packGeneration && document.body.dataset.workspaceRole === 'sme'
    let worksheets
    try {
      const text = await file.text()
      if (!isCurrent()) throw Error('sme_pack_worksheet_cancelled')
      worksheets = await readSmeWorksheets(text, file.name.split('.').pop().toLowerCase(), pack)
    } catch (error) {
      if (!isCurrent()) throw Error('sme_pack_worksheet_cancelled')
      throw error
    }
    if (!isCurrent()) throw Error('sme_pack_worksheet_cancelled')
    planModeSelect.value = worksheets[0].mode; comparisonCount.value = String(worksheets.length)
    for (const [index, item] of comparisonSlotElements.entries()) {
      item.inputs = { ...(worksheets[index]?.inputs ?? {}) }
      item.evidence = structuredClone(worksheets[index]?.evidence ?? [])
    }
    selectedWorkflowSet = 'A'; updateModePresentation(); invalidateComparison()
    workflowStatus.textContent = 'Worksheet imported in this tab. Build the plan to refresh model and readiness columns.'
  }
  async function refreshFields(packId = packSelect.value) {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packId })
    if (packId !== packSelect.value) return false
    currentProtocol = protocol
    currentFields = currentProtocol.input_fields
    planModeSelect.replaceChildren()
    for (const mode of currentProtocol.plan_modes) option(planModeSelect, mode.id, mode.label)
    planModeSelect.value = currentProtocol.plan_modes.find(mode => mode.default)?.id ?? ''
    $('#sme-heading').textContent = currentProtocol.pack.label
    runtimeMode.textContent = `${currentProtocol.pack.label.toUpperCase()} · LOCAL WORKSPACE`
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
    compareButton.textContent = count === 1 ? 'Build local plan' : `Compare ${count} ${pluralRows()} locally`
  }
  function updateModePresentation() {
    const mode = currentMode()
    if (!mode) return
    review.refresh()
    comparisonCountLabel.textContent = mode.id === 'scenario' ? 'Scenarios' : 'Plan options'
    planModeDescription.textContent = mode.description
    for (const item of comparisonCount.options) item.textContent = `${item.value} ${item.value === '1'
      ? mode.id === 'scenario' ? 'scenario · build' : 'plan option · build'
      : `${pluralRows()} · compare`}`
    updateComparisonSlotVisibility()
    renderWorkflowEditor()
    updateWorkflowOrientationCopy()
    void renderWorkflowTable()
  }
  function invalidateComparison() {
    ++comparisonGeneration
    comparisonPending = false; compareButton.disabled = false
    comparisonValue = null
    workflowStatus.textContent = 'Inputs changed. Build the local plan to refresh model and readiness columns.'
    void renderWorkflowTable()
  }
  function clearComparison() {
    review.clear()
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
      if (generation !== mount.generation || !isCurrent() || !host.isConnected) return true
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
      if (generation !== mount.generation || !isCurrent() || !host.isConnected) return true
      mount.handle ? mount.handle.update(view) : mount.handle = adapter.mountDataView(target, view)
      delete host.dataset.limitError
      if (host === workflowTableHost && !host.shadowRoot.querySelector('#sme-workflow-header-wrap')) {
        const headerStyle = node('style')
        headerStyle.id = 'sme-workflow-header-wrap'
        headerStyle.textContent = `th button > span { white-space: pre-line !important; overflow: visible !important; text-overflow: clip !important; overflow-wrap: anywhere !important; font-size: 12px !important; line-height: 1.2 !important; } th button { align-items: flex-start !important; } th > section { align-items: flex-start !important; }`
        host.shadowRoot.append(headerStyle)
      }
      return true
    } catch (error) {
      if (generation !== mount.generation || !isCurrent()) return true
      if (error instanceof RangeError || error.message === 'Invalid data view cell.') host.dataset.limitError = 'true'; else console.error('sme_shared_table_unavailable', error)
      mount.handle?.destroy(); mount.handle = null
      host.shadowRoot?.replaceChildren(); mount.ready = null
      return false
    }
  }
  async function renderDictionaryTable() {
    if (!currentProtocol || !dictionaryHost?.isConnected) return
    try {
    dictionaryModule ??= await import('./sme-pack-dictionary.js?v=business-plan-dictionary-v2')
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
      inputs: readInputs(item), ...(item.evidence.length ? { evidence: structuredClone(item.evidence) } : {}) }))
    const generation = ++comparisonGeneration
    comparisonPending = true; compareButton.disabled = true; comparisonValue = null
    workflowStatus.textContent = count === 1 ? 'Building plan locally…' : `Comparing ${pluralRows()} locally…`
    void renderWorkflowTable()
    let deadline, timedOut = false
    try {
      const pending = count === 1 ? runPlan(comparisonSlotElements[0])
        .then(report => ({ schema: 'sme-business-plan/comparison/v2', pack: currentProtocol.pack,
          mode: report.mode, slots: [{ slot: 'A', status: 'included', report }], persisted: false, inference_tokens: 0 }))
        : invokeSmePackTool('business.plan.compare', { mode: planModeSelect.value, plan_sets: planSets })
      const value = await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = true; reject(Error('sme_pack_comparison_deadline')) }, 2000) })])
      if (generation !== comparisonGeneration || document.body.dataset.workspaceRole !== 'sme') return
      comparisonValue = value
      if (!await renderWorkflowTable()) throw Error('shared_table_unavailable')
      const modeLabel = currentMode().id === 'scenario' ? 'scenario' : currentMode().label
      workflowStatus.textContent = count === 1 ? `Local ${modeLabel} plan built · inputs and report stay in this tab`
        : `Local ${modeLabel} comparison · inputs and reports stay in this tab`
    } catch (error) {
      if (generation === comparisonGeneration && document.body.dataset.workspaceRole === 'sme') {
        comparisonValue = null; void renderWorkflowTable()
        const code = error instanceof Error ? error.message : ''
        workflowStatus.textContent = timedOut ? 'Plan exceeded 2 seconds; no report was kept.'
          : code === 'sme_pack_comparison_currency_required'
            ? 'Enter the same ISO 4217 currency code in every row before comparing.'
            : code === 'sme_pack_comparison_identity_mismatch'
              ? 'Comparison requires the same plan contract and currency code across rows.'
              : code === 'sme_pack_response_too_large' || code === 'sme_pack_arguments_invalid'
                ? 'Plan limit reached (32 KB request; 64 KB response). Inputs are kept; shorten evidence or use fewer rows.'
                : code === 'shared_table_unavailable' ? workflowStatus.textContent : 'Plan refused. Review entered values and the shared protocol.'
      }
    } finally {
      clearTimeout(deadline)
      if (generation === comparisonGeneration) { comparisonPending = false; compareButton.disabled = false }
    }
  }
  for (const pack of PACK_INDEX) option(packSelect, pack.id, `${pack.label} · v${pack.version} · ${pack.review_status}`)
  packSelect.value = PACK_INDEX[0].id
  $('#sample').textContent = 'Load illustrative inputs'
  runtimeMode.textContent = 'SME PLAN · LOCAL WORKSPACE'
  runtimeStatus.textContent = 'Local computation ready. No service request is needed.'
  $('#mcp-url').textContent = new URL('services/sme-business-pack/mcp', document.baseURI).href
  $('#webmcp-status').textContent = 'Browser tools are optional; local checks work without a network.'
  await refreshFields()
  comparisonCount.value = '1'; updateComparisonSlotVisibility()
  updateModePresentation()
  updateWorkflowOrientationCopy()
  workflowPivot.addEventListener('click', () => setWorkflowOrientation(tableOrientation === 'rows' ? 'columns' : 'rows'))
  void renderWorkflowTable()
  comparisonCount.addEventListener('change', () => { updateComparisonSlotVisibility(); invalidateComparison() })
  planModeSelect.addEventListener('change', () => { updateModePresentation(); invalidateComparison() })
  packSelect.addEventListener('change', async () => {
    const generation = ++packGeneration
    clearComparison()
    if (await refreshFields(packSelect.value) && generation === packGeneration) {
      updateModePresentation()
      void renderWorkflowTable()
      if (location.hash.slice(1).split('?')[0] === 'sme-dictionary') void renderDictionaryTable()
    }
  })
  form.addEventListener('submit', event => { event.preventDefault(); void runComparison() })
  $('#sample').addEventListener('click', () => {
    const sample = currentProtocol.illustrative_inputs
    if (!sample || !Object.keys(sample).length) {
      workflowStatus.textContent = 'No illustrative inputs are declared by this plan contract.'; return
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
    workflowStatus.textContent = 'Illustrative values only; review them and replace as needed. They remain in this tab.'
  })
  for (const button of worksheetActions.querySelectorAll('[data-export]')) button.addEventListener('click', async () => {
    try {
      const reports = await worksheetReports(), format = button.dataset.export
      const suffix = format === 'markdown' ? 'md' : format, worksheets = reports.map(report => JSON.parse(report.worksheet.json))
      const content = format === 'markdown' ? reports.map(report => report.worksheet.markdown.slice(0, report.worksheet.markdown.lastIndexOf('\n~~~json\n')) + '\n').join('\n')
        + '~~~json\n' + serializeSmeWorksheets(worksheets, 'json') + '\n~~~\n' : serializeSmeWorksheets(worksheets, format)
      if (new TextEncoder().encode(content).byteLength > 65536) throw Error('sme_pack_worksheet_limit')
      if (typeof content !== 'string') throw Error('worksheet_format_missing')
      download(`${currentProtocol.pack.id.replaceAll('.', '-')}-worksheet.` + suffix, format === 'json' ? 'application/json'
        : format === 'csv' ? 'text/csv' : 'text/markdown', content)
      workflowStatus.textContent = 'Worksheet downloaded locally. No report was uploaded.'
    } catch (error) { if (error.message !== 'sme_pack_worksheet_cancelled') workflowStatus.textContent = 'Worksheet export refused. Inputs are kept; review values or reduce rows/evidence to fit 32/64 KB limits.' }
  })
  printButton.addEventListener('click', async () => {
    let sheet
    try {
      const reports = await worksheetReports()
      sheet = node('article', undefined, 'sme-print-sheet')
      for (const [index, plan] of reports.entries()) {
      const worksheet = JSON.parse(plan.worksheet.json)
      sheet.append(node('h1', rowLabel(['A', 'B', 'C'][index]) + ' · ' + (worksheet.inputs.opportunity_label || worksheet.inputs.venture_name || plan.pack.label + ' draft')), node('p', plan.mode.label + ' · Plan contract v' + plan.pack.version + ' · ' + plan.pack.review_status + ' · ' + worksheet.currency_code + ' · ' + plan.as_of))
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
      sheet.append(tasks, node('p', plan.disclaimer))
      }
      const cleanup = () => { sheet.remove(); document.body.classList.remove('sme-printing') }
      document.body.append(sheet); document.body.classList.add('sme-printing')
      window.addEventListener('afterprint', cleanup, { once: true }); window.print()
      workflowStatus.textContent = 'Print view opened. Use the browser dialog to print or save locally.'
    } catch (error) {
      sheet?.remove(); document.body.classList.remove('sme-printing')
      if (error.message === 'sme_pack_worksheet_cancelled') return
      workflowStatus.dataset.printError = error instanceof Error ? error.message : 'unknown'
      workflowStatus.textContent = 'Print worksheet refused. Review the entered values.'
    }
  })
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0]; if (!file) return
    try { await importWorksheet(file) }
    catch (error) { if (error.message !== 'sme_pack_worksheet_cancelled') workflowStatus.textContent = error.message === 'sme_pack_worksheet_identity'
      ? 'Worksheet contract or version does not match. Current inputs are kept; use a worksheet for the selected contract version.'
      : 'Worksheet import refused. Current inputs are kept; check values, row identity and the 64 KB file limit.' }
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
