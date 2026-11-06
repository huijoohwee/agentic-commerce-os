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
type Projection = { columns: Column[]; rows: Row[]; selected: string | null; onSelect: (id: string) => void }
const day = 86400000
const timestamp = (value: string) => Date.parse(value + 'T00:00:00Z')
function OptionTimeline({ rows, columns, selected, onSelect }: Projection) {
  const viewportRef = React.useRef<HTMLElement>(null), contentRef = React.useRef<HTMLElement>(null)
  const timing = reviewTimingState(rows)
  const origin = timing.dated ? Math.min(...rows.map(row => timestamp(row.start))) : 0
  const position = (value: string) => (timestamp(value) - origin) / day
  const model = buildMermaidGanttTimelineModel('gantt\ntitle Video Sequence\n' + rows.map(row => {
    const start = timing.dated ? position(row.start) : row.order - 1
    const duration = timing.dated ? Math.max(0.001, position(row.end) - start) : 1
    return `${row.order}. ${row.task} : kgpos_${String(start).replace('.', '_')}, ${duration}m`
  }).join('\n'))
  const spans = model.taskSpans.map((span, index) => ({ ...span, rowKey: rows[index].id,
    raw: span.raw + (timing.dated && rows[index].start === rows[index].end ? ', milestone' : '') }))
  const max = Math.max(1, model.endMinutes)
  const label = (value: number) => timing.dated
    ? new Date(origin + Math.round(value) * day).toISOString().slice(0, 10)
    : `Step ${Math.min(rows.length, Math.floor(value) + 1)}`
  const ticks = timing.dated ? Array.from({ length: Math.min(5, Math.ceil(max) + 1) }, (_, i) => {
    const value = Math.round(max * i / Math.max(1, Math.min(5, Math.ceil(max) + 1) - 1)); return { label: label(value), minutes: value, percent: value / max * 100 }
  }) : rows.map(row => ({ label: `Step ${row.order}`, minutes: row.order - 1, percent: (row.order - 1) / max * 100 }))
  return <section aria-label={`Plan option ${rows[0].option} review timeline`} data-timing={timing.dated ? 'dates' : 'dependencies'}>
    <h3>Plan option {rows[0].option}</h3><p role="status">{timing.reason}</p>
    <div style={{ overflowX: 'auto' }}><section className="timeline-transport-shell timeline-transport-ruler timeline-transport-ruler--tracks timeline-transport-ruler--video-sequence" style={{ minWidth: 560, '--kg-video-sequence-lane-count': 1 } as React.CSSProperties}>
      <VideoSequenceTimelineRuler contentRef={contentRef} viewportRef={viewportRef} displayTicks={ticks}
        dragPreview={null} draggingMode={null} draggingRowKey="" editable={false} maxMinutes={max}
        mediaDurationSeconds={0} playheadPercent={0} projectionMode="workflow" selectedRowKey={selected ?? ''}
        taskSpans={spans} timelineZoom={1} formatPositionLabel={label}
        onRulerPointerDown={() => {}} onSelectRowKey={onSelect} onSelectRowPosition={(_, position) => { const span = spans.find(span => position >= span.startMinutes && position < span.endMinutes) ?? spans.at(-1); if (span) onSelect(span.rowKey) }}
        onDropMedia={() => false} onTrackPointerStart={() => {}} />
    </section></div>
    <p>Suggested links: {rows.map(row => row.id).join(' → ')}. Activities can be revisited.</p>
    <nav aria-label={`Plan option ${rows[0].option} review steps`}>{rows.map(row => {
      const gap = timing.observations.find(item => item.id === row.id)?.gapDays
      return <div key={row.id} className="review-activity">
        <button type="button" aria-pressed={selected === row.id} onClick={() => onSelect(row.id)}
          title={`Fields: ${row.fields.map(field => field.label).join(', ')}`}>{row.order}. {row.task}</button>
        <p>{row.guidance}</p>
        <dl>{columns.filter(column => ['review-predecessor', 'review-successor', 'review-start', 'review-end'].includes(column.id)).map(column => {
          const value = String(row[column.value_key] || column.empty_label || 'Not entered')
          return <React.Fragment key={column.id}><dt title={column.definition}>{column.label.split(' · ').at(-1)}</dt>
            <dd>{column.id.startsWith('review-') && ['review-start', 'review-end'].includes(column.id) && row[column.value_key]
              ? <time dateTime={value}>{value}</time> : value}</dd></React.Fragment>
        })}</dl>
        {gap !== null && gap !== undefined && <p className="review-timing-observation">{gap === 0 ? 'Starts at the preceding activity’s exclusive end.'
          : `${gap < 0 ? 'Overlap' : 'Gap'}: ${Math.abs(gap)} calendar ${Math.abs(gap) === 1 ? 'day' : 'days'} relative to the preceding activity’s end.`}</p>}
      </div>
    })}</nav>
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
