// Decision metadata and validation for the existing SME evaluator. No storage or effects.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => structuredClone(value)
export const sameDecisionPolicy = (left, right) => canonical(left) === canonical(right)
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return record(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
}
function refuse(reasons) {
  const error = Error('sme_pack_decision_refused'); error.reasons = reasons; throw error
}
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
export const DECISION_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['baseline', 'policy_revision', 'protected_fields', 'bounds'], properties: {
    baseline: { type: 'string', enum: ['A', 'B', 'C'] }, policy_revision: { type: 'integer', minimum: 1, maximum: 100000000 },
    protected_fields: { type: 'array', maxItems: 38, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } },
    bounds: { type: 'object', maxProperties: 38, patternProperties: { '^[a-z][a-z0-9_]{0,63}$': {
      type: 'object', required: ['min', 'max'], additionalProperties: false,
      properties: { min: { type: 'number', minimum: 0, maximum: 1000000000 }, max: { type: 'number', minimum: 0, maximum: 1000000000 } },
    } }, additionalProperties: false },
  } })
export function validateDecisionPolicy(policy, fields, slots) {
  const names = new Map(fields.map(field => [field.name, field]))
  if (!exact(policy, ['baseline', 'policy_revision', 'protected_fields', 'bounds']) || !slots.includes(policy.baseline)
    || !Number.isSafeInteger(policy.policy_revision) || policy.policy_revision < 1 || policy.policy_revision > 100000000
    || !Array.isArray(policy.protected_fields) || policy.protected_fields.length > 38
    || new Set(policy.protected_fields).size !== policy.protected_fields.length || policy.protected_fields.some(key => !names.has(key))
    || !record(policy.bounds) || Object.keys(policy.bounds).length > 38) refuse([{ field: 'decision', reason: 'invalid_policy' }])
  for (const [key, bound] of Object.entries(policy.bounds)) {
    if (!['money', 'integer'].includes(names.get(key)?.type) || !exact(bound, ['min', 'max'])
      || ![bound.min, bound.max].every(value => Number.isFinite(value) && value >= 0 && value <= 1000000000)
      || bound.min > bound.max) refuse([{ field: key, reason: 'invalid_bounds' }])
  }
  return copy(policy)
}
export function decisionRefusals(inputs, baseline, policy) {
  const reasons = []
  for (const key of policy.protected_fields) if (!sameDecisionPolicy(inputs[key], baseline[key])) reasons.push({ field: key, reason: 'protected' })
  for (const [key, bound] of Object.entries(policy.bounds)) {
    const value = inputs[key], low = typeof value === 'number' ? value : value?.low, high = typeof value === 'number' ? value : value?.high
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < bound.min || high > bound.max || low > high) reasons.push({ field: key, reason: 'outside_bounds' })
  }
  return reasons
}
export function validateDecisionRows(policy, sets, fields) {
  const slots = sets.map((_, index) => ['A', 'B', 'C'][index]), checked = validateDecisionPolicy(policy, fields, slots)
  const baseline = sets[slots.indexOf(checked.baseline)].inputs
  const reasons = sets.flatMap((set, index) => decisionRefusals(set.inputs, baseline, checked).map(row => ({ ...row, slot: slots[index] })))
  if (reasons.length) refuse(reasons)
  return checked
}
export function applyDecisionPatch(item, patch, policy, expected, fields, validValue) {
  if (!record(patch) || !Number.isSafeInteger(item.revision) || item.revision >= 100000000
    || expected?.revision !== item.revision || expected?.policy_revision !== (policy?.policy_revision ?? 0)) refuse([{ field: 'revision', reason: 'stale' }])
  const definitions = new Map(fields.map(field => [field.name, field])), next = copy(item.inputs), reasons = []
  for (const [key, value] of Object.entries(patch)) {
    if (!definitions.has(key) || value !== null && !validValue(definitions.get(key), value)) reasons.push({ field: key, reason: 'invalid_value' })
    else if (value === null) delete next[key]; else next[key] = copy(value)
  }
  if (policy) reasons.push(...decisionRefusals(next, item.inputs, policy))
  if (reasons.length) refuse(reasons)
  return { ...item, inputs: next, revision: item.revision + 1 }
}
export function baselineProposal(slot, rows, policy) {
  if (!rows.some(row => row.slot === slot)) refuse([{ field: 'baseline', reason: 'unknown_row' }])
  return { slot, basis: canonical({ rows, policy }) }
}
export function confirmBaseline(proposal, rows, policy, confirmed) {
  if (!confirmed || !proposal || (policy?.policy_revision ?? 0) >= 100000000 || !rows.some(row => row.slot === proposal.slot) || proposal.basis !== canonical({ rows, policy })) refuse([{ field: 'baseline', reason: 'stale_or_unconfirmed' }])
  return { baseline: proposal.slot, policy_revision: (policy?.policy_revision ?? 0) + 1,
    protected_fields: [...(policy?.protected_fields ?? [])], bounds: copy(policy?.bounds ?? {}) }
}

// Formula descriptors reference the arithmetic's existing output values, never recompute them.
const MONTHLY = {
  monthly_revenue: ['revenue_per_month', 'price_per_unit × units_per_month', ['price_per_unit', 'units_per_month']],
  monthly_variable_cost: ['variable_cost_per_month', 'variable_cost_per_unit × units_per_month', ['variable_cost_per_unit', 'units_per_month']],
  monthly_contribution: ['contribution_per_month', '(price_per_unit − variable_cost_per_unit) × units_per_month', ['price_per_unit', 'units_per_month', 'variable_cost_per_unit']],
  monthly_operating_costs: ['operating_costs_per_month', 'fixed_costs_per_month + payroll_per_month', ['fixed_costs_per_month', 'payroll_per_month']],
  monthly_operating_result: ['operating_result_per_month', 'monthly_contribution − fixed_costs_per_month − payroll_per_month', ['price_per_unit', 'units_per_month', 'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month']],
  break_even_units: ['break_even_units', 'ceil((fixed_costs_per_month + payroll_per_month) ÷ (price_per_unit − variable_cost_per_unit))', ['price_per_unit', 'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month']],
  runway: ['runway', 'cash_available ÷ max(0, −monthly_operating_result)', ['cash_available', 'price_per_unit', 'units_per_month', 'variable_cost_per_unit', 'fixed_costs_per_month', 'payroll_per_month']],
  funding_gap: ['funding_gap', 'max(0, initial_outlay + monthly_burn × runway_target_months − cash_available)', []],
  funding_requested_difference: ['funding_requested_difference', 'funding_requested − funding_gap', []],
}
export function monthlyDependencies(inputs, mode) {
  const outlay = inputs.buy_build_path === 'buy_existing' ? ['acquisition_price', 'transition_costs']
    : inputs.buy_build_path === 'build_new' || inputs.buy_build_path === undefined && mode.id !== 'buy_build' ? ['setup_costs'] : ['buy_build_path']
  const funding = [...outlay, 'cash_available', 'runway_target_months', ...MONTHLY.monthly_operating_result[2]]
  return Object.fromEntries(Object.entries(MONTHLY).map(([key, row]) => [key,
    key === 'funding_gap' ? funding : key === 'funding_requested_difference' ? ['funding_requested', ...funding] : row[2]]))
}
function outputValue(model, key) {
  const value = model[key]
  return key === 'break_even_units' ? value.units : key === 'runway' ? value.months : value
}
export function projectWorking(pack, mode, inputs, evidence, model) {
  const monthly = pack.calculation_model !== 'takeover-cash/v1', dependencies = monthly ? monthlyDependencies(inputs, mode) : {
    cash_to_close: ['purchase_price', 'transition_costs', 'asset_setup_costs', 'transaction_professional_costs', 'immediate_reinvestment_costs', 'monthly_operating_costs', 'working_capital_months', 'location_obligation', ...(inputs.location_obligation === 'applies' ? ['location_deposit', 'location_monthly_cost'] : [])],
    location_exposure: ['location_obligation', 'location_monthly_cost', 'location_term_months'],
    cash_shortfall: ['available_cash', 'purchase_price', 'transition_costs', 'asset_setup_costs', 'transaction_professional_costs', 'immediate_reinvestment_costs', 'monthly_operating_costs', 'working_capital_months', 'location_obligation', ...(inputs.location_obligation === 'applies' ? ['location_deposit', 'location_monthly_cost'] : [])],
    operating_difference_per_month: ['monthly_revenue', 'monthly_operating_costs', 'location_obligation', ...(inputs.location_obligation === 'applies' ? ['location_monthly_cost'] : []), 'financial_basis', 'financial_period_months'],
  }
  const formulas = { cash_to_close: 'purchase + transition + setup + professional + reinvestment + applicable deposit + working_capital_months × (monthly operating + applicable location cost)',
    location_exposure: 'location_monthly_cost × location_term_months; not applicable only when explicitly declared',
    cash_shortfall: 'max(0, cash_to_close − available_cash)', operating_difference_per_month: 'monthly_revenue − monthly_operating_costs − applicable location_monthly_cost' }
  const keys = [...new Set(Object.values(dependencies).flat())]
  const operands = Object.fromEntries(keys.map(key => [key, { value: inputs[key] ?? null,
    evidence: evidence.filter(row => row.field_key === key).map(({ value, provenance, date, observer_role }) => ({ value, provenance, date, observer_role })) }]))
  const outputs = Object.fromEntries(pack.model_outputs.map(output => {
    const descriptor = MONTHLY[output.id], value = outputValue(model, monthly ? descriptor[0] : output.id)
    return [output.id, { formula: monthly ? descriptor[1] : formulas[output.id], fields: dependencies[output.id],
      unit: output.id === 'break_even_units' ? 'units/month' : output.id === 'runway' ? 'months' : inputs.currency_code ?? 'unknown currency',
      period: output.id.includes('monthly') || output.id.endsWith('per_month') ? 'month' : 'declared planning basis',
      value: value ?? null, status: model.formula_status?.[output.id] ?? (value ? 'calculated' : 'unknown'), missing: model.missing_inputs[output.id] ?? [] }]
  }))
  return { operands, outputs, evidence_status: 'user-recorded; not authenticated', range_basis: 'conservative interval; not probability or forecast' }
}
export function projectDeltas(policy, slots, difference, operatingComparable) {
  const baseline = slots.find(row => row.slot === policy.baseline)
  return { ...copy(policy), rows: slots.filter(row => row.report).map(row => ({ slot: row.slot,
    deltas: Object.fromEntries(Object.entries(row.report.working.outputs).map(([key, output]) => {
      const original = baseline.report.working.outputs[key]
      const identical = output.fields.every(field => sameDecisionPolicy(row.report.working.operands[field]?.value, baseline.report.working.operands[field]?.value))
      const comparable = key !== 'operating_difference_per_month' || operatingComparable !== false
      return [key, { value: !comparable || !output.value || !original.value ? null : identical ? { low: 0, high: 0 } : difference(output.value, original.value),
        status: !comparable ? 'incomparable_basis' : !output.value || !original.value ? 'unknown' : 'calculated', unit: output.unit, period: output.period }]
    })) })) }
}
