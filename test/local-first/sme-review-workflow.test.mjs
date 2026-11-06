import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSmeReviewRows, reviewTimingState, readSmeReviewDates, validReviewDates } from '../../public/local-first/sme-review-workflow.js'
import { invokeSmePackTool } from '../../public/local-first/sme-business-pack-core.js'
import { createSmeWorkflowFieldView, createSmePackDictionaryView } from '../../public/local-first/sme-pack-dictionary.js'
import { verifyTimelineBundle } from '../../scripts/sme-review/build-timeline.mjs'
const protocol = await invokeSmePackTool('pack.protocol', { pack_id: 'sme.takeover-checker' })
const project = slots => projectSmeReviewRows(slots.map(slot => ({ slot, inputs: { buyer_budget: 100 } })), protocol, (_, value) => value ?? 'Unknown')
test('one canonical dependency chain per option, with no inferred timing', () => {
  const rows = project(['A', 'B', 'C'])
  assert.equal(rows.length, 9)
  for (const option of ['A', 'B', 'C']) {
    const chain = rows.filter(row => row.option === option)
    assert.deepEqual(chain.map(row => [row.id, row.predecessor, row.successor]), [
      [`${option}:limits`, '', `${option}:transfer`], [`${option}:transfer`, `${option}:limits`, `${option}:questions`], [`${option}:questions`, `${option}:transfer`, '']])
  }
  assert.match(rows[0].inputs, /Stated buyer budget: 100/)
  assert.deepEqual(rows.filter(row => row.option === 'A').flatMap(row => row.field_keys).sort(), protocol.input_fields.map(field => field.name).sort())
  assert(rows[0].fields.every(field => protocol.input_fields.includes(field)))
  assert(rows.every(row => row.start === '' && row.end === ''))
  assert.equal(reviewTimingState(rows).dated, false)
})
test('dates remain optional; invalid dates and predecessor overlap never become a calendar schedule', () => {
  assert.equal(validReviewDates({ start: '2026-02-30', end: '' }), false)
  assert.equal(validReviewDates({ start: '2026-11-06', end: '2026-11-05' }), false)
  const rows = project(['A']).map((row, i) => ({ ...row, start: `2026-11-0${i + 1}`, end: `2026-11-0${i + 2}` }))
  assert.equal(reviewTimingState(rows).dated, true)
  rows[1].start = '2026-11-01'; assert.equal(reviewTimingState(rows).dated, false)
  rows[1].start = ''; assert.equal(reviewTimingState(rows).dated, false)
})
test('review imports accept only matching bounded row identities and timing; financial inputs stay authoritative', () => {
  const rows = project(['A']), file = { schema: protocol.review_workflow.exchange.schema, pack_id: protocol.pack.id, pack_version: protocol.pack.version, mode: 'buy_build', rows: rows.map(row => ({ id: row.id, 'review-start': '', 'review-end': '' })) }
  assert.deepEqual(readSmeReviewDates(JSON.stringify(file), rows, protocol), Object.fromEntries(rows.map(row => [row.id, { start: '', end: '' }])))
  assert.throws(() => readSmeReviewDates(' '.repeat(65537), rows, protocol))
  assert.throws(() => readSmeReviewDates(JSON.stringify({ ...file, rows: [file.rows[0], file.rows[0], file.rows[2]] }), rows, protocol))
  assert.throws(() => readSmeReviewDates(JSON.stringify({ ...file, rows: [{ ...file.rows[0], 'review-start': '2026-13-01' }, ...file.rows.slice(1)] }), rows, protocol))
  assert.throws(() => readSmeReviewDates(JSON.stringify(file), project(['A', 'B']), protocol))
})
test('Plan options and Review steps reuse exact field records, definitions and values; dictionary covers every view field', () => {
  const slots = [{ slot: 'A', inputs: { buyer_budget: 100 } }], dimensions = protocol.workflow_columns.map(field => ({ id: field.id, name: field.label, field, read: () => 'same view state' }))
  const args = { protocol, slots, dimensions, resultSlots: slots, format: (_, value) => value ?? 'Unknown', requirement: () => 'optional', enumLabel: value => value, rowLabel: () => 'Plan option A' }
  const plan = createSmeWorkflowFieldView(args), review = createSmeWorkflowFieldView({ ...args, review: true })
  assert.deepEqual(review.columns, plan.columns)
  const records = view => view.rows.filter(row => !row.id.startsWith('group:')).map(({id,cells}) => ({id,cells})).sort((a,b) => a.id.localeCompare(b.id))
  assert.deepEqual(records(review), records(plan))
  const dictionary = createSmePackDictionaryView(protocol)
  for (const field of [...protocol.input_fields.map(field => field.name), ...protocol.workflow_columns.map(field => field.id)])
    assert(dictionary.rows.some(row => row.cells[1] === field), field)
  const start = records(plan).find(row => row.id === 'output:review-start')
  assert.equal(start.cells[5], 'date'); assert.equal(start.cells[13], protocol.workflow_columns.find(field => field.id === 'review-start').definition)
  assert.throws(() => projectSmeReviewRows(slots, { ...protocol, input_fields: [{ ...protocol.input_fields[0], review_step: 'missing' }] }, String))
  assert.equal(protocol.input_fields.length,38); assert.equal(1 + 38 + 1 + 16 + 1 + 4,61)
})
test('native Graph artifact matches pinned owner and consumer digests within budget', () => {
  const pin = verifyTimelineBundle()
  assert(pin.inputs.some(input => input.path.endsWith('/timelineTransportMath.ts')))
  assert(pin.inputs.some(input => input.path.endsWith('/mermaidGanttTimelineModel.ts')))
  assert(pin.outputs.every(output => output.bytes < 500000))
})
