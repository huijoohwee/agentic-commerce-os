export const PACK_PATH = '/agentic-commerce-os/services/sme-business-pack'
export const PACK_INDEX = Object.freeze([
  Object.freeze({ id: 'sg.fnb.takeover', country: 'SG', asset_type: 'fnb', currency: 'SGD', version: '1.0.0', as_of: '2026-10-22', review_status: 'provisional' }),
  Object.freeze({ id: 'my.fnb.takeover', country: 'MY', asset_type: 'fnb', currency: 'MYR', version: '1.0.0', as_of: '2026-10-22', review_status: 'provisional' }),
])
export const TOOL_NAMES = Object.freeze(['pack.list', 'pack.required_fields', 'takeover.check_listing', 'takeover.transfer_checklist'])
const REQUIRED = Object.freeze([
  ['asset_subtype', 'Business type', ['cafe', 'restaurant', 'food_stall', 'bakery', 'other']],
  ['business_age_band', 'Business age band', ['under_1', '1_3', '3_5', '5_plus', 'unknown']],
  ['legal_form', 'Legal form', ['sole_proprietor', 'partnership', 'private_limited', 'unknown']],
  ['seating_band', 'Seating capacity band', 'band'], ['staff_band', 'Staff count band', 'band'],
  ['asking_price_band', 'Asking price band', 'money'], ['monthly_sales_band', 'Monthly sales band', 'money'],
  ['monthly_rent_band', 'Monthly rent band', 'money'], ['lease_remaining_band', 'Lease remaining band', 'band'],
  ['licence_status', 'Licence status', ['held', 'not_held', 'unknown']],
  ['equipment_included', 'Equipment included', 'boolean'], ['inventory_included', 'Inventory included', 'boolean'],
  ['sale_reason', 'Reason for sale', ['relocation', 'retirement', 'business_change', 'other', 'unknown']],
  ['handover_support_band', 'Handover support band', 'band'],
])
const OPTIONAL = Object.freeze([['country_code', 'Listing country code', ['SG', 'MY']]])
const moneyNames = new Set(['asking_price_band', 'monthly_sales_band', 'monthly_rent_band'])
const bands = Object.freeze(['b1', 'b2', 'b3', 'b4', 'b5'])

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code) { throw new Error(code) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function assertExactKeys(value, expected) {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('sme_pack_arguments_invalid')
}
function fieldRows(pack) {
  return [...REQUIRED, ...OPTIONAL].map(([name, label, values]) => {
    const row = { name, label, required: REQUIRED.some(item => item[0] === name) }
    if (values === 'boolean') return { ...row, type: 'boolean' }
    if (values === 'band') return { ...row, type: 'band', values: bands.map(code => ({ code, label: pack.closed_band_labels[name][code] })) }
    if (values === 'money') return { ...row, type: 'money_band', currency: pack.currency,
      bandBasis: pack.band_basis, values: bands.map(code => ({ code, min: pack.money_bands[name][code][0], max: pack.money_bands[name][code][1], label: pack.money_band_labels[name][code] })) }
    return { ...row, type: 'enum', values }
  })
}
export async function loadPack(packId) {
  const module = packId === 'sg.fnb.takeover' ? await import('./sme-pack-sg.js')
    : packId === 'my.fnb.takeover' ? await import('./sme-pack-my.js') : null
  if (!module?.PACK) fail('sme_pack_not_found')
  const pack = module.PACK, indexed = PACK_INDEX.find(item => item.id === packId)
  if (!indexed || ['country', 'asset_type', 'currency', 'version', 'as_of', 'review_status'].some(key => pack[key] !== indexed[key])) {
    fail('sme_pack_identity_mismatch')
  }
  return pack
}
function assertPackArgs(args) {
  assertExactKeys(args, ['pack_id'])
  if (typeof args.pack_id !== 'string' || !PACK_INDEX.some(item => item.id === args.pack_id)) fail('sme_pack_not_found')
}
function assertFactsArgs(args) {
  assertExactKeys(args, ['pack_id', 'facts'])
  if (typeof args.pack_id !== 'string' || !PACK_INDEX.some(item => item.id === args.pack_id)
    || !record(args.facts) || Object.keys(args.facts).length > 40) fail('sme_pack_arguments_invalid')
}
export async function invokeSmePackTool(name, args = {}, now = Date.now()) {
  if (!TOOL_NAMES.includes(name)) fail('sme_pack_tool_not_found')
  if (name === 'pack.list') {
    assertExactKeys(args, [])
    return { packs: clone(PACK_INDEX), inference_tokens: 0 }
  }
  assertPackArgs(name === 'takeover.check_listing' ? { pack_id: args?.pack_id } : args)
  const pack = await loadPack(args.pack_id)
  if (name === 'pack.required_fields') return { pack: clone(summary(pack)), fields: fieldRows(pack), inference_tokens: 0 }
  if (name === 'takeover.transfer_checklist') {
    const available = pack.review_status === 'reviewed' && Array.isArray(pack.transfer_checklist)
    return { pack: clone(summary(pack)), available, withheld: !available,
      reason: available ? null : 'qualified_reviewer_approval_required', checklist: available ? clone(pack.transfer_checklist) : [] }
  }
  assertFactsArgs(args)
  return checkListing(pack, args.facts, now)
}
function summary(pack) {
  return { id: pack.id, country: pack.country, asset_type: pack.asset_type, currency: pack.currency,
    version: pack.version, as_of: pack.as_of, review_status: pack.review_status, reviewer: pack.reviewer }
}
function validValue(name, value) {
  if (value === undefined || value === null || value === '') return false
  const definition = [...REQUIRED, ...OPTIONAL].find(item => item[0] === name)
  if (!definition) return false
  const options = definition[2]
  if (options === 'boolean') return typeof value === 'boolean'
  if (options === 'band' || options === 'money') return bands.includes(value)
  return options.includes(value)
}
function midpoint(pack, field, code) {
  const range = pack.money_bands[field]?.[code]
  return Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) ? (range[0] + range[1]) / 2 : null
}
function checkListing(pack, facts, now) {
  const accepted = Object.create(null), invalid = [], missing = []
  for (const [name] of REQUIRED) {
    const value = facts[name]
    if (value === undefined || value === null || value === '') { missing.push(name); continue }
    if (!validValue(name, value)) { invalid.push(name); continue }
    accepted[name] = value
  }
  if (Object.hasOwn(facts, 'country_code')) {
    if (!validValue('country_code', facts.country_code)) invalid.push('country_code')
    else accepted.country_code = facts.country_code
  }
  const flags = []
  if (accepted.country_code && accepted.country_code !== pack.country) flags.push({ code: 'pack_country_mismatch', field: 'country_code' })
  const ratio = pack.ratios.find(item => item.id === 'rent_to_sales')
  if (ratio && accepted[ratio.numerator] && accepted[ratio.denominator]) {
    const numerator = midpoint(pack, ratio.numerator, accepted[ratio.numerator])
    const denominator = midpoint(pack, ratio.denominator, accepted[ratio.denominator])
    if (numerator !== null && denominator > 0) {
      const value = Math.round(numerator / denominator * 10000) / 10000
      if (value > ratio.max_ratio) flags.push({ code: 'rent_midpoint_exceeds_sales_midpoint', ratio: ratio.id,
        value, basis: ratio.basis })
    }
  }
  const requiredCount = REQUIRED.length, supplied = requiredCount - missing.length - invalid.filter(name => REQUIRED.some(item => item[0] === name)).length
  return { schema: 'sme-business-pack/check-report/v1', pack: clone(summary(pack)),
    label: 'Indicative, not verified', disclaimer: 'Seller-reported inputs are not independently verified. This is not valuation, legal, tax, or transaction advice.',
    completeness: { required: requiredCount, supplied: Math.max(0, supplied), percent: Math.round(Math.max(0, supplied) / requiredCount * 100) },
    missing_fields: missing, invalid_fields: [...new Set(invalid)], unknown_fields_dropped: Object.keys(facts).filter(key => ![...REQUIRED, ...OPTIONAL].some(item => item[0] === key)).length,
    ratios: ratio ? [{ id: ratio.id, value: ratioValue(pack, ratio, accepted), basis: ratio.basis,
      status: accepted[ratio.numerator] && accepted[ratio.denominator] ? 'calculated' : 'missing_input' }] : [],
    flags, stale: Date.parse(pack.as_of) + 180 * 86400000 < now, inference_tokens: 0, persisted: false }
}
function ratioValue(pack, ratio, accepted) {
  if (!accepted[ratio.numerator] || !accepted[ratio.denominator]) return null
  const numerator = midpoint(pack, ratio.numerator, accepted[ratio.numerator])
  const denominator = midpoint(pack, ratio.denominator, accepted[ratio.denominator])
  return numerator === null || denominator === 0 ? null : Math.round(numerator / denominator * 10000) / 10000
}
