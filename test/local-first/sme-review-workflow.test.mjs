import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSmeReviewRows, reviewTimingState, readSmeReviewDates, validReviewDates } from '../../public/local-first/sme-review-workflow.js'
import { verifyTimelineBundle } from '../../scripts/sme-review/build-timeline.mjs'
const protocol = { input_fields: [{ name: 'buyer_budget', label: 'Buyer budget' }] }
const project = slots => projectSmeReviewRows(slots.map(slot => ({ slot, inputs: { buyer_budget: 100 } })), protocol, (_, value) => value ?? 'Unknown')
test('one canonical dependency chain per option, with no inferred timing', () => {
  const rows = project(['A', 'B', 'C'])
  assert.equal(rows.length, 9)
  for (const option of ['A', 'B', 'C']) {
    const chain = rows.filter(row => row.option === option)
    assert.deepEqual(chain.map(row => [row.id, row.predecessor, row.successor]), [
      [`${option}:limits`, '', `${option}:transfer`], [`${option}:transfer`, `${option}:limits`, `${option}:questions`], [`${option}:questions`, `${option}:transfer`, '']])
  }
  assert.equal(rows[0].inputs, 'Buyer budget: 100')
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
  const rows = project(['A']), file = { schema: 'sme-review-records/v1', rows }
  file.rows[0].inputs = 'Imported instructions must not replace current inputs'
  assert.deepEqual(readSmeReviewDates(JSON.stringify(file), rows), Object.fromEntries(rows.map(row => [row.id, { start: '', end: '' }])))
  assert.throws(() => readSmeReviewDates(' '.repeat(65537), rows))
  assert.throws(() => readSmeReviewDates(JSON.stringify({ ...file, rows: [rows[0], rows[0], rows[2]] }), rows))
  assert.throws(() => readSmeReviewDates(JSON.stringify({ ...file, rows: [{ ...rows[0], start: '2026-13-01' }, ...rows.slice(1)] }), rows))
  assert.throws(() => readSmeReviewDates(JSON.stringify(file), project(['A', 'B'])))
})
test('native Graph artifact matches pinned owner and consumer digests within budget', () => {
  const pin = verifyTimelineBundle()
  assert(pin.inputs.some(input => input.path.endsWith('/timelineTransportMath.ts')))
  assert(pin.inputs.some(input => input.path.endsWith('/mermaidGanttTimelineModel.ts')))
  assert(pin.outputs.every(output => output.bytes < 500000))
})
