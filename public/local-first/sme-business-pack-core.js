export const PACK_PATH = '/agentic-commerce-os/services/sme-business-pack'
const PACK_REGISTRY = Object.freeze([
  Object.freeze({ metadata: Object.freeze({ id: 'sg.fnb.takeover', country: 'SG', asset_type: 'fnb', currency: 'SGD',
    version: '1.0.0', as_of: '2026-10-22', review_status: 'provisional' }), load: () => import('./sme-pack-sg.js') }),
])
export const PACK_INDEX = Object.freeze(PACK_REGISTRY.map(entry => entry.metadata))
export const TOOL_NAMES = Object.freeze(['pack.list', 'pack.protocol', 'takeover.check', 'takeover.budget', 'takeover.plan', 'takeover.compare_claim_sets', 'takeover.transfer_checklist'])
export const LEGACY_TOOL_NAMES = Object.freeze(['pack.required_fields', 'takeover.check_listing'])
const provenanceTiers = Object.freeze({ seller_stated: 0, buyer_assumed: 0, observed_on_site: 1, measured_on_foot: 1,
  counted_on_site: 1, document_sighted: 2, third_party_confirmed: 3 })
const roles = Object.freeze(['buyer', 'adviser', 'field_checker'])
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
  const entry = PACK_REGISTRY.find(row => row.metadata.id === packId), module = entry ? await entry.load() : null
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
  if (!TOOL_NAMES.includes(name) && !LEGACY_TOOL_NAMES.includes(name)) fail('sme_pack_tool_not_found')
  if (name === 'pack.list') {
    assertExactKeys(args, [])
    return { packs: clone(PACK_INDEX), inference_tokens: 0 }
  }
  if (name === 'takeover.check' || name === 'takeover.budget' || name === 'takeover.plan') {
    const { pack, input } = await validatedCashInput(args)
    const check = cashCheck(pack, input, now), budget = cashBudget(pack, input, now)
    if (name === 'takeover.check') return check
    if (name === 'takeover.budget') return budget
    return cashPlan(pack, input, check, budget)
  }
  if (name === 'takeover.compare_claim_sets') return compareClaimSets(args, now)
  assertPackArgs(name === 'takeover.check_listing' ? { pack_id: args?.pack_id } : args)
  const pack = await loadPack(args.pack_id)
  if (name === 'pack.protocol') return protocol(pack)
  if (name === 'pack.required_fields') return { pack: clone(summary(pack)), fields: fieldRows(pack), inference_tokens: 0 }
  if (name === 'takeover.transfer_checklist') {
    const available = pack.review_status === 'reviewed' && Array.isArray(pack.transfer_checklist)
    return { pack: clone(summary(pack)), available, withheld: !available,
      reason: available ? null : 'qualified_reviewer_approval_required', checklist: available ? clone(pack.transfer_checklist) : [] }
  }
  assertFactsArgs(args)
  return checkListing(pack, args.facts, now)
}

const moneyValueSchema = { oneOf: [
  { type: 'integer', minimum: 0, maximum: 100000000 },
  { type: 'object', required: ['low', 'high'], properties: {
    low: { type: 'integer', minimum: 0, maximum: 100000000 },
    high: { type: 'integer', minimum: 0, maximum: 100000000 },
  }, additionalProperties: false },
] }
const PACK_ID_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$', FIELD_ID_PATTERN = '^[a-z][a-z0-9_]{0,63}$'
const fieldValueSchema = { oneOf: [moneyValueSchema, { type: 'boolean' }, { type: 'string', maxLength: 80 }] }
const claimsSchema = { type: 'object', maxProperties: 32,
  patternProperties: { [FIELD_ID_PATTERN]: fieldValueSchema }, additionalProperties: false }
const packIdSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: PACK_ID_PATTERN }
const packInput = { type: 'object', required: ['pack_id'], properties: { pack_id: packIdSchema }, additionalProperties: false }
const cashInput = { type: 'object', required: ['pack_id', 'claims'], properties: {
  pack_id: packIdSchema, claims: claimsSchema,
  evidence: { type: 'array', maxItems: 40, items: { type: 'object',
    required: ['claim_kind', 'provenance', 'observer_role', 'date', 'value'], properties: {
      claim_kind: { type: 'string', maxLength: 64, pattern: FIELD_ID_PATTERN }, provenance: { type: 'string', enum: Object.keys(provenanceTiers) },
      observer_role: { type: 'string', enum: roles }, date: { type: 'string', format: 'date' },
      value: fieldValueSchema,
    }, additionalProperties: false } },
}, additionalProperties: false }
const comparisonSet = { type: 'object', required: ['pack_id', 'pack_version', 'currency', 'claims'], properties: {
  pack_id: packIdSchema, pack_version: { type: 'string', minLength: 1, maxLength: 32 },
  currency: { type: 'string', pattern: '^[A-Z]{3}$' }, claims: claimsSchema,
  evidence: cashInput.properties.evidence,
}, additionalProperties: false }
const newToolInputs = Object.freeze({
  'pack.list': { type: 'object', properties: {}, additionalProperties: false },
  'pack.protocol': packInput,
  'takeover.check': cashInput, 'takeover.budget': cashInput, 'takeover.plan': cashInput,
  'takeover.compare_claim_sets': { type: 'object', required: ['claim_sets'], properties: {
    claim_sets: { type: 'array', minItems: 2, maxItems: 3, items: comparisonSet },
  }, additionalProperties: false },
  'takeover.transfer_checklist': packInput,
})
export const TOOL_SCHEMAS = Object.freeze(TOOL_NAMES.map(name => Object.freeze({
  name, inputSchema: newToolInputs[name],
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
})))

async function compareClaimSets(args, now) {
  assertExactKeys(args, ['claim_sets'])
  const bytes = new TextEncoder().encode(JSON.stringify(args)).byteLength
  if (bytes > 32768 || !Array.isArray(args.claim_sets) || args.claim_sets.length < 2 || args.claim_sets.length > 3) {
    fail('sme_pack_arguments_invalid')
  }
  const sets = args.claim_sets
  for (const set of sets) {
    const keys = Object.hasOwn(set ?? {}, 'evidence')
      ? ['pack_id', 'pack_version', 'currency', 'claims', 'evidence'] : ['pack_id', 'pack_version', 'currency', 'claims']
    assertExactKeys(set, keys)
    if (typeof set.pack_id !== 'string' || typeof set.pack_version !== 'string' || typeof set.currency !== 'string') {
      fail('sme_pack_arguments_invalid')
    }
  }
  const identity = sets[0]
  if (sets.some(set => set.pack_id !== identity.pack_id || set.pack_version !== identity.pack_version || set.currency !== identity.currency)) {
    fail('sme_pack_comparison_identity_mismatch')
  }
  const pack = await loadPack(identity.pack_id)
  if (identity.pack_version !== pack.version || identity.currency !== pack.currency) fail('sme_pack_comparison_identity_mismatch')
  const slots = []
  for (let index = 0; index < sets.length; index++) {
    const set = sets[index], input = { pack_id: set.pack_id, claims: set.claims,
      ...(Object.hasOwn(set, 'evidence') ? { evidence: set.evidence } : {}) }
    slots.push({ slot: ['A', 'B', 'C'][index], status: 'included', report: await invokeSmePackTool('takeover.plan', input, now) })
  }
  if (slots.length === 2) slots.push({ slot: 'C', status: 'not_supplied', report: null })
  const result = { schema: 'sme-business-pack/comparison-report/v1', pack: clone(summary(pack)), slots,
    inference_tokens: 0, persisted: false }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) fail('sme_pack_response_too_large')
  return result
}

function protocol(pack) {
  return { schema: 'sme-business-pack/protocol/v1', pack: clone(summary(pack)),
    claim_kinds: clone(pack.claim_kinds), budget_lines: clone(pack.budget_lines),
    parameters: clone(pack.parameters ?? []), ratios: clone(pack.ratios ?? []),
    protocols: clone(pack.protocols), tolerances: clone(pack.tolerances ?? []),
    review_note: 'Pack content and task guidance are provisional; no market parameter or comparison tolerance is supplied.',
    inference_tokens: 0 }
}
function claimDefinitions(pack) { return Object.fromEntries(pack.claim_kinds.map(field => [field.name, field])) }
function validCashValue(definition, value) {
  if (definition.type === 'money') {
    const validAmount = amount => Number.isSafeInteger(amount) && amount >= 0 && amount <= 100000000
    if (validAmount(value)) return value
    if (record(value)) {
      assertExactKeys(value, ['low', 'high'])
      if (validAmount(value.low) && validAmount(value.high) && value.low <= value.high) return { low: value.low, high: value.high }
    }
    return null
  }
  if (definition.type === 'integer') return Number.isSafeInteger(value) && value >= definition.min && value <= definition.max ? value : null
  if (definition.type === 'boolean') return typeof value === 'boolean' ? value : null
  if (definition.type === 'enum') return definition.values.includes(value) ? value : null
  return null
}
function validateEvidence(pack, rows) {
  if (rows === undefined) return []
  if (!Array.isArray(rows) || rows.length > 40) fail('sme_pack_arguments_invalid')
  const definitions = claimDefinitions(pack), cleaned = []
  for (const row of rows) {
    assertExactKeys(row, ['claim_kind', 'provenance', 'observer_role', 'date', 'value'])
    const definition = definitions[row.claim_kind]
    if (!definition?.retiring_tier || !(row.provenance in provenanceTiers) || !roles.includes(row.observer_role)
      || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(row.date)
      || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date
      || validCashValue(definition, row.value) === null) fail('sme_pack_evidence_invalid')
    cleaned.push({ claim_kind: row.claim_kind, provenance: row.provenance, observer_role: row.observer_role,
      date: row.date, value: clone(row.value) })
  }
  return cleaned
}
async function validatedCashInput(args) {
  if (!record(args)) fail('sme_pack_arguments_invalid')
  const expected = Object.hasOwn(args, 'evidence') ? ['pack_id', 'claims', 'evidence'] : ['pack_id', 'claims']
  assertExactKeys(args, expected)
  if (typeof args.pack_id !== 'string' || !PACK_INDEX.some(pack => pack.id === args.pack_id) || !record(args.claims)
    || Object.keys(args.claims).length > 32 || new TextEncoder().encode(JSON.stringify(args)).byteLength > 32768) {
    fail('sme_pack_arguments_invalid')
  }
  const pack = await loadPack(args.pack_id), definitions = claimDefinitions(pack), claims = Object.create(null), invalid = []
  let unknown = 0
  for (const [key, value] of Object.entries(args.claims)) {
    const definition = definitions[key]
    if (!definition) {
      if (/name|address|contact|email|phone|url/iu.test(key) || typeof value === 'string' || record(value) || Array.isArray(value)) {
        fail('sme_pack_free_text_refused')
      }
      unknown++; continue
    }
    if (typeof value === 'string') {
      if (definition.type !== 'enum' || /https?:\/\/|www\.|@/iu.test(value) || !definition.values.includes(value)) {
        fail('sme_pack_free_text_refused')
      }
    }
    const normalized = validCashValue(definition, value)
    if (normalized === null) invalid.push(key)
    else claims[key] = clone(normalized)
  }
  const missing = pack.claim_kinds.filter(field => field.required && !Object.hasOwn(claims, field.name)).map(field => field.name)
  return { pack, input: { claims, evidence: validateEvidence(pack, args.evidence), missing, invalid: [...new Set(invalid)], unknown } }
}
function amountRange(value) {
  if (typeof value === 'number') return { low: value, high: value }
  return value ? { low: value.low, high: value.high } : null
}
function addRanges(left, right) {
  if (!left || !right) return null
  const low = left.low + right.low, high = left.high + right.high
  return Number.isSafeInteger(low) && Number.isSafeInteger(high) ? { low, high } : null
}
function multiplyRanges(left, right) {
  if (!left || !right) return null
  const low = left.low * right.low, high = left.high * right.high
  return Number.isSafeInteger(low) && Number.isSafeInteger(high) ? { low, high } : null
}
function tierForEvidence(kind, entries) {
  return entries.filter(row => row.claim_kind === kind).reduce((highest, row) => Math.max(highest, provenanceTiers[row.provenance]), 0)
}
function tierLabel(tier) { return 'T' + tier }
function lineChecked(line, input, tiers) {
  return line.claim_kinds.filter(kind => input.definitions[kind]?.owner !== 'buyer')
    .every(kind => tiers[kind] >= Number(line.retiring_tier.slice(1)))
}
function cashLines(pack, input) {
  const c = input.claims, rent = amountRange(c.rent_monthly), payroll = amountRange(c.payroll_monthly)
  const utilities = amountRange(c.utilities_monthly), fixed = addRanges(addRanges(rent, payroll), utilities)
  const month = name => Number.isSafeInteger(c[name]) ? { low: c[name], high: c[name] } : null
  const raw = {
    L1: amountRange(c.price), L2: amountRange(c.equipment_cost),
    L3: multiplyRanges(rent, month('deposit_months')), L4: amountRange(c.utilities_deposits),
    L5: amountRange(c.transfer_cost), L6: amountRange(c.repairs_provision),
    L7: multiplyRanges(month('runway_months'), fixed),
  }
  return { lines: pack.budget_lines.map(line => ({ ...clone(line), range: raw[line.id] || null,
    complete: Boolean(raw[line.id]), missing_claims: line.claim_kinds.filter(kind => c[kind] === undefined) })), fixed }
}
function cashCheck(pack, input, now) {
  const definitions = claimDefinitions(pack), tiers = Object.create(null), differences = []
  const tierCounts = { T0: 0, T1: 0, T2: 0, T3: 0 }, results = []
  for (const field of pack.claim_kinds) {
    if (!Object.hasOwn(input.claims, field.name)) continue
    const entries = input.evidence.filter(row => row.claim_kind === field.name)
    const tier = tierForEvidence(field.name, entries); tiers[field.name] = tier; tierCounts[tierLabel(tier)]++
    const raw = entries.filter(row => provenanceTiers[row.provenance] > 0
      && JSON.stringify(row.value) !== JSON.stringify(input.claims[field.name]))
      .map(row => ({ provenance: row.provenance, tier: tierLabel(provenanceTiers[row.provenance]),
        claimed: input.claims[field.name], observed: row.value }))
    differences.push(...raw.map(row => ({ claim_kind: field.name, ...row })))
    results.push({ claim_kind: field.name, status: 'unsupported', tier: tierLabel(tier),
      reason: entries.some(row => provenanceTiers[row.provenance] > 0)
        ? 'provisional_comparator_not_available' : 'no_independent_evidence', raw_differences: raw })
  }
  for (const field of pack.claim_kinds) if (!Object.hasOwn(input.claims, field.name)) tiers[field.name] = 0
  const parts = cashLines(pack, { ...input, definitions })
  const lines = parts.lines.map(line => ({ ...line, checked: line.complete && lineChecked(line, { ...input, definitions }, tiers),
    evidence_basis: 'tier only; pack remains provisional' }))
  return { schema: 'sme-business-pack/check-report/v2', pack: clone(summary(pack)), label: 'Indicative, not verified',
    disclaimer: 'Buyer-reported inputs and sighted evidence are not authenticated. This arithmetic is not valuation, legal, tax, or transaction advice.',
    completeness: { required: pack.claim_kinds.filter(field => field.required).length,
      supplied: pack.claim_kinds.filter(field => field.required && Object.hasOwn(input.claims, field.name)).length,
      missing_claims: input.missing, invalid_claims: input.invalid },
    evidence_results: results, claim_counts_by_tier: tierCounts, raw_differences: differences,
    lines, unknown_fields_dropped: input.unknown, stale: Date.parse(pack.as_of) + 180 * 86400000 < now,
    inference_tokens: 0, persisted: false, tolerances_applied: false }
}
function rangeMidpoint(range) { return range ? (range.low + range.high) / 2 : null }
function percentRange(numerator, denominator) {
  if (!numerator || !denominator || denominator.low <= 0) return null
  return { low: Math.round(numerator.low / denominator.high * 10000) / 10000,
    high: Math.round(numerator.high / denominator.low * 10000) / 10000 }
}
function cashBudget(pack, input, now) {
  const check = cashCheck(pack, input, now), parts = cashLines(pack, { ...input, definitions: claimDefinitions(pack) })
  const known = parts.lines.filter(line => line.range)
  const sum = known.reduce((total, line) => addRanges(total, line.range), { low: 0, high: 0 })
  const complete = known.length === parts.lines.length && Boolean(sum)
  const price = amountRange(input.claims.price), sales = amountRange(input.claims.monthly_sales)
  const rent = amountRange(input.claims.rent_monthly)
  const cash = complete ? { ...sum, incomplete: false, basis: 'complete-user-input-range' }
    : { low: known.length ? sum?.low ?? null : null, high: null, incomplete: true,
      basis: known.length ? 'known-subtotal-lower-bound' : 'no-known-lines' }
  const gap = complete && price ? { low: sum.low - price.high, high: sum.high - price.low } : null
  const leaseMonths = Number.isSafeInteger(input.claims.lease_remaining_months)
    ? { low: input.claims.lease_remaining_months, high: input.claims.lease_remaining_months } : null
  const lease = multiplyRanges(leaseMonths, rent), bps = input.claims.variable_cost_bps
  let breakEven = null, runway = null
  if (parts.fixed && Number.isSafeInteger(bps) && bps < 10000) {
    const denominator = 10000 - bps
    breakEven = { low: Math.ceil(parts.fixed.low * 10000 / denominator), high: Math.ceil(parts.fixed.high * 10000 / denominator) }
  }
  if (parts.fixed && sales && Number.isSafeInteger(bps) && bps < 10000) {
    const contribution = { low: Math.floor(sales.low * (10000 - bps) / 10000),
      high: Math.ceil(sales.high * (10000 - bps) / 10000) }
    const shortfall = { low: parts.fixed.low - contribution.high, high: parts.fixed.high - contribution.low }
    const working = parts.lines.find(line => line.id === 'L7')?.range
    runway = shortfall.high <= 0 ? { status: 'no_monthly_shortfall', months: null }
      : shortfall.low <= 0 || !working ? { status: 'range_crosses_zero_or_incomplete', months: null }
        : { status: 'calculated', months: { low: Math.floor(working.low / shortfall.high * 100) / 100,
          high: Math.ceil(working.high / shortfall.low * 100) / 100 } }
  }
  const share = complete ? (() => {
    const denominator = known.reduce((total, line) => total + rangeMidpoint(line.range), 0)
    const unchecked = known.filter(line => !check.lines.find(row => row.id === line.id)?.checked)
      .reduce((total, line) => total + rangeMidpoint(line.range), 0)
    return denominator === 0 ? 0 : Math.round(unchecked / denominator * 10000) / 10000
  })() : null
  const ratios = { rent_to_sales: percentRange(rent, sales),
    payroll_to_sales: percentRange(amountRange(input.claims.payroll_monthly), sales) }
  const arithmeticFlags = [], rentRule = pack.ratios.find(rule => rule.id === 'rent_to_sales')
  const rentRatio = ratios.rent_to_sales
  if (rentRule && rentRatio && rentRatio.high > rentRule.max_ratio) arithmeticFlags.push({
    code: 'rent_to_sales_arithmetic_bound', ratio: rentRule.id,
    observation: rentRatio.low > rentRule.max_ratio ? 'above' : 'range_crosses', value: rentRatio,
    limit: rentRule.max_ratio, basis: rentRule.basis, reviewed: rentRule.reviewed,
    kind: 'arithmetic_observation',
  })
  if (breakEven && sales && breakEven.low > sales.high) arithmeticFlags.push({
    code: 'break_even_above_claimed_sales', kind: 'arithmetic_observation',
  })
  const budgetLines = parts.lines.map(line => ({ id: line.id, label: line.label, low: line.range?.low ?? null,
    high: line.range?.high ?? null, complete: line.complete, missing_claims: line.missing_claims,
    retiring_tier: line.retiring_tier, checked: check.lines.find(row => row.id === line.id)?.checked ?? false,
    review_status: pack.review_status, formula: line.formula || null }))
  return { schema: 'sme-business-pack/budget-report/v1', pack: clone(summary(pack)), label: 'Indicative, not verified',
    disclaimer: 'Cash amounts use buyer-entered claims only. Missing lines are unknown, not zero; no pack estimate or professional advice is included.',
    budget: { incomplete: !complete, cash_to_close: cash, gap_above_asking_price: gap,
      monthly_fixed_cost: parts.fixed, break_even_monthly_sales: breakEven,
      lease_exposure: lease ? { ...lease, basis: 'remaining lease months × claimed rent' } : null,
      opening_runway: runway, unchecked_share: share,
      unchecked_share_basis: share === null ? 'incomplete budget' : 'cash-line midpoint by provisional retiring tier',
      lines: budgetLines, ratios, arithmetic_flags: arithmeticFlags },
    claim_counts_by_tier: check.claim_counts_by_tier, stale: Date.parse(pack.as_of) + 180 * 86400000 < now,
    inference_tokens: 0, persisted: false }
}
function csvCell(value) { return '"' + String(value ?? '').replaceAll('"', '""') + '"' }
function cashPlan(pack, input, check, budget) {
  const tiers = Object.fromEntries(check.evidence_results.map(row => [row.claim_kind, Number(row.tier.slice(1))]))
  const tasks = budget.budget.lines.filter(line => line.complete && !line.checked).map(line => {
    const source = pack.budget_lines.find(row => row.id === line.id)
    const outstanding = source.claim_kinds.filter(kind => pack.claim_kinds.find(field => field.name === kind)?.owner !== 'buyer'
      && (tiers[kind] ?? 0) < Number(source.retiring_tier.slice(1)))
    return { line_id: line.id, label: line.label, cash_retired_midpoint: rangeMidpoint({ low: line.low, high: line.high }),
      claim_kinds: outstanding, tasks: outstanding.map(kind => pack.protocols.find(row => row.claim_kind === kind)).filter(Boolean) }
  }).sort((left, right) => right.cash_retired_midpoint - left.cash_retired_midpoint || left.line_id.localeCompare(right.line_id))
    .map((task, index) => ({ order: index + 1, ...task }))
  const worksheet = { schema: 'sme-business-pack/worksheet/v1', pack_id: pack.id,
    claims: clone(input.claims), evidence: clone(input.evidence) }
  const json = JSON.stringify(worksheet, null, 2), rows = [['kind', 'key', 'value', 'provenance', 'observer_role', 'date']]
  for (const [key, value] of Object.entries(worksheet.claims)) rows.push(['claim', key, JSON.stringify(value), '', '', ''])
  for (const row of worksheet.evidence) rows.push(['evidence', row.claim_kind, JSON.stringify(row.value), row.provenance, row.observer_role, row.date])
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n')
  const fence = String.fromCharCode(96).repeat(3)
  const markdown = '# SME takeover worksheet\n\nIndicative, not verified. Evidence is sighted, not authenticated.\n\n'
    + '| Kind | Field | Value | Provenance | Observer | Date |\n|---|---|---|---|---|---|\n'
    + rows.slice(1).map(row => '| ' + row.map(value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |').join('\n')
    + '\n\n' + fence + 'json\n' + json + '\n' + fence + '\n'
  return { schema: 'sme-business-pack/plan-report/v1', pack: clone(summary(pack)), label: 'Indicative, not verified',
    check, budget, tasks, worksheet: { json, csv, markdown }, evidence_status: 'provisional; raw differences only',
    inference_tokens: 0, persisted: false }
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
