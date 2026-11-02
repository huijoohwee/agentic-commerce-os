import test from 'node:test'
import assert from 'node:assert/strict'
import { assessListing, parseComparison, SAMPLE_PROFILE, serializeComparison, validatePhotoBatch, validateProfile, validateSelection } from '../../public/local-first/housing-engine.js'
import { SAMPLE_LISTINGS } from '../../public/local-first/housing-sample.js'

test('comparison keeps unknown recurring and upfront costs visible', () => {
  const report = assessListing(SAMPLE_PROFILE, SAMPLE_LISTINGS[1])
  assert.equal(report.knownMonthly, 1280)
  assert.equal(report.monthlyComplete, false)
  assert.equal(report.upfrontComplete, false)
  assert(report.unknowns.some(value => value.includes('Recurring charges')))
})

test('comparison shows explicit totals, a date-count overhang, and qualification mismatch facts', () => {
  const report = assessListing({ ...SAMPLE_PROFILE, guarantor: 'no' }, SAMPLE_LISTINGS[2])
  assert.equal(report.knownMonthly, 1840)
  assert.equal(report.moveInKnown, 3520)
  assert.equal(report.overhangMonths, 3)
  assert.equal(report.overhangCost, 5160)
  assert.equal(report.status, 'Pause and verify')
  assert(report.mismatch.some(value => value.includes('guarantor')))
  assert(report.mismatch.some(value => value.includes('credit history')))
})

test('selection preserves order and accepts only one through three distinct available records', () => {
  assert.deepEqual(validateSelection(SAMPLE_LISTINGS, ['garden-court-studios', 'cedar-study-lofts']).map(item => item.id),
    ['garden-court-studios', 'cedar-study-lofts'])
  for (const ids of [[], ['missing'], ['cedar-study-lofts', 'cedar-study-lofts'], SAMPLE_LISTINGS.map(item => item.id).concat('fourth')]) {
    assert.throws(() => validateSelection(SAMPLE_LISTINGS, ids))
  }
})

test('local photo batches enforce a five-image and 5 MiB comparison cap', () => {
  const existing = Array.from({ length: 3 }, () => ({ size: 200000, hash: 'same' }))
  const next = Array.from({ length: 2 }, () => ({ size: 200000, type: 'image/png' }))
  assert.doesNotThrow(() => validatePhotoBatch(existing, next))
  assert.throws(() => validatePhotoBatch([...existing, ...next], [{ size: 100, type: 'image/png' }]), /up to 5/u)
  assert.throws(() => validatePhotoBatch([{ size: 5 * 1024 * 1024 }], [{ size: 1, type: 'image/png' }]), /5 MiB/u)
  assert.throws(() => validatePhotoBatch([], [{ size: 5 * 1024 * 1024 + 1, type: 'image/jpeg' }]), /5 MiB/u)
  assert.throws(() => validatePhotoBatch([], [{ size: 1, type: 'text/plain' }]), /JPEG, PNG or WebP/u)
})

test('profile accepts only the closed comparison fields and refuses identity or document fields', () => {
  assert.deepEqual(validateProfile(SAMPLE_PROFILE), SAMPLE_PROFILE)
  for (const key of ['name', 'email', 'passport', 'document']) {
    assert.throws(() => validateProfile({ ...SAMPLE_PROFILE, [key]: 'not collected' }))
  }
})

test('portable comparison exports only selected listing facts in selection order', () => {
  const ids = ['garden-court-studios', 'cedar-study-lofts']
  const value = JSON.parse(serializeComparison(SAMPLE_LISTINGS, ids))
  assert.deepEqual(Object.keys(value).sort(), ['listings', 'schema'])
  assert.equal(value.schema, 'commerce.housing-comparison/v1')
  assert.deepEqual(value.listings.map(item => item.id), ids)
  assert.deepEqual(parseComparison(JSON.stringify(value)), ids.map(id => SAMPLE_LISTINGS.find(item => item.id === id)))
  assert(!JSON.stringify(value).includes('North Campus'))
})

test('portable comparison import rejects malformed, oversized, extra, duplicate and invalid records', () => {
  const valid = serializeComparison(SAMPLE_LISTINGS, ['cedar-study-lofts', 'harborline-rooms'])
  const payload = JSON.parse(valid)
  for (const value of ['{', ' '.repeat(65537), JSON.stringify({ ...payload, profile: SAMPLE_PROFILE }),
    JSON.stringify({ ...payload, listings: [payload.listings[0], payload.listings[0]] }),
    JSON.stringify({ ...payload, listings: [{ ...payload.listings[0], contact: 'ignored' }] })]) {
    assert.throws(() => parseComparison(value))
  }
  const multibyte = JSON.stringify({ ...payload, note: '😀'.repeat(16384) })
  assert(multibyte.length < 65536)
  assert(new TextEncoder().encode(multibyte).length > 65536)
  assert.throws(() => parseComparison(multibyte), /under 64 KiB/u)
  assert.throws(() => serializeComparison(SAMPLE_LISTINGS, []))
})
