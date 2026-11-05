export const PACK_PATH = '/agentic-commerce-os/services/sme-business-pack'
const PACK_REGISTRY = Object.freeze([
  Object.freeze({ metadata: Object.freeze({ id: 'sme.business-plan', label: 'General business plan',
    version: '2.3.0', as_of: '2026-11-04', review_status: 'provisional' }),
  load: () => import('./sme-pack-business-plan.js?v=business-plan-pack-v2-3-0') }),
  Object.freeze({ metadata: Object.freeze({ id: 'sme.takeover-checker', label: 'SME takeover checker',
    version: '1.0.0', as_of: '2026-11-05', review_status: 'provisional' }),
  load: async () => ({ PACK: (await import('./sme-pack-business-plan.js?v=business-plan-pack-v2-3-0')).TAKEOVER_PACK }) }),
])
export const PACK_INDEX = Object.freeze(PACK_REGISTRY.map(entry => entry.metadata))
export const TOOL_NAMES = Object.freeze(['pack.list', 'pack.protocol', 'business.plan.build', 'business.plan.compare'])
const provenanceTypes = Object.freeze(['assumption', 'self_reported', 'directly_observed', 'counted', 'document_reviewed', 'independently_reported'])
const observerRoles = Object.freeze(['author', 'observer', 'reviewer'])
const TEXT_PATTERN = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[A-Z]{2,}|(?:\+?\d[\d ().-]{7,}\d))/iu
const MAX_MONEY = 1000000000
const MAX_TEXT = 280

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code) { throw new Error(code) }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function assertExactKeys(value, expected) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('sme_pack_arguments_invalid')
}
function summary(pack) {
  return { id: pack.id, label: pack.label, version: pack.version, as_of: pack.as_of,
    review_status: pack.review_status, reviewer: pack.reviewer }
}
function definitions(pack) { return Object.fromEntries(pack.input_fields.map(field => [field.name, field])) }
function packEntry(packId) { return PACK_REGISTRY.find(entry => entry.metadata.id === packId) }

export async function loadPack(packId) {
  const entry = packEntry(packId), module = entry ? await entry.load() : null
  if (!module?.PACK) fail('sme_pack_not_found')
  const pack = module.PACK, indexed = entry.metadata
  if (['id', 'label', 'version', 'as_of', 'review_status'].some(key => pack[key] !== indexed[key])) fail('sme_pack_identity_mismatch')
  return pack
}

const amountSchema = { oneOf: [
  { type: 'number', minimum: 0, maximum: MAX_MONEY, multipleOf: 0.0001 },
  { type: 'object', required: ['low', 'high'], properties: {
    low: { type: 'number', minimum: 0, maximum: MAX_MONEY, multipleOf: 0.0001 },
    high: { type: 'number', minimum: 0, maximum: MAX_MONEY, multipleOf: 0.0001 },
  }, additionalProperties: false },
] }
const keyPattern = '^[a-z][a-z0-9_]{0,63}$'
const packIdSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' }
const inputValueSchema = { oneOf: [amountSchema, { type: 'integer', minimum: 0, maximum: 100000000 },
  { type: 'string', maxLength: MAX_TEXT }] }
const inputsSchema = { type: 'object', maxProperties: 32, patternProperties: { [keyPattern]: inputValueSchema }, additionalProperties: false }
const evidenceSchema = { type: 'array', maxItems: 40, items: { type: 'object', required: ['field_key', 'provenance', 'observer_role', 'date', 'value'],
  properties: { field_key: { type: 'string', maxLength: 64, pattern: keyPattern }, provenance: { type: 'string', enum: provenanceTypes },
    observer_role: { type: 'string', enum: observerRoles }, date: { type: 'string', format: 'date' }, value: inputValueSchema }, additionalProperties: false } }
const modeSchema = { type: 'string', enum: ['buy_build', 'scenario'], default: 'buy_build' }
const buildSchema = { type: 'object', required: ['pack_id', 'inputs'], properties: { pack_id: packIdSchema, mode: modeSchema, inputs: inputsSchema, evidence: evidenceSchema }, additionalProperties: false }
const compareSchema = { type: 'object', required: ['plan_sets'], properties: { mode: modeSchema, plan_sets: { type: 'array', minItems: 2, maxItems: 3,
  items: { type: 'object', required: ['pack_id', 'pack_version', 'inputs'], properties: {
    pack_id: packIdSchema, pack_version: { type: 'string', minLength: 1, maxLength: 32 }, inputs: inputsSchema, evidence: evidenceSchema,
  }, additionalProperties: false } } }, additionalProperties: false }
const inputs = Object.freeze({
  'pack.list': { type: 'object', properties: {}, additionalProperties: false },
  'pack.protocol': { type: 'object', required: ['pack_id'], properties: { pack_id: packIdSchema }, additionalProperties: false },
  'business.plan.build': buildSchema,
  'business.plan.compare': compareSchema,
})
export const TOOL_SCHEMAS = Object.freeze(TOOL_NAMES.map(name => Object.freeze({ name, inputSchema: inputs[name],
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }) })))

export async function invokeSmePackTool(name, args = {}, now = Date.now()) {
  if (!TOOL_NAMES.includes(name)) fail('sme_pack_tool_not_found')
  if (name === 'pack.list') {
    assertExactKeys(args, [])
    return { packs: clone(PACK_INDEX), inference_tokens: 0 }
  }
  if (name === 'pack.protocol') {
    assertExactKeys(args, ['pack_id'])
    const pack = await loadPack(args.pack_id)
    return { schema: 'sme-business-plan/protocol/v3', pack: clone(summary(pack)), plan_modes: clone(pack.plan_modes), input_fields: clone(pack.input_fields),
      model_outputs: clone(pack.model_outputs), coverage_outputs: clone(pack.coverage_outputs ?? []),
      workflow_columns: clone(pack.workflow_columns ?? []),
      calculation_model: pack.calculation_model ?? 'monthly-plan/v1', illustrative_inputs: clone(pack.illustrative_inputs ?? {}),
      artifacts: clone(pack.artifacts ?? []), parameters: clone(pack.parameters), ratios: clone(pack.ratios),
      protocols: clone(pack.protocols), tolerances: clone(pack.tolerances), guideline_sources: clone(pack.guideline_sources),
      guideline_alignment: clone(pack.guideline_alignment), review_note: pack.review_note, inference_tokens: 0 }
  }
  if (name === 'business.plan.build') return buildPlan(args, now)
  return comparePlans(args, now)
}

function validMoney(value) {
  const valid = amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= MAX_MONEY
    && Math.abs(amount * 10000 - Math.round(amount * 10000)) < 1e-7
  if (valid(value)) return true
  return isRecord(value) && Object.keys(value).sort().join(',') === 'high,low'
    && valid(value.low) && valid(value.high) && value.low <= value.high
}
function validFieldValue(field, value) {
  if (field.type === 'money') return validMoney(value)
  if (field.type === 'integer') return Number.isSafeInteger(value) && value >= field.min && value <= field.max
  if (field.type === 'currency') return typeof value === 'string' && /^[A-Z]{3}$/u.test(value)
  if (field.type === 'enum') return typeof value === 'string' && field.values.includes(value)
  if (field.type === 'text') return typeof value === 'string' && value.length <= Math.min(field.max_length ?? MAX_TEXT, MAX_TEXT) && !TEXT_PATTERN.test(value)
  return false
}
function modeFor(pack, id) {
  const defaultMode = pack.plan_modes.find(item => item.default)
  const requested = id === undefined ? defaultMode?.id : id
  const mode = pack.plan_modes.find(item => item.id === requested)
  if (!mode) fail('sme_pack_mode_invalid')
  return mode
}
function requiredForMode(field, mode, inputs) {
  return Boolean(field.required || field.required_modes?.includes(mode.id)
    || field.required_when && inputs[field.required_when.field] === field.required_when.equals)
}
function validEvidence(pack, evidence) {
  if (evidence === undefined) return []
  if (!Array.isArray(evidence) || evidence.length > 40) fail('sme_pack_evidence_invalid')
  const fields = definitions(pack)
  return evidence.map(row => {
    assertExactKeys(row, ['field_key', 'provenance', 'observer_role', 'date', 'value'])
    const field = fields[row.field_key]
    if (!field || !provenanceTypes.includes(row.provenance) || !observerRoles.includes(row.observer_role)
      || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(row.date)
      || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date
      || !validFieldValue(field, row.value)) fail('sme_pack_evidence_invalid')
    return { field_key: row.field_key, provenance: row.provenance, observer_role: row.observer_role, date: row.date, value: clone(row.value) }
  })
}
async function validateInput(args) {
  if (!isRecord(args)) fail('sme_pack_arguments_invalid')
  const keys = ['pack_id', 'inputs', ...(Object.hasOwn(args, 'mode') ? ['mode'] : []), ...(Object.hasOwn(args, 'evidence') ? ['evidence'] : [])]
  assertExactKeys(args, keys)
  if (typeof args.pack_id !== 'string' || !packEntry(args.pack_id) || !isRecord(args.inputs)
    || Object.keys(args.inputs).length > 32 || new TextEncoder().encode(JSON.stringify(args)).byteLength > 32768) fail('sme_pack_arguments_invalid')
  const pack = await loadPack(args.pack_id), mode = modeFor(pack, args.mode), fields = definitions(pack), inputs = Object.create(null), invalid = []
  for (const [key, value] of Object.entries(args.inputs)) {
    const field = fields[key]
    if (!field) fail('sme_pack_unknown_field')
    if (!validFieldValue(field, value)) { invalid.push(key); continue }
    inputs[key] = clone(value)
  }
  const missing = pack.input_fields.filter(field => requiredForMode(field, mode, inputs) && !Object.hasOwn(inputs, field.name)).map(field => field.name)
  return { pack, mode, inputs, evidence: validEvidence(pack, args.evidence), missing, invalid }
}
function projectionCoverage(pack, inputs) {
  return Object.fromEntries(pack.guideline_alignment.projections.map(projection => {
    const requirements = projection.requirements ?? []
    const mapped = requirements.filter(row => ['applied', 'partial', 'workspace_only'].includes(row.status))
    const inputKeys = [...new Set(mapped.flatMap(row => row.input_fields ?? []))].sort()
    return [projection.id, { support_status: projection.support_status,
      requirements_total: requirements.length, requirements_mapped: mapped.length,
      inputs_mapped: inputKeys.length, inputs_supplied: inputKeys.filter(key => Object.hasOwn(inputs, key)).length,
      missing_inputs: inputKeys.filter(key => !Object.hasOwn(inputs, key)) }]
  }))
}
function evidenceCoverage(pack, evidence) {
  const guidedFields = [...new Set(pack.protocols.map(row => row.field_key))]
  const evidenced = new Set(evidence.map(row => row.field_key))
  return { guided_fields: guidedFields.length, evidenced_fields: guidedFields.filter(key => evidenced.has(key)).length,
    missing_fields: guidedFields.filter(key => !evidenced.has(key)), evidence_count: evidence.length,
    status: 'user-recorded; not authenticated' }
}
function range(value) {
  if (typeof value === 'number') return { low: value, high: value }
  return isRecord(value) && Number.isFinite(value.low) && Number.isFinite(value.high) ? value : null
}
function finiteRange(low, high = low) {
  if (![low, high].every(Number.isFinite) || Math.max(Math.abs(low), Math.abs(high)) > Number.MAX_SAFE_INTEGER) return null
  return { low: rounded(Math.min(low, high)), high: rounded(Math.max(low, high)) }
}
function rounded(value) { return Math.round((value + Number.EPSILON) * 10000) / 10000 }
function add(left, right) { return left && right ? finiteRange(left.low + right.low, left.high + right.high) : null }
function subtract(left, right) { return left && right ? finiteRange(left.low - right.high, left.high - right.low) : null }
function multiply(left, right) {
  if (!left || !right) return null
  const values = [left.low * right.low, left.low * right.high, left.high * right.low, left.high * right.high]
  return finiteRange(Math.min(...values), Math.max(...values))
}
function positivePart(value) { return value ? finiteRange(Math.max(0, value.low), Math.max(0, value.high)) : null }
function takeoverCashModel(inputs) {
  const currency = /^[A-Z]{3}$/u.test(inputs.currency_code ?? '') ? inputs.currency_code : null
  const obligation = inputs.location_obligation
  const applies = obligation === 'applies', notApplicable = obligation === 'not_applicable'
  const fixedKeys = ['purchase_price', 'transition_costs', 'asset_setup_costs', 'transaction_professional_costs',
    'immediate_reinvestment_costs', 'monthly_operating_costs', 'working_capital_months']
  const closeKeys = [...fixedKeys, 'currency_code', 'location_obligation',
    ...(applies ? ['location_deposit', 'location_monthly_cost'] : [])]
  const missing = keys => [...new Set(keys.filter(key => inputs[key] === undefined || key === 'currency_code' && !currency))]
  const number = key => range(inputs[key])
  const required = missing(closeKeys)
  const upfrontKeys = ['purchase_price', 'transition_costs', 'asset_setup_costs', 'transaction_professional_costs', 'immediate_reinvestment_costs']
  let cashToClose = required.length ? null : upfrontKeys.map(number).reduce(add, range(0))
  if (cashToClose && applies) cashToClose = add(cashToClose, number('location_deposit'))
  const monthly = cashToClose && add(number('monthly_operating_costs'), applies ? number('location_monthly_cost') : range(0))
  if (cashToClose && monthly) cashToClose = add(cashToClose, multiply(monthly, number('working_capital_months')))
  else cashToClose = null

  let locationExposure = null
  let locationMissing = []
  if (notApplicable) locationExposure = 'not_applicable'
  else if (!applies) locationMissing = ['location_obligation']
  else {
    locationMissing = missing(['location_monthly_cost', 'location_term_months', 'currency_code'])
    if (!locationMissing.length) locationExposure = multiply(number('location_monthly_cost'), number('location_term_months'))
  }
  const availableMissing = missing(['available_cash', 'currency_code'])
  const shortfallMissing = [...new Set([...required, ...availableMissing])]
  const shortfall = !shortfallMissing.length && cashToClose ? positivePart(subtract(cashToClose, number('available_cash'))) : null
  const displayMoney = value => value ? textRange(value, currency) : 'Unknown · required inputs not supplied'
  return {
    currency_code: currency,
    cash_to_close: cashToClose,
    location_exposure: locationExposure === 'not_applicable' ? null : locationExposure,
    cash_shortfall: shortfall,
    missing_inputs: { cash_to_close: required,
      location_exposure: locationMissing, cash_shortfall: shortfallMissing },
    formula_status: { cash_to_close: cashToClose ? 'calculated' : 'unknown',
      location_exposure: notApplicable ? 'not_applicable' : locationExposure ? 'calculated' : 'unknown',
      cash_shortfall: shortfall ? 'calculated' : shortfallMissing.length ? 'unknown' : 'no_shortfall' },
    display: { cash_to_close: displayMoney(cashToClose),
      location_exposure: notApplicable ? 'Not applicable' : displayMoney(locationExposure),
      cash_shortfall: displayMoney(shortfall) },
  }
}
function monthlyModel(inputs, mode) {
  const price = range(inputs.price_per_unit), units = range(inputs.units_per_month)
  const variableCost = range(inputs.variable_cost_per_unit), fixed = range(inputs.fixed_costs_per_month)
  const payroll = range(inputs.payroll_per_month), setup = range(inputs.setup_costs), cash = range(inputs.cash_available)
  const acquisition = range(inputs.acquisition_price), transition = range(inputs.transition_costs)
  const months = range(inputs.runway_target_months), requested = range(inputs.funding_requested)
  const revenue = multiply(price, units), variable = multiply(variableCost, units)
  const contribution = subtract(revenue, variable), operatingCosts = add(fixed, payroll)
  const operatingResult = subtract(contribution, operatingCosts), unitContribution = subtract(price, variableCost)
  let breakEven = { status: 'unknown', units: null }
  if (operatingCosts && unitContribution) {
    if (unitContribution.high <= 0) breakEven = { status: 'no_positive_unit_contribution', units: null }
    else if (unitContribution.low <= 0) breakEven = { status: 'range_includes_nonpositive_contribution', units: null }
    else breakEven = { status: 'calculated', units: finiteRange(
      Math.ceil(operatingCosts.low / unitContribution.high), Math.ceil(operatingCosts.high / unitContribution.low)) }
  }
  const burn = positivePart(operatingResult ? { low: -operatingResult.high, high: -operatingResult.low } : null)
  let runway = { status: 'unknown', months: null }
  if (operatingResult && burn && burn.high === 0) runway = { status: 'no_monthly_burn_indicated', months: null }
  else if (cash && burn && burn.low > 0) runway = { status: 'calculated', months: finiteRange(cash.low / burn.high, cash.high / burn.low) }
  else if (cash && burn && burn.high > 0) runway = { status: 'range_crosses_zero', months: null }
  const path = inputs.buy_build_path
  const outlayInputs = path === 'buy_existing' ? ['acquisition_price', 'transition_costs']
    : path === 'build_new' ? ['setup_costs'] : path === 'undecided' ? ['buy_build_path']
      : mode.id === 'buy_build' ? ['buy_build_path'] : ['setup_costs']
  const initialOutlay = path === 'buy_existing' ? add(acquisition, transition)
    : path === 'build_new' ? setup : path === 'undecided' ? null
      : mode.id === 'buy_build' ? null : setup
  const fundingInputs = [...outlayInputs, 'cash_available', 'runway_target_months', 'price_per_unit', 'units_per_month',
    'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month']
  let fundingGap = null
  if (initialOutlay && cash && months && burn && burn.high === 0) fundingGap = positivePart(finiteRange(initialOutlay.low - cash.high, initialOutlay.high - cash.low))
  else if (initialOutlay && cash && months && burn) fundingGap = positivePart(subtract(add(initialOutlay, multiply(burn, months)), cash))
  const requestedAgainstGap = requested && fundingGap ? subtract(requested, fundingGap) : null
  const gaps = {
    monthly_revenue: ['price_per_unit', 'units_per_month'],
    monthly_variable_cost: ['variable_cost_per_unit', 'units_per_month'],
    monthly_contribution: ['price_per_unit', 'units_per_month', 'variable_cost_per_unit'],
    monthly_operating_costs: ['fixed_costs_per_month', 'payroll_per_month'],
    monthly_operating_result: ['price_per_unit', 'units_per_month', 'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month'],
    break_even_units: ['price_per_unit', 'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month'],
    runway: ['cash_available', 'price_per_unit', 'units_per_month', 'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month'],
    funding_gap: fundingInputs,
    funding_requested_difference: ['funding_requested', ...fundingInputs],
  }
  if (path === 'undecided') gaps.funding_gap = [...fundingInputs, 'buy_build_path']
  return { currency_code: inputs.currency_code ?? null, buy_build_path: path ?? null, revenue_per_month: revenue, variable_cost_per_month: variable,
    contribution_per_month: contribution, operating_costs_per_month: operatingCosts, operating_result_per_month: operatingResult,
    break_even_units: breakEven, runway, funding_gap: fundingGap, funding_requested_difference: requestedAgainstGap,
    missing_inputs: Object.fromEntries(Object.entries(gaps).map(([key, names]) => [key, names.filter(name => inputs[name] === undefined)])),
    formula_status: { break_even_units: breakEven.status, runway: runway.status,
      funding_gap: fundingGap ? 'calculated' : 'unknown' } }
}
function textRange(value, currency) {
  const money = value => `${currency ?? 'currency not supplied'} ${new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value)}`
  if (!value) return 'Unknown · required inputs not supplied'
  return money(value.low) + (value.low === value.high ? '' : '–' + money(value.high))
}
function modelText(model) {
  if (model.display) return model.display
  const money = value => textRange(value, model.currency_code)
  const breakEven = model.break_even_units.status === 'calculated'
    ? `${new Intl.NumberFormat('en').format(model.break_even_units.units.low)}–${new Intl.NumberFormat('en').format(model.break_even_units.units.high)} units/month`
    : `Unknown · ${model.break_even_units.status.replaceAll('_', ' ')}`
  const runway = model.runway.months ? `${model.runway.months.low}–${model.runway.months.high} months` : `Unknown · ${model.runway.status.replaceAll('_', ' ')}`
  return { monthly_revenue: money(model.revenue_per_month), monthly_variable_cost: money(model.variable_cost_per_month),
    monthly_contribution: money(model.contribution_per_month), monthly_operating_costs: money(model.operating_costs_per_month),
    monthly_operating_result: money(model.operating_result_per_month), break_even_units: breakEven, runway,
    funding_gap: money(model.funding_gap), funding_requested_difference: money(model.funding_requested_difference) }
}
function pitchDeckOutline(pack, inputs, model) {
  const roles = (pack.artifacts ?? []).find(artifact => artifact.id === 'pitch_deck_outline')?.roles ?? []
  if (!roles.length) return []
  const modelRows = modelText(model)
  return roles.map(role => {
    const values = role.input_fields.map(key => inputs[key]).filter(value => value !== undefined && value !== '')
    let content = values.join(' · ') || 'Not supplied'
    if (role.content_kind === 'venture_stage') content = inputs.venture_name || inputs.venture_stage
      ? `${inputs.venture_name || 'Not supplied'} · ${inputs.venture_stage || 'Stage not supplied'}` : 'Not supplied'
    if (role.content_kind === 'financial_model') content = role.model_output_keys
      .map(key => `${key.replaceAll('_', ' ')}: ${modelRows[key]}`).join('; ')
    if (role.content_kind === 'funding') {
      const fieldLabels = Object.fromEntries(pack.input_fields.map(field => [field.name, field.label]))
      const fundingInputs = ['buy_build_path', 'acquisition_price', 'transition_costs', 'setup_costs', 'funding_requested', 'use_of_funds']
        .filter(key => inputs[key] !== undefined)
        .map(key => `${fieldLabels[key]}: ${key === 'buy_build_path' ? inputs[key].replaceAll('_', ' ')
          : ['acquisition_price', 'transition_costs', 'setup_costs', 'funding_requested'].includes(key)
            ? textRange(range(inputs[key]), inputs.currency_code) : inputs[key]}`)
      const fundingOutputs = role.model_output_keys.map(key => `${key.replaceAll('_', ' ')}: ${modelRows[key]}`)
      content = [...fundingInputs, ...fundingOutputs].join(' · ') || 'Not supplied'
    }
    return { id: role.id, slide: role.slide, section: role.label, content,
      field_keys: [...role.input_fields], model_output_keys: [...(role.model_output_keys ?? [])] }
  })
}
function nextChecks(pack, inputs, missing, model) {
  const fields = definitions(pack), checks = missing.map(name => ({ field: name, label: fields[name].label,
    action: `Enter ${fields[name].label.toLowerCase()} or leave it explicitly unknown.` }))
  for (const [output, missingInputs] of Object.entries(model.missing_inputs)) {
    if (!missingInputs.length) continue
    if (missingInputs.includes('buy_build_path') && inputs.buy_build_path === 'undecided') {
      checks.push({ field: 'buy_build_path', label: fields.buy_build_path.label,
        action: 'Choose an acquisition or build path to calculate a path-specific funding need, or keep it unknown.' })
      continue
    }
    const field = fields[missingInputs[0]]
    if (!checks.some(row => row.field === missingInputs[0])) checks.push({ field: missingInputs[0], label: field.label,
      action: `Enter ${missingInputs.map(name => fields[name].label.toLowerCase()).join(' and ')} to calculate ${output.replaceAll('_', ' ')}.` })
  }
  for (const name of pack.next_check_fields ?? []) {
    if (fields[name] && !inputs[name] && !checks.some(row => row.field === name)) checks.push({ field: name, label: fields[name].label,
      action: `Add ${fields[name].label.toLowerCase()} if available; no value is inferred.` })
  }
  return checks.slice(0, 24).map((row, index) => ({ order: index + 1, ...row }))
}
function csvCell(value) { return '"' + String(value ?? '').replaceAll('"', '""') + '"' }
function makeWorksheet(pack, mode, inputs, evidence, model, outline, checks) {
  const worksheet = { schema: 'sme-business-plan/worksheet/v2', pack_id: pack.id, pack_version: pack.version,
    mode: mode.id, currency_code: inputs.currency_code ?? null, inputs: clone(inputs), evidence: clone(evidence) }
  const modelRows = modelText(model)
  const json = JSON.stringify(worksheet, null, 2), rows = [['kind', 'key', 'value', 'provenance', 'observer_role', 'date']]
  rows.push(['meta', 'mode', JSON.stringify(mode.id), '', '', ''])
  for (const [key, value] of Object.entries(worksheet.inputs)) rows.push(['input', key, JSON.stringify(value), '', '', ''])
  for (const row of evidence) rows.push(['evidence', row.field_key, JSON.stringify(row.value), row.provenance, row.observer_role, row.date])
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n')
  const context = [`Mode: ${mode.label}`, inputs.venture_stage ? `Stage: ${inputs.venture_stage}` : null,
    `Currency: ${inputs.currency_code || 'Not supplied'}`, 'Draft · Not verified'].filter(Boolean).join(' · ')
  const markdown = [
    `# ${inputs.venture_name || `${pack.label} draft`}`, '',
    context, '',
    '## Pitch deck draft outline', ...outline.map(row => `### Slide ${row.slide}: ${row.section}\n\n${row.content}`), '',
    '## Model outputs', ...Object.entries(modelRows).map(([key, value]) => `- ${key.replaceAll('_', ' ')}: ${value}`), '',
    '## Next checks', ...checks.map(row => `${row.order}. ${row.action}`), '',
    'Assumptions are user supplied. Missing values remain unknown. Calculations use the entered currency code without conversion and are not a forecast, valuation, accounting statement, investment or financing advice.', '',
    '~~~json', json, '~~~', '',
  ].join('\n')
  return { json, csv, markdown }
}
async function buildPlan(args, now) {
  const input = await validateInput(args), pack = input.pack
  const model = pack.calculation_model === 'takeover-cash/v1'
    ? takeoverCashModel(input.inputs) : monthlyModel(input.inputs, input.mode)
  const pitch = pitchDeckOutline(pack, input.inputs, model), checks = nextChecks(pack, input.inputs, input.missing, model)
  const coverage = projectionCoverage(pack, input.inputs), evidence = evidenceCoverage(pack, input.evidence)
  const worksheet = makeWorksheet(pack, input.mode, input.inputs, input.evidence, model, pitch, checks)
  const required = pack.input_fields.filter(field => requiredForMode(field, input.mode, input.inputs))
  return { schema: 'sme-business-plan/report/v2', pack: clone(summary(pack)), mode: clone(input.mode), label: 'Planning draft · not verified',
    disclaimer: 'User-supplied facts and assumptions only. Missing values stay unknown. This deterministic planning aid is not a forecast, valuation, accounting statement, legal, tax, investment, or financing advice.',
    check: { completeness: { required: required.length,
      supplied: required.filter(field => Object.hasOwn(input.inputs, field.name)).length,
      missing_fields: input.missing, invalid_fields: input.invalid }, evidence_count: input.evidence.length,
      evidence_status: 'user-recorded; not authenticated' },
    model, model_display: modelText(model), projection_coverage: coverage, evidence_coverage: evidence,
    pitch_deck_outline: pitch, next_checks: checks, worksheet,
    as_of: new Date(now).toISOString(), inference_tokens: 0, persisted: false }
}
async function comparePlans(args, now) {
  assertExactKeys(args, Object.hasOwn(args ?? {}, 'mode') ? ['mode', 'plan_sets'] : ['plan_sets'])
  if (!Array.isArray(args.plan_sets) || args.plan_sets.length < 2 || args.plan_sets.length > 3
    || new TextEncoder().encode(JSON.stringify(args)).byteLength > 32768) fail('sme_pack_arguments_invalid')
  const sets = args.plan_sets
  for (const set of sets) {
    const keys = Object.hasOwn(set ?? {}, 'evidence') ? ['pack_id', 'pack_version', 'inputs', 'evidence'] : ['pack_id', 'pack_version', 'inputs']
    assertExactKeys(set, keys)
    if (typeof set.pack_id !== 'string' || typeof set.pack_version !== 'string' || !isRecord(set.inputs)) fail('sme_pack_arguments_invalid')
  }
  const identity = sets[0]
  if (sets.some(set => set.pack_id !== identity.pack_id || set.pack_version !== identity.pack_version
    || set.inputs.currency_code !== identity.inputs.currency_code)) fail('sme_pack_comparison_identity_mismatch')
  if (typeof identity.inputs.currency_code !== 'string' || !/^[A-Z]{3}$/u.test(identity.inputs.currency_code)) fail('sme_pack_comparison_currency_required')
  const pack = await loadPack(identity.pack_id)
  const mode = modeFor(pack, args.mode)
  if (identity.pack_version !== pack.version) fail('sme_pack_comparison_identity_mismatch')
  const slots = []
  for (const [index, set] of sets.entries()) {
    const report = await buildPlan({ pack_id: set.pack_id, mode: mode.id, inputs: set.inputs, ...(set.evidence ? { evidence: set.evidence } : {}) }, now)
    slots.push({ slot: ['A', 'B', 'C'][index], status: 'included', report })
  }
  if (slots.length === 2) slots.push({ slot: 'C', status: 'not_supplied', report: null })
  const result = { schema: 'sme-business-plan/comparison/v2', pack: clone(summary(pack)), mode: clone(mode), currency_code: identity.inputs.currency_code,
    slots, ranking: null, winner: null, conversion_applied: false, inference_tokens: 0, persisted: false }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) fail('sme_pack_response_too_large')
  return result
}
