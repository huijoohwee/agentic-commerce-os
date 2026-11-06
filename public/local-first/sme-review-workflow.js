// One review projection feeds the existing Base table, native Graph Gantt and local export.
const dateNumber = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN
  const time = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN
}
export function validReviewDates({ start = '', end = '' }) {
  return [start, end].every(value => value === '' || Number.isFinite(dateNumber(value)))
    && (!start || !end || dateNumber(end) >= dateNumber(start))
}
export function projectSmeReviewRows(slots, protocol, format, dates = {}) {
  const definition = protocol.review_workflow
  if (!definition) return []
  const steps = definition.steps, ids = new Set(steps.map(step => step.id)), fields = protocol.input_fields
  if (ids.size !== steps.length || fields.some(field => !ids.has(field.review_step))
    || steps.some(step => !fields.some(field => field.name === step.focus_field && field.review_step === step.id))) throw Error('review_protocol_field_binding_invalid')
  return slots.flatMap(slot => steps.map((step, index) => {
    const id = `${slot.slot}:${step.id}`, timing = dates[id] ?? { start: '', end: '' }, linked = fields.filter(field => field.review_step === step.id)
    return { id, option: slot.slot, order: index + 1, task: step.title, guidance: step.guidance, focus: step.focus_field,
      predecessor: index ? `${slot.slot}:${steps[index - 1].id}` : '', successor: index < steps.length - 1 ? `${slot.slot}:${steps[index + 1].id}` : '',
      fields: linked, field_keys: linked.map(field => field.name),
      inputs: linked.map(field => `${field.label}: ${format(field, slot.inputs[field.name], slot.inputs.currency_code)}`).join('\n'), start: timing.start, end: timing.end }
  }))
}
export function reviewTimingState(rows) {
  if (!rows.every(row => row.start && row.end && validReviewDates(row))) return { dated: false, reason: 'Dependency order; dates are optional. Equal bar widths do not represent elapsed time.' }
  for (const row of rows) {
    const predecessor = rows.find(item => item.id === row.predecessor)
    if (predecessor && dateNumber(row.start) < dateNumber(predecessor.end))
      return { dated: false, reason: 'Dates overlap a predecessor. Showing dependency order until timing is reconciled.' }
  }
  return { dated: true, reason: 'Entered dates; the end date is exclusive. Equal start/end dates are milestones.' }
}
export function readSmeReviewDates(text, currentRows, protocol) {
  const exchange = protocol.review_workflow.exchange
  if (new TextEncoder().encode(text).length > exchange.max_bytes) throw Error('review_file_limit')
  const value = JSON.parse(text), allowed = new Set(currentRows.map(row => row.id)), dates = {}, seen = new Set()
  if (value?.schema !== exchange.schema || value.pack_id !== protocol.pack.id || value.pack_version !== protocol.pack.version
    || value.mode !== protocol.review_workflow.mode || !Array.isArray(value.rows) || value.rows.length !== allowed.size) throw Error('review_file_identity')
  for (const row of value.rows) {
    const next = { start: row['review-start'], end: row['review-end'] }
    if (Object.keys(row).sort().join() !== ['id', ...exchange.fields].sort().join() || !allowed.has(row.id) || seen.has(row.id)
      || typeof next.start !== 'string' || typeof next.end !== 'string' || !validReviewDates(next)) throw Error('review_file_dates')
    seen.add(row.id); dates[row.id] = next
  }
  return dates
}
export function createSmeReviewWorkflow({ root, getState, renderTable, createTableView, focusField, onViewChange }) {
  const $ = selector => root.querySelector(selector), view = $('#sme-review-view'), controls = $('#sme-review-controls')
  const timelineHost = $('#sme-review-timeline'), editor = $('#sme-review-dates'), note = $('#sme-review-note')
  const start = $('#sme-review-start'), end = $('#sme-review-end'), selectedLabel = $('#sme-review-selected')
  const tableHost = $('#sme-workflow-table-region'), pivot = $('#sme-workflow-pivot')
  let dates = {}, selected = null, generation = 0, nativeModule, nativeHandle, ready, context = ''
  const rows = () => { const state = getState(); return projectSmeReviewRows(state.slots, state.protocol, state.format, dates) }
  const choose = (id, key) => {
    const row = rows().find(item => item.id === id); if (!row) return
    selected = id; selectedLabel.textContent = `${row.option} · ${row.task}`
    start.value = row.start; end.value = row.end; editor.hidden = false
    focusField(row.option, key ?? row.focus); onViewChange()
  }
  function refresh() {
    const state = getState(), next = `${state.protocol?.pack.id}:${state.mode?.id}`
    const definition = state.protocol?.review_workflow, supported = definition?.mode === state.mode?.id && Boolean(definition)
    const ids = new Set(state.slots.map(slot => slot.slot))
    dates = Object.fromEntries(Object.entries(dates).filter(([id]) => ids.has(id.split(':')[0])))
    if (selected && !ids.has(selected.split(':')[0])) selected = null
    controls.hidden = !supported
    if (context !== next) {
      context = next; view.replaceChildren(...(definition?.views ?? []).map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option }))
      view.value = supported ? definition.default_view : 'plan'
    }
    for (const [key, input] of [['review-start', start], ['review-end', end]]) {
      const field = state.protocol?.workflow_columns.find(field => field.id === key); if (!field) continue
      input.type = field.type; input.title = field.definition; root.querySelector(`label[for="${input.id}"]`).textContent = field.label.split(' · ').at(-1)
    }
    const active = supported && view.value !== 'plan'
    pivot.hidden = active; tableHost.hidden = false
    timelineHost.hidden = !active || view.value !== 'gantt'
    editor.hidden = !supported || !selected || !state.slots.some(slot => selected.startsWith(slot.slot + ':'))
    note.hidden = !active
    if (!active) { ++generation; nativeHandle?.destroy(); nativeHandle = null }
    return active
  }
  async function timeline(data, current) {
    if (!nativeModule) nativeModule = await import('./graph-gantt-timeline.js').catch(error => { nativeModule = null; throw error })
    if (!current()) return
    let target = timelineHost.shadowRoot?.querySelector('[data-review-timeline-target]')
    if (!target) {
      const shadow = timelineHost.shadowRoot ?? timelineHost.attachShadow({ mode: 'open' })
      target = document.createElement('div'); target.dataset.reviewTimelineTarget = 'true'
      const links = ['graph-ui-tokens.css', 'graph-gantt-timeline.css'].map(file => {
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL(file, import.meta.url).href; return link
      })
      ready = Promise.all(links.map(link => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('review_timeline_styles_unavailable')), 8000)
        link.onload = () => { clearTimeout(timer); resolve() }; link.onerror = () => { clearTimeout(timer); reject(Error('review_timeline_styles_unavailable')) }
      })))
      shadow.append(...links, target)
    }
    await ready
    if (!current()) return
    const projection = { rows: data, selected, onSelect: id => choose(id) }
    nativeHandle ? nativeHandle.update(projection) : nativeHandle = nativeModule.mountGanttTimeline(target, projection)
  }
  async function render() {
    if (!refresh()) return false
    const own = ++generation, data = rows(), current = () => own === generation && view.value === 'gantt' && !controls.hidden && root.isConnected
    note.textContent = 'All views use the same Plan options fields, values and definitions. Optional timing is local view state; export view notes to retain it.'
    if (view.value === 'gantt') {
      try { await timeline(data, current) }
      catch { if (current()) note.textContent = 'Gantt Timeline unavailable. Shared Plan options fields and view notes are kept below.' }
    } else { nativeHandle?.destroy(); nativeHandle = null }
    const tableCurrent = () => own === generation && !controls.hidden && view.value !== 'plan'
    const table = await createTableView()
    if (tableCurrent() && !await renderTable(table, tableCurrent)) note.textContent = 'Shared field table unavailable or over its limits. Inputs and view notes are kept.'
    return true
  }
  view.addEventListener('change', () => { ++generation; refresh(); onViewChange() })
  for (const input of [start, end]) input.addEventListener('change', () => {
    if (!selected) return
    const next = { start: start.value, end: end.value }
    if (!validReviewDates(next)) { note.textContent = 'Dates refused: use valid dates with end on or after start. Previous timing is kept.'; return }
    dates[selected] = next; onViewChange()
  })
  $('#sme-review-export').addEventListener('click', () => {
    const state = getState(), definition = state.protocol.review_workflow
    const text = JSON.stringify({ schema: definition.exchange.schema, pack_id: state.protocol.pack.id, pack_version: state.protocol.pack.version, mode: definition.mode,
      rows: rows().map(row => ({ id: row.id, 'review-start': row.start, 'review-end': row.end })) }, null, 2)
    if (new TextEncoder().encode(text).length > definition.exchange.max_bytes) { note.textContent = 'View-note export exceeds its declared size limit.'; return }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = document.createElement('a')
    link.href = url; link.download = 'sme-view-notes.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    note.textContent = 'View notes exported locally using the active plan contract field keys. Financial inputs remain in the existing worksheet.'
  })
  $('#sme-review-import').addEventListener('change', async event => {
    const file = event.target.files?.[0], own = generation; if (!file) return
    try {
      if (file.size > getState().protocol.review_workflow.exchange.max_bytes) throw Error('review_file_limit')
      const next = readSmeReviewDates(await file.text(), rows(), getState().protocol)
      if (own !== generation || controls.hidden) return
      dates = next; if (selected) { start.value = dates[selected]?.start ?? ''; end.value = dates[selected]?.end ?? '' }
      onViewChange()
    } catch { if (own === generation) note.textContent = 'Review import refused. Current inputs and dates are kept; select view notes for the active plan contract.' }
    finally { event.target.value = '' }
  })
  const activateParameter = (slot, key) => {
    const field = getState().protocol.input_fields.find(field => field.name === key)
    if (field) { if (field.review_step) choose(`${slot}:${field.review_step}`, key); else { focusField(slot, key); onViewChange() }; return }
    if (key === 'review-start' || key === 'review-end') { choose(selected ?? `${slot}:${getState().protocol.review_workflow.steps[0].id}`); (key === 'review-start' ? start : end).focus() }
  }
  const dimensions = () => (getState().protocol?.workflow_columns ?? []).filter(field => field.kind === 'review_view').map(field => ({
    id: field.id, name: `Review › Workflow › ${field.label.split(' · ').at(-1)} [${field.id}]`, section: 'Review', group: 'Workflow', parameter: field.label.split(' · ').at(-1),
    read: slot => getState().mode?.id !== getState().protocol.review_workflow.mode ? 'Not applicable in this mode' : rows().filter(row => row.option === slot.slot)
      .map(row => `${row.task}: ${Array.isArray(row[field.value_key]) ? row[field.value_key].join(', ') : row[field.value_key] || field.empty_label || 'Not entered'}`).join('\n'),
  }))
  return { render, refresh, dimensions, activateParameter, clear() { ++generation; dates = {}; selected = null; context = ''; nativeHandle?.destroy(); nativeHandle = null; editor.hidden = true } }
}
