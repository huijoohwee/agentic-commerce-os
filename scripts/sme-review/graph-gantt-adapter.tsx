import React from 'react'
import { createRoot } from 'react-dom/client'
import { VideoSequenceTimelineRuler } from '@graph/components/timeline/VideoSequenceTimelineRuler'
import { buildMermaidGanttTimelineModel } from '@graph/lib/mermaid/mermaidGanttTimelineModel'
import '@graph/components/timeline/TimelineTransportControls.css'
import '@graph/components/timeline/TimelineTransportControlsMermaidGantt.css'
import '@graph/components/timeline/TimelineTransportLane.css'
import './graph-gantt-host.css'
import { reviewTimingState } from '../../public/local-first/sme-review-workflow.js'

type Row = { guidance: string; fields: { name: string; label: string }[]; id: string; option: string; order: number; task: string; predecessor: string; successor: string; start: string; end: string }
type Column = { id: string; label: string; value_key: keyof Row; empty_label?: string; definition: string }
type FieldRecord = { id: string; depth: number; cells: string[] }
type FieldView = { columns: { id: string; name: string }[]; rows: FieldRecord[] }
type RecordNode = { record: FieldRecord; children: RecordNode[] }
type Projection = { columns: Column[]; rows: Row[]; fieldView: FieldView; selected: string | null; onSelect: (id: string) => void; onEditDates: (id: string) => void; onActivateRecord: (option: string, id: string) => void }
const fieldCell = (record: FieldRecord, view: FieldView, id: string) => record.cells[view.columns.findIndex(column => column.id === id)]
function recordTree(view: FieldView) {
  const roots: RecordNode[] = [], stack: RecordNode[] = []
  for (const record of view.rows) {
    while (stack.length && stack.at(-1)!.record.depth >= record.depth) stack.pop()
    const node = { record, children: [] }
    ;(stack.at(-1)?.children ?? roots).push(node); stack.push(node)
  }
  return roots
}
function ReviewRecord({ node, view, option, activate }: { node: RecordNode; view: FieldView; option: string; activate: Projection['onActivateRecord'] }) {
  const { record, children } = node, label = fieldCell(record, view, 'metadata-3'), key = fieldCell(record, view, 'metadata-4')
  const editable = record.id.startsWith('input:') || ['review-start', 'review-end'].includes(key)
  const cells = view.columns.map((column, index) => ({ ...column, value: record.cells[index] }))
    .filter(column => !column.id.startsWith('value-') || column.id === `value-${option}`)
  return <li data-review-record={record.id} data-review-option={option}>
    <details open={record.id.startsWith('group:')}><summary>{label}</summary>
      {!record.id.startsWith('group:') && <p className="review-record-value"><output>{fieldCell(record, view, `value-${option}`)}</output></p>}
      {editable && <button type="button" onClick={() => activate(option, record.id)}>Edit {label}</button>}
      <details className="review-record-metadata"><summary>Record details</summary><dl>{cells.map(column => <React.Fragment key={column.id}>
        <dt>{column.name}</dt><dd data-review-cell={column.id}>{column.value}</dd>
      </React.Fragment>)}</dl></details>
      {children.length > 0 && <ul className="review-records">{children.map(child => <ReviewRecord key={child.record.id} node={child} view={view} option={option} activate={activate} />)}</ul>}
    </details>
  </li>
}
const day = 86400000
const timestamp = (value: string) => Date.parse(value + 'T00:00:00Z')
function OptionTimeline({ rows, columns, fieldView, selected, onSelect, onEditDates, onActivateRecord }: Projection) {
  const viewportRef = React.useRef<HTMLElement>(null), contentRef = React.useRef<HTMLElement>(null)
  const timing = reviewTimingState(rows)
  const records = recordTree(fieldView), activityTitles = new Set(rows.map(row => row.task))
  const renderRecord = (node: RecordNode) => <ReviewRecord key={node.record.id} node={node} view={fieldView} option={rows[0].option} activate={onActivateRecord} />
  const placed = timing.dated ? rows.filter(row => timing.placedIds.includes(row.id)) : rows
  const origin = timing.dated ? Math.min(...placed.map(row => timestamp(row.start))) : 0
  const position = (value: string) => (timestamp(value) - origin) / day
  const model = buildMermaidGanttTimelineModel('gantt\ntitle Video Sequence\n' + placed.map(row => {
    const start = timing.dated ? position(row.start) : row.order - 1
    const duration = timing.dated ? Math.max(0.001, position(row.end) - start) : 1
    return `${row.order}. ${row.task} : kgpos_${String(start).replace('.', '_')}, ${duration}m`
  }).join('\n'))
  const spans = model.taskSpans.map((span, index) => ({ ...span, rowKey: placed[index].id,
    raw: span.raw + (timing.dated && placed[index].start === placed[index].end ? ', milestone' : '') }))
  const max = Math.max(1, model.endMinutes)
  const label = (value: number) => timing.dated
    ? new Date(origin + Math.round(value) * day).toISOString().slice(0, 10)
    : `Step ${Math.min(rows.length, Math.floor(value) + 1)}`
  const ticks = timing.dated ? Array.from({ length: Math.min(5, Math.ceil(max) + 1) }, (_, i) => {
    const value = Math.round(max * i / Math.max(1, Math.min(5, Math.ceil(max) + 1) - 1)); return { label: label(value), minutes: value, percent: value / max * 100 }
  }) : rows.map(row => ({ label: `Step ${row.order}`, minutes: row.order - 1, percent: (row.order - 1) / max * 100 }))
  const workflowRowContents = rows.map(row => {
      const observation = timing.observations.find(item => item.id === row.id), gap = observation?.gapDays
      return { rowKey: row.id, label: `${row.order}. ${row.task}`, content: <details className="review-activity" data-review-activity={row.id} open={selected === row.id}>
        <summary>{row.order}. {row.task}</summary>
        <button type="button" aria-pressed={selected === row.id} onClick={() => onSelect(row.id)}
          aria-label={`Edit plan option for ${row.order}. ${row.task}`} title={`Fields: ${row.fields.map(field => field.label).join(', ')}`}>Edit plan option</button>
        <p>{row.guidance}</p>
        <button type="button" onClick={() => onEditDates(row.id)} aria-label={`Edit dates for ${row.order}. ${row.task}`}>Edit dates</button>
        <p>{row.start && row.end ? (row.start === row.end ? 'Entered milestone' : 'Entered interval') : row.start ? 'Start entered; end unknown' : row.end ? 'End entered; start unknown' : 'Timing not entered'}</p>
        <dl>{columns.filter(column => ['review-predecessor', 'review-successor', 'review-start', 'review-end'].includes(column.id)).map(column => {
          const value = String(row[column.value_key] || column.empty_label || 'Not entered')
          return <React.Fragment key={column.id}><dt title={column.definition}>{column.label.split(' · ').at(-1)}</dt>
            <dd>{['review-start', 'review-end'].includes(column.id) && row[column.value_key]
              ? <time dateTime={value}>{value}</time> : value}</dd></React.Fragment>
        })}</dl>
        {gap !== null && gap !== undefined && <p className="review-timing-observation">{gap === 0 ? 'Starts at the preceding activity’s exclusive end.'
          : gap < 0 ? `Starts ${Math.abs(gap)} calendar ${Math.abs(gap) === 1 ? 'day' : 'days'} before the preceding activity’s recorded end.`
            : `Gap: ${gap} calendar ${gap === 1 ? 'day' : 'days'} after the preceding activity’s recorded end.`}</p>}
        {observation?.overlapDays !== null && observation?.overlapDays !== undefined && observation.overlapDays > 0 && <p>Recorded windows overlap by {observation.overlapDays} calendar {observation.overlapDays === 1 ? 'day' : 'days'}.</p>}
        <ul className="review-records" aria-label={`${row.task} shared records`}>{records.filter(node => fieldCell(node.record, fieldView, 'metadata-3') === row.task).map(renderRecord)}</ul>
      </details> }
    })
  workflowRowContents.push({ rowKey: `${rows[0].option}:shared-records`, label: 'Shared records', content: <details className="review-activity" data-review-shared-records="true">
      <summary>Shared parameters and outputs</summary>
      <h4>Shared records</h4><p>All Review steps records use the same definitions and live option values. Expand a record to inspect it. Fields and outputs have no independent schedule.</p>
      <ul className="review-records">{records.filter(node => !activityTitles.has(fieldCell(node.record, fieldView, 'metadata-3'))).map(renderRecord)}</ul>
    </details> })

  return <section aria-label={`Plan option ${rows[0].option} review timeline`} data-timing={timing.dated ? 'dates' : 'dependencies'}>
    <h3>Plan option {rows[0].option}</h3><p role="status">{timing.reason}</p>
    <div style={{ overflowX: 'auto' }}><section className="timeline-transport-shell timeline-transport-ruler timeline-transport-ruler--tracks timeline-transport-ruler--video-sequence" style={{ minWidth: 560, '--kg-video-sequence-lane-count': placed.length } as React.CSSProperties}>
      <VideoSequenceTimelineRuler contentRef={contentRef} viewportRef={viewportRef} displayTicks={ticks}
        dragPreview={null} draggingMode={null} draggingRowKey="" editable={false} maxMinutes={max}
        mediaDurationSeconds={0} playheadPercent={0} projectionMode="workflow" workflowRows selectedRowKey={selected ?? ''}
        taskSpans={spans} workflowRowContents={workflowRowContents} timelineZoom={1} formatPositionLabel={label}
        onRulerPointerDown={() => {}} onSelectRowKey={onSelect} onSelectRowPosition={(_, position) => { const span = spans.find(span => position >= span.startMinutes && position < span.endMinutes) ?? spans.at(-1); if (span) onSelect(span.rowKey) }}
        onDropMedia={() => false} onTrackPointerStart={() => {}} />
    </section></div>
  </section>
}
function Timeline(props: Projection) {
  const options = [...new Set(props.rows.map(row => row.option))]
  return <div className="sme-native-gantt">{options.map(option => <OptionTimeline key={option} {...props} rows={props.rows.filter(row => row.option === option)} />)}</div>
}
export function mountGanttTimeline(target: HTMLElement, projection: Projection) {
  const root = createRoot(target); root.render(<Timeline {...projection} />)
  return { update(next: Projection) { root.render(<Timeline {...next} />) }, destroy() { root.unmount() } }
}
