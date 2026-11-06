// One review projection feeds the existing Base table, native Graph Gantt and local export.
export const SME_REVIEW_STEPS = Object.freeze([
  Object.freeze({ id: 'limits', title: 'Set your buying limits', focus: 'buyer_budget',
    fields: ['buyer_budget', 'available_cash', 'target_handover_months', 'operator_experience'],
    guidance: 'Record your spending ceiling, cash available, desired timing and relevant experience. Budget and available cash are distinct.' }),
  Object.freeze({ id: 'transfer', title: 'Define the transfer', focus: 'transaction_structure',
    fields: ['transaction_structure', 'purchase_price', 'included_items', 'excluded_items', 'monthly_revenue', 'financial_basis', 'financial_period_months', 'location_monthly_cost', 'location_term_months', 'location_renewal_months', 'location_assignment_status'],
    guidance: 'Clarify the business, assets or premises included. Keep price, operating figures, currency, period, rent and remaining term together. Monthly revenue less listed costs is not verified profit; a profit multiple is not payback. Clarify landlord consent, reinstatement, renewal and any franchise obligations.' }),
  Object.freeze({ id: 'questions', title: 'Resolve the open questions', focus: 'accounts_access',
    fields: ['accounts_access', 'permission_transfer_status', 'team_continuity', 'handover_months', 'support_scope', 'review_stage', 'next_action'],
    guidance: 'Record access to accounts, permission status, staff continuity and handover support. Keep unknown answers explicit and choose one next action.' }),
])
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
  const fields = new Map(protocol.input_fields.map(field => [field.name, field]))
  return slots.flatMap(slot => SME_REVIEW_STEPS.map((step, index) => {
    const id = `${slot.slot}:${step.id}`, timing = dates[id] ?? { start: '', end: '' }
    return { id, option: slot.slot, order: index + 1, task: step.title, guidance: step.guidance, focus: step.focus,
      predecessor: index ? `${slot.slot}:${SME_REVIEW_STEPS[index - 1].id}` : '',
      successor: index < SME_REVIEW_STEPS.length - 1 ? `${slot.slot}:${SME_REVIEW_STEPS[index + 1].id}` : '',
      inputs: step.fields.filter(key => fields.has(key)).map(key => `${fields.get(key).label}: ${format(fields.get(key), slot.inputs[key], slot.inputs.currency_code)}`).join('\n'),
      start: timing.start, end: timing.end }
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
export function readSmeReviewDates(text, currentRows) {
  if (new TextEncoder().encode(text).length > 65536) throw Error('review_file_limit')
  const value = JSON.parse(text), allowed = new Set(currentRows.map(row => row.id)), dates = {}, seen = new Set()
  if (value?.schema !== 'sme-review-records/v1' || !Array.isArray(value.rows) || value.rows.length !== allowed.size) throw Error('review_file_identity')
  for (const row of value.rows) {
    if (!allowed.has(row.id) || seen.has(row.id) || typeof row.start !== 'string' || typeof row.end !== 'string' || !validReviewDates(row)) throw Error('review_file_dates')
    seen.add(row.id); dates[row.id] = { start: row.start, end: row.end }
  }
  return dates
}
export function createSmeReviewWorkflow({ root, getState, renderTable, focusField, onViewChange }) {
  const $ = selector => root.querySelector(selector), view = $('#sme-review-view'), controls = $('#sme-review-controls')
  const timelineHost = $('#sme-review-timeline'), editor = $('#sme-review-dates'), note = $('#sme-review-note')
  const start = $('#sme-review-start'), end = $('#sme-review-end'), selectedLabel = $('#sme-review-selected')
  const tableHost = $('#sme-workflow-table-region'), pivot = $('#sme-workflow-pivot')
  let dates = {}, selected = null, generation = 0, nativeModule, nativeHandle, ready, context = ''
  const rows = () => { const state = getState(); return projectSmeReviewRows(state.slots, state.protocol, state.format, dates) }
  const choose = id => {
    const row = rows().find(item => item.id === id); if (!row) return
    selected = id; selectedLabel.textContent = `${row.option} · ${row.task}`
    start.value = row.start; end.value = row.end; editor.hidden = false
    focusField(row.option, row.focus); onViewChange()
  }
  function refresh() {
    const state = getState(), next = `${state.protocol?.pack.id}:${state.mode?.id}`
    const supported = state.protocol?.pack.id === 'sme.takeover-checker' && state.mode?.id === 'buy_build'
    const ids = new Set(state.slots.map(slot => slot.slot))
    dates = Object.fromEntries(Object.entries(dates).filter(([id]) => ids.has(id.split(':')[0])))
    if (selected && !ids.has(selected.split(':')[0])) selected = null
    controls.hidden = !supported
    if (context !== next) { context = next; view.value = supported ? 'review' : 'plan' }
    const active = supported && view.value !== 'plan'
    pivot.hidden = active; tableHost.hidden = active && view.value === 'gantt'
    timelineHost.hidden = !active || view.value !== 'gantt'
    editor.hidden = !active || !selected || !state.slots.some(slot => selected.startsWith(slot.slot + ':'))
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
    const projection = { rows: data, selected, onSelect: choose }
    nativeHandle ? nativeHandle.update(projection) : nativeHandle = nativeModule.mountGanttTimeline(target, projection)
  }
  async function render() {
    if (!refresh()) return false
    const own = ++generation, data = rows(), current = () => own === generation && view.value === 'gantt' && !controls.hidden && root.isConnected
    note.textContent = 'The same review records are shown in both views. Optional dates stay in this tab; export review records to retain them. Financial worksheet imports do not change these view notes.'
    if (view.value === 'gantt') {
      try { await timeline(data, current) }
      catch { if (current()) note.textContent = 'Gantt Timeline unavailable. Your review records and dates are kept; switch to Review steps.' }
    } else {
      nativeHandle?.destroy(); nativeHandle = null
      const labels = ['Step ID', 'Plan option', 'Review step', 'Predecessor', 'Successor', 'Review content', 'Current inputs', 'Start (optional)', 'End (optional)']
      const tableCurrent = () => own === generation && view.value === 'review' && !controls.hidden
      const ok = await renderTable({ columns: labels.map((name, index) => ({ id: 'review-' + index, name })),
        rows: data.map(row => ({ id: row.id, cells: [row.id, row.option, row.task, row.predecessor || 'None', row.successor || 'None', row.guidance, row.inputs, row.start || 'Not scheduled', row.end || 'Not scheduled'] })),
        layout: 'multiDimensional', orientation: 'rows', selectedRowId: selected ?? undefined,
        ariaLabel: 'Takeover review steps with predecessor and successor links; the same records are available as a Gantt Timeline.', onActivateRow: choose }, tableCurrent)
      if (!ok && tableCurrent()) note.textContent = 'Review table unavailable or over its limits. Your inputs and dates are kept; shorten long input summaries or use fewer options.'
    }
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
    const text = JSON.stringify({ schema: 'sme-review-records/v1', rows: rows() }, null, 2)
    if (new TextEncoder().encode(text).length > 65536) { note.textContent = 'Review export exceeds 64 KB; reduce the displayed plan content.'; return }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), link = document.createElement('a')
    link.href = url; link.download = 'sme-review-records.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    note.textContent = 'Review records exported locally, including displayed input summaries and optional dates. Keep this file private.'
  })
  $('#sme-review-import').addEventListener('change', async event => {
    const file = event.target.files?.[0], own = generation; if (!file) return
    try {
      if (file.size > 65536) throw Error('review_file_limit')
      const next = readSmeReviewDates(await file.text(), rows())
      if (own !== generation || controls.hidden) return
      dates = next; if (selected) { start.value = dates[selected]?.start ?? ''; end.value = dates[selected]?.end ?? '' }
      onViewChange()
    } catch { if (own === generation) note.textContent = 'Review import refused. Current inputs and dates are kept; select a matching review-record file.' }
    finally { event.target.value = '' }
  })
  return { render, refresh, clear() { ++generation; dates = {}; selected = null; context = ''; nativeHandle?.destroy(); nativeHandle = null; editor.hidden = true } }
}
