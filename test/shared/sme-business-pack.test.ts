import { describe, expect, it } from 'vitest'
// @ts-expect-error The browser-safe JavaScript module is shared by the Worker and UI.
import { invokeSmePackTool, PACK_INDEX, PACK_PATH, TOOL_NAMES, TOOL_SCHEMAS, readSmeWorksheets, serializeSmeWorksheets } from '../../public/local-first/sme-business-pack-core.js'
import { handleSmeBusinessPackRequest } from '../../src/local-first/sme-business-pack'

const packId = 'sme.business-plan'
const takeoverId = 'sme.takeover-checker'
const takeoverInputs = {
  currency_code: 'USD', transaction_structure: 'asset_transfer', purchase_price: 80000,
  included_items: 'User-listed equipment and other included items', excluded_items: 'Items not included in the entered amount',
  transition_costs: 3500, asset_setup_costs: 2500, equipment_resale_estimate: 4000,
  improvements_current_estimate: 7000, improvements_reference_year: 2023,
  transaction_professional_costs: 1500, immediate_reinvestment_costs: 1000, handover_months: 1,
  monthly_revenue: 12000, financial_basis: 'current_estimate', financial_period_months: 6,
  location_obligation: 'applies', location_deposit: 3600, location_monthly_cost: 1800, location_term_months: 12,
  location_renewal_months: 6, location_assignment_status: 'conditional',
  monthly_operating_costs: 6500, working_capital_months: 3, available_cash: 20000,
}
const baseInputs = {
  venture_stage: 'validation', problem_statement: 'A recurring task takes too much time.',
  target_customer: 'A group the author can reach for interviews.', solution_offer: 'A simple service for the task.',
  buy_build_path: 'build_new', business_model: 'A user-selected price per unit.', go_to_market: 'A small opt-in trial.',
  key_risks: 'Demand and delivery effort are unverified.', milestones: 'Interview, test, review costs.', currency_code: 'USD',
}
const build = (inputs: Record<string, unknown>, evidence?: unknown[]) => invokeSmePackTool('business.plan.build', {
  pack_id: packId, inputs, ...(evidence ? { evidence } : {}),
})
const request = (body: unknown, method = 'POST') => new Request(`https://local.test${PACK_PATH}/api`, {
  method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
})

describe('SME business plan contract', () => {
  it('publishes one neutral protocol, one tool registry, and explicit field/output collections', async () => {
    expect(PACK_INDEX).toMatchObject([
      { id: packId, label: 'General business plan', version: '2.3.0', review_status: 'provisional' },
      { id: takeoverId, label: 'SME takeover checker', version: '1.2.0', review_status: 'provisional' },
    ])
    expect(TOOL_NAMES).toEqual(['pack.list', 'pack.protocol', 'business.plan.build', 'business.plan.compare'])
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toMatch(/country|sector|SGD|takeover|listing/i)
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packId })
    expect(protocol).toMatchObject({ schema: 'sme-business-plan/protocol/v3', inference_tokens: 0,
      guideline_alignment: { schema: 'sme-business-plan/guideline-alignment/v1', join_rule: 'continuity_id@revision' } })
    expect(protocol.plan_modes).toEqual([
      expect.objectContaining({ id: 'buy_build', label: 'Buy/Build', default: true }),
      expect.objectContaining({ id: 'scenario', label: 'Scenario', default: false }),
    ])
    expect(protocol.guideline_alignment.projections.map((row: any) => row.id)).toEqual(['pitch_deck', 'business_plan', 'financial_model'])
    expect(protocol.guideline_sources.map((row: any) => row.id)).toContain('parent_prd')
    expect(protocol.pack).not.toHaveProperty('country')
    expect(protocol.pack).not.toHaveProperty('currency')
    expect(protocol.input_fields.map((field: any) => field.name)).toContain('problem_statement')
    expect(protocol.model_outputs.map((output: any) => output.id)).toContain('funding_requested_difference')
    expect(protocol.artifacts.map((artifact: any) => artifact.id)).toEqual(['pitch_deck_outline'])
    expect(protocol.artifacts[0].roles).toHaveLength(12)
    expect(protocol.coverage_outputs.map((output: any) => output.id)).toEqual(['pitch_deck', 'business_plan', 'financial_model', 'evidence'])
    expect(protocol.readiness_outputs).toBeUndefined()
    expect(protocol.workflow_columns.map((column: any) => column.id)).toEqual([
      'plan-completeness', 'data-validation', 'evidence-values', 'evidence-provenance', 'evidence-observer',
      'evidence-date', 'evidence-status', 'model-coverage', 'next-checks',
    ])
    expect(protocol.parameters).toEqual([])
    await expect(invokeSmePackTool('pack.protocol', { pack_id: 'other.plan' })).rejects.toThrow('sme_pack_not_found')
  })

  it('uses the same modes, table columns, tools, and local evaluator for the takeover contract', async () => {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: takeoverId })
    expect(protocol).toMatchObject({ calculation_model: 'takeover-cash/v1', pack: { id: takeoverId, label: 'SME takeover checker', version: '1.2.0' } })
    expect(protocol.plan_modes.map((mode: any) => mode.id)).toEqual(['buy_build', 'scenario'])
    expect(protocol.workflow_columns.map((column: any) => column.id)).toEqual([
      'plan-completeness', 'data-validation', 'evidence-values', 'evidence-provenance', 'evidence-observer',
      'evidence-date', 'evidence-status', 'model-coverage', 'next-checks',
    ])
    expect(protocol.input_fields.map((field: any) => field.name)).toEqual([
      'currency_code', 'transaction_structure', 'purchase_price', 'included_items', 'excluded_items', 'transition_costs',
      'asset_setup_costs', 'equipment_resale_estimate', 'improvements_current_estimate', 'improvements_reference_year',
      'transaction_professional_costs', 'immediate_reinvestment_costs', 'handover_months', 'monthly_revenue',
      'financial_basis', 'financial_period_months', 'location_obligation', 'location_deposit', 'location_monthly_cost',
      'location_term_months', 'location_renewal_months', 'location_assignment_status', 'monthly_operating_costs',
      'working_capital_months', 'available_cash', 'opportunity_label', 'business_activity', 'operating_area', 'transfer_reason',
      'buyer_budget', 'target_handover_months', 'operator_experience', 'accounts_access', 'permission_transfer_status',
      'team_continuity', 'support_scope', 'review_stage', 'next_action',
    ])
    expect(protocol.model_outputs.map((output: any) => output.id)).toContain('operating_difference_per_month')
    expect(protocol.artifacts).toEqual([])
    expect(protocol.illustrative_inputs).toEqual(takeoverInputs)

    const report: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs })
    expect(report.check.completeness).toMatchObject({ required: 13, supplied: 13, missing_fields: [], invalid_fields: [] })
    expect(report.model_display).toEqual({ cash_to_close: 'USD 117,000', location_exposure: 'USD 21,600',
      cash_shortfall: 'USD 97,000', operating_difference_per_month: 'USD 3,700 · Basis: current estimate · Period: 6 months' })
    expect(report.pitch_deck_outline).toEqual([])
    expect(report.projection_coverage).toEqual({})
    expect(report.model.missing_inputs).toEqual({ cash_to_close: [], location_exposure: [], cash_shortfall: [], operating_difference_per_month: [] })
    expect(report.worksheet.markdown).toContain('# SME takeover checker draft')

    const comparison: any = await invokeSmePackTool('business.plan.compare', { mode: 'scenario', plan_sets: [
      { pack_id: takeoverId, pack_version: '1.2.0', inputs: takeoverInputs },
      { pack_id: takeoverId, pack_version: '1.2.0', inputs: { ...takeoverInputs, purchase_price: 90000 } },
    ] })
    expect(comparison.slots.map((slot: any) => slot.slot)).toEqual(['A', 'B', 'C'])
    expect(comparison.ranking).toBeNull()
    expect(comparison.slots[0].report.model_display.cash_to_close).toBe('USD 117,000')
  })

  it('keeps conditional location values, not-applicable states, and ranges distinct', async () => {
    const unknown: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: {} })
    expect(unknown.model_display.cash_to_close).toContain('Unknown')
    expect(unknown.model_display.location_exposure).toContain('Unknown')
    expect(unknown.model_display.operating_difference_per_month).toContain('Unknown')
    expect(unknown.model.missing_inputs.location_exposure).toContain('location_obligation')
    expect(unknown.model.missing_inputs.operating_difference_per_month).toContain('monthly_revenue')

    const notApplicable = { ...takeoverInputs, location_obligation: 'not_applicable' }
    delete (notApplicable as any).location_deposit
    delete (notApplicable as any).location_monthly_cost
    delete (notApplicable as any).location_term_months
    const report: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: notApplicable })
    expect(report.model_display).toEqual({ cash_to_close: 'USD 108,000', location_exposure: 'Not applicable',
      cash_shortfall: 'USD 88,000', operating_difference_per_month: 'USD 5,500 · Basis: current estimate · Period: 6 months' })
    expect(report.check.completeness.missing_fields).toEqual([])

    const ranged: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId,
      inputs: { ...takeoverInputs, purchase_price: { low: 70000, high: 80000 } } })
    expect(ranged.model.cash_to_close).toEqual({ low: 107000, high: 117000 })
    expect(ranged.model.cash_shortfall).toEqual({ low: 87000, high: 97000 })

    const operatingLoss: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId,
      inputs: { ...takeoverInputs, monthly_revenue: 4000 } })
    expect(operatingLoss.model.operating_difference_per_month).toEqual({ low: -4300, high: -4300 })
    expect(operatingLoss.model_display.operating_difference_per_month).toBe('USD -4,300 · Basis: current estimate · Period: 6 months')
  })

  it('returns explicit unknowns for blank financial assumptions and preserves required completeness', async () => {
    const report: any = await build(baseInputs, undefined)
    expect(report).toMatchObject({ schema: 'sme-business-plan/report/v2', mode: { id: 'buy_build', label: 'Buy/Build' }, inference_tokens: 0, persisted: false })
    expect(JSON.parse(report.worksheet.json)).toMatchObject({ schema: 'sme-business-plan/worksheet/v2', mode: 'buy_build' })
    expect(report.check.completeness).toMatchObject({ required: 10, supplied: 10, missing_fields: [], invalid_fields: [] })
    expect(report.model_display.monthly_revenue).toContain('Unknown')
    expect(report.model.missing_inputs.monthly_revenue).toEqual(['price_per_unit', 'units_per_month'])
    expect(report.pitch_deck_outline.some((row: any) => row.section === 'Financial model')).toBe(true)
    expect(report.pitch_deck_outline).toHaveLength(12)
    expect(report.pitch_deck_outline.every((row: any) => Array.isArray(row.field_keys))).toBe(true)
    expect(report.pitch_deck_outline[9].model_output_keys).toContain('monthly_revenue')
    expect(report.projection_coverage.financial_model).toMatchObject({ support_status: 'single_period_arithmetic', requirements_mapped: 2 })
    expect(report.evidence_coverage).toMatchObject({ guided_fields: 14, evidenced_fields: 0, evidence_count: 0 })
    expect(report.next_checks.some((row: any) => row.field === 'price_per_unit')).toBe(true)
  })

  it('calculates deterministic monthly model values without inference', async () => {
    const report: any = await build({ ...baseInputs, price_per_unit: 10, units_per_month: 100,
      variable_cost_per_unit: 8, fixed_costs_per_month: 1000, payroll_per_month: 1000,
      setup_costs: 500, cash_available: 4000, runway_target_months: 3, funding_requested: 2000 }, undefined)
    expect(report.model_display).toMatchObject({ monthly_revenue: 'USD 1,000', monthly_variable_cost: 'USD 800',
      monthly_contribution: 'USD 200', monthly_operating_costs: 'USD 2,000', monthly_operating_result: 'USD -1,800',
      break_even_units: '1,000–1,000 units/month', funding_gap: 'USD 1,900', funding_requested_difference: 'USD 100' })
    expect(report.model.runway.status).toBe('calculated')
    expect(report.persisted).toBe(false)
  })

  it('applies Buy/Build requirements and keeps path-specific funding costs unknown until supplied', async () => {
    const missingPath: any = await build({ ...baseInputs, buy_build_path: 'buy_existing' }, undefined)
    expect(missingPath.check.completeness).toMatchObject({ required: 12, supplied: 10 })
    expect(missingPath.check.completeness.missing_fields).toEqual(['acquisition_price', 'transition_costs'])
    expect(missingPath.model_display.funding_gap).toContain('Unknown')

    const acquired: any = await build({ ...baseInputs, buy_build_path: 'buy_existing', acquisition_price: 10000,
      transition_costs: 1000, price_per_unit: 10, units_per_month: 100, variable_cost_per_unit: 8,
      fixed_costs_per_month: 1000, payroll_per_month: 1000, cash_available: 4000, runway_target_months: 3 }, undefined)
    expect(acquired.model_display.funding_gap).toBe('USD 12,400')
    expect(acquired.check.completeness.missing_fields).toEqual([])

    const scenarioInputs = Object.fromEntries(Object.entries(baseInputs).filter(([key]) => key !== 'buy_build_path'))
    const scenario: any = await invokeSmePackTool('business.plan.build', { pack_id: packId, mode: 'scenario',
      inputs: { ...scenarioInputs, setup_costs: 500, cash_available: 4000,
        runway_target_months: 3, price_per_unit: 10, units_per_month: 100, variable_cost_per_unit: 8,
        fixed_costs_per_month: 1000, payroll_per_month: 1000 } })
    expect(scenario.mode).toMatchObject({ id: 'scenario', label: 'Scenario' })
    expect(JSON.parse(scenario.worksheet.json)).toMatchObject({ schema: 'sme-business-plan/worksheet/v2', mode: 'scenario' })
    expect(scenario.check.completeness).toMatchObject({ required: 9, supplied: 9, missing_fields: [] })
    expect(scenario.model_display.funding_gap).toBe('USD 1,900')
  })

  it('propagates ranges and reports malformed values rather than coercing them', async () => {
    const report: any = await build({ ...baseInputs, price_per_unit: { low: 10, high: 20 }, units_per_month: 100,
      variable_cost_per_unit: { low: 2, high: 3 }, fixed_costs_per_month: 500, payroll_per_month: 100,
    }, undefined)
    expect(report.model.revenue_per_month).toEqual({ low: 1000, high: 2000 })
    expect(report.model.variable_cost_per_month).toEqual({ low: 200, high: 300 })
    await expect(build({ ...baseInputs, unknown_key: 2 }, undefined)).rejects.toThrow('sme_pack_unknown_field')
    const precision: any = await build({ ...baseInputs, price_per_unit: 0.00001 }, undefined)
    expect(precision.check.completeness.invalid_fields).toContain('price_per_unit')
    const text: any = await build({ ...baseInputs, problem_statement: 'https://invalid.example' }, undefined)
    expect(text.check.completeness.invalid_fields).toContain('problem_statement')
  })

  it('keeps evidence descriptive and rejects unsupported evidence metadata', async () => {
    const evidence = [{ field_key: 'market_basis', value: 'Notes from three interview sessions', provenance: 'directly_observed',
      observer_role: 'author', date: '2026-11-01' }]
    const report: any = await build(baseInputs, evidence)
    expect(report.check).toMatchObject({ evidence_count: 1, evidence_status: 'user-recorded; not authenticated' })
    await expect(build(baseInputs, [{ ...evidence[0], field_key: 'unlisted_field' }])).rejects.toThrow('sme_pack_evidence_invalid')
    await expect(build(baseInputs, [{ ...evidence[0], provenance: 'verified' }])).rejects.toThrow('sme_pack_evidence_invalid')
  })

  it('compares rows in entry order within the selected mode and refuses a mixed currency', async () => {
    const plan_sets = [
      { pack_id: packId, pack_version: '2.3.0', inputs: { ...baseInputs, venture_name: 'A' } },
      { pack_id: packId, pack_version: '2.3.0', inputs: { ...baseInputs, venture_name: 'B' } },
    ]
    const compared: any = await invokeSmePackTool('business.plan.compare', { mode: 'scenario', plan_sets })
    expect(compared).toMatchObject({ schema: 'sme-business-plan/comparison/v2', mode: { id: 'scenario' }, currency_code: 'USD',
      ranking: null, winner: null, conversion_applied: false, persisted: false })
    expect(compared.slots.map((slot: any) => slot.slot)).toEqual(['A', 'B', 'C'])
    expect(compared.slots[0].report.pitch_deck_outline[0].content).toBe('A · validation')
    await expect(invokeSmePackTool('business.plan.compare', { plan_sets: [plan_sets[0], {
      ...plan_sets[1], inputs: { ...baseInputs, currency_code: 'EUR' },
    }] })).rejects.toThrow('sme_pack_comparison_identity_mismatch')
  })

  it('routes the canonical build tool through the stateless local HTTP adapter', async () => {
    const result = await handleSmeBusinessPackRequest(request({ tool: 'business.plan.build',
      arguments: { pack_id: packId, inputs: baseInputs } }), 'local-unreleased')
    expect(result?.status).toBe(200)
    expect(await result?.json()).toMatchObject({ schema: 'sme-business-plan/report/v2', persisted: false, inference_tokens: 0 })
    const service = await handleSmeBusinessPackRequest(new Request(`https://local.test${PACK_PATH}/service.json`), 'local-unreleased')
    expect(await service?.json()).toMatchObject({ persistence: 'none', inferenceTokens: 0, packs: [{ id: packId }, { id: takeoverId }] })
  })

  it('accepts all 38 fields while context and stage never change arithmetic or completeness', async () => {
    const context = { opportunity_label: 'Option A', business_activity: 'Repairs', operating_area: 'Remote', transfer_reason: 'User-stated transition',
      buyer_budget: { low: 90000, high: 150000 }, target_handover_months: 2, operator_experience: 'related_reported',
      accounts_access: 'requested', permission_transfer_status: 'conditional', team_continuity: 'not_discussed',
      support_scope: 'User-stated support', review_stage: 'handover_planning', next_action: 'Clarify transition assumptions' }
    const args = { pack_id: takeoverId, inputs: { ...takeoverInputs, ...context } }
    const report: any = await invokeSmePackTool('business.plan.build', args)
    const baseline: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs })
    expect(report.model).toEqual(baseline.model)
    expect(report.check.completeness).toEqual(baseline.check.completeness)
    expect(Object.keys(JSON.parse(report.worksheet.json).inputs)).toHaveLength(38)
    expect(TOOL_SCHEMAS.find((tool: any) => tool.name === 'business.plan.build').inputSchema.properties.inputs.maxProperties).toBe(38)
    expect(report.next_checks.some((check: any) => check.field === 'accounts_access')).toBe(true)
    expect(report.next_checks.some((check: any) => check.field === 'next_action')).toBe(false)
    const reviewed: any = await invokeSmePackTool('business.plan.build', { ...args, inputs: { ...args.inputs, accounts_access: 'reviewed_by_user' } })
    expect(reviewed.next_checks.some((check: any) => check.field === 'accounts_access')).toBe(false)
    expect(reviewed.check.evidence_status).toBe('user-recorded; not authenticated')
    const unavailable: any = await invokeSmePackTool('business.plan.build', { ...args, inputs: { ...args.inputs, location_assignment_status: 'reported_not_available' } })
    expect(unavailable.next_checks.some((check: any) => check.field === 'location_assignment_status')).toBe(true)
    for (const value of ['https://example.test', 'person@example.test', '+65 8123 4567', 'Hidden\u0000text']) {
      const invalid: any = await invokeSmePackTool('business.plan.build', { ...args, inputs: { ...args.inputs, next_action: value } })
      expect(invalid.check.completeness.invalid_fields).toContain('next_action')
    }
  })

  it('does not turn unknown location obligations into zero and preserves explicit zero purchase amounts', async () => {
    for (const inputs of [{ ...takeoverInputs, location_obligation: 'unknown' }, { ...takeoverInputs, currency_code: undefined }] as Record<string, unknown>[]) {
      if (inputs.currency_code === undefined) delete inputs.currency_code
      const report: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs })
      for (const output of ['cash_to_close', 'cash_shortfall', 'operating_difference_per_month']) {
        expect(report.model[output]).toBeNull(); expect(report.model_display[output]).toContain('Unknown')
      }
    }
    const zero: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: { ...takeoverInputs, purchase_price: 0 } })
    expect(zero.model.cash_to_close).toEqual({ low: 37000, high: 37000 })
  })

  it('keeps basis/period mismatch checks separate from cash results in two and three row comparisons', async () => {
    const set = { pack_id: takeoverId, pack_version: '1.2.0', inputs: takeoverInputs }
    for (const delta of [{ financial_basis: 'historical_records' }, { financial_period_months: 12 }, { financial_basis: 'unknown' }, { financial_period_months: undefined }]) {
      const second: Record<string, unknown> = { ...takeoverInputs, ...delta }; if (second.financial_period_months === undefined) delete second.financial_period_months
      const result: any = await invokeSmePackTool('business.plan.compare', { mode: 'scenario', plan_sets: [set, { ...set, inputs: second }, set] })
      for (const slot of result.slots) {
        expect(slot.report.model.cash_to_close).toEqual({ low: 117000, high: 117000 })
        expect(slot.report.next_checks[0].action).toContain('not comparable on the supplied basis')
        expect(slot.report.worksheet.markdown).toContain('not comparable on the supplied basis')
      }
      expect(result.slots.map((slot: any) => slot.slot)).toEqual(['A', 'B', 'C'])
      expect(result.winner).toBeNull()
    }
    const same: any = await invokeSmePackTool('business.plan.compare', { plan_sets: [set, set] })
    expect(same.slots[0].report.next_checks.some((row: any) => row.label === 'Operating figure comparison')).toBe(false)
    await expect(invokeSmePackTool('business.plan.compare', { plan_sets: [set, { ...set, pack_version: '1.1.0' }] })).rejects.toThrow('sme_pack_comparison_identity_mismatch')
  })

  it('binds all worksheet rows to exact identity and rejects stale, malformed and oversized imports', async () => {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: takeoverId })
    const report = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs })
    const sheet = JSON.parse(report.worksheet.json), rows = [sheet, { ...sheet, inputs: { ...sheet.inputs, next_action: 'Review second option ~~~json, \"notes\"' } }]
    for (const format of ['json', 'csv']) {
      const encoded = serializeSmeWorksheets(rows, format)
      expect(await readSmeWorksheets(encoded, format, protocol.pack)).toEqual(rows)
      await expect(readSmeWorksheets(serializeSmeWorksheets([sheet, { ...sheet, pack_version: '1.1.0' }], format), format, protocol.pack)).rejects.toThrow('sme_pack_worksheet_identity')
      await expect(readSmeWorksheets(serializeSmeWorksheets([sheet, { ...sheet, inputs: { ...sheet.inputs, buyer_budget: -1 } }], format), format, protocol.pack)).rejects.toThrow('sme_pack_worksheet_invalid')
    }
    const markdown = (await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: rows[1].inputs })).worksheet.markdown
    expect(await readSmeWorksheets(markdown, 'md', protocol.pack)).toEqual([rows[1]])
    const csv = serializeSmeWorksheets(rows, 'csv')
    await expect(readSmeWorksheets(csv.replace('\"plan\"', '\"plan\"junk'), 'csv', protocol.pack)).rejects.toThrow('sme_pack_worksheet_invalid')
    await expect(readSmeWorksheets('"kind","key","value","provenance","observer_role","date"', 'csv', protocol.pack)).rejects.toThrow('sme_pack_worksheet_identity')
    await expect(readSmeWorksheets('界'.repeat(22000), 'json', protocol.pack)).rejects.toThrow('sme_pack_worksheet_limit')
  })

  it('retains byte limits for maximum Unicode evidence and caps individual as well as comparison reports', async () => {
    const evidence = Array.from({ length: 40 }, () => ({ field_key: 'support_scope', value: '界'.repeat(280),
      provenance: 'self_reported', observer_role: 'author', date: '2026-11-06' }))
    await expect(invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs, evidence })).rejects.toThrow('sme_pack_arguments_invalid')
    const responseHeavy = evidence.map(row => ({ ...row, value: '"'.repeat(280) }))
    await expect(invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs, evidence: responseHeavy })).rejects.toThrow('sme_pack_response_too_large')
    const valid = evidence.map(row => ({ ...row, value: 'Context' }))
    const report: any = await invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs, evidence: valid })
    expect(report.evidence_coverage.evidence_count).toBe(40)
    await expect(invokeSmePackTool('business.plan.build', { pack_id: takeoverId, inputs: takeoverInputs, evidence: [...valid, valid[0]] })).rejects.toThrow('sme_pack_evidence_invalid')
  })

  it('exposes the same protocol and review calculations through API and MCP tools', async () => {
    const args = { pack_id: takeoverId, inputs: { ...takeoverInputs, review_stage: 'closed_by_user', accounts_access: 'requested' } }
    const local: any = await invokeSmePackTool('business.plan.build', args)
    const api = await handleSmeBusinessPackRequest(request({ tool: 'business.plan.build', arguments: args }), 'local-unreleased')
    expect(await api?.json()).toMatchObject({ model: local.model, next_checks: local.next_checks })
    for (const [method, params] of [['tools/list', {}], ['tools/call', { name: 'pack.protocol', arguments: { pack_id: takeoverId } }], ['tools/call', { name: 'business.plan.build', arguments: args }]] as const) {
      const response = await handleSmeBusinessPackRequest(new Request(`https://local.test${PACK_PATH}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), 'local-unreleased')
      expect(response?.status).toBe(200)
      const body: any = await response?.json()
      expect(body.error).toBeUndefined(); expect(body.result.isError).not.toBe(true)
      if (method === 'tools/list') expect(body.result.tools.map((tool: any) => tool.name)).toEqual(TOOL_NAMES)
      else if (params.name === 'pack.protocol') expect(body.result.structuredContent.input_fields).toHaveLength(38)
      else expect(body.result.structuredContent).toMatchObject({ model: local.model, next_checks: local.next_checks })
    }
  })

})
