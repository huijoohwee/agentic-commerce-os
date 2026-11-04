import { describe, expect, it } from 'vitest'
// @ts-expect-error The browser-safe JavaScript module is shared by the Worker and UI.
import { invokeSmePackTool, PACK_INDEX, PACK_PATH, TOOL_NAMES, TOOL_SCHEMAS } from '../../public/local-first/sme-business-pack-core.js'
import { handleSmeBusinessPackRequest } from '../../src/local-first/sme-business-pack'

const packId = 'sme.business-plan'
const baseInputs = {
  venture_stage: 'validation', problem_statement: 'A recurring task takes too much time.',
  target_customer: 'A group the author can reach for interviews.', solution_offer: 'A simple service for the task.',
  business_model: 'A user-selected price per unit.', go_to_market: 'A small opt-in trial.',
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
    expect(PACK_INDEX).toMatchObject([{ id: packId, label: 'General business plan', version: '2.1.0', review_status: 'provisional' }])
    expect(TOOL_NAMES).toEqual(['pack.list', 'pack.protocol', 'business.plan.build', 'business.plan.compare'])
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toMatch(/country|sector|SGD|takeover|listing/i)
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: packId })
    expect(protocol).toMatchObject({ schema: 'sme-business-plan/protocol/v2', inference_tokens: 0,
      guideline_alignment: { schema: 'sme-business-plan/guideline-alignment/v1', join_rule: 'continuity_id@revision' } })
    expect(protocol.guideline_alignment.projections.map((row: any) => row.id)).toEqual(['pitch_deck', 'business_plan', 'financial_model'])
    expect(protocol.guideline_sources.map((row: any) => row.id)).toContain('parent_prd')
    expect(protocol.pack).not.toHaveProperty('country')
    expect(protocol.pack).not.toHaveProperty('currency')
    expect(protocol.input_fields.map((field: any) => field.name)).toContain('problem_statement')
    expect(protocol.model_outputs.map((output: any) => output.id)).toContain('funding_requested_difference')
    expect(protocol.artifacts.map((artifact: any) => artifact.id)).toEqual(['pitch_deck_outline'])
    expect(protocol.parameters).toEqual([])
    await expect(invokeSmePackTool('pack.protocol', { pack_id: 'other.plan' })).rejects.toThrow('sme_pack_not_found')
  })

  it('returns explicit unknowns for blank financial assumptions and preserves required completeness', async () => {
    const report: any = await build(baseInputs, undefined)
    expect(report).toMatchObject({ schema: 'sme-business-plan/report/v1', inference_tokens: 0, persisted: false })
    expect(report.check.completeness).toMatchObject({ required: 9, supplied: 9, missing_fields: [], invalid_fields: [] })
    expect(report.model_display.monthly_revenue).toContain('Unknown')
    expect(report.model.missing_inputs.monthly_revenue).toEqual(['price_per_unit', 'units_per_month'])
    expect(report.pitch_deck_outline.some((row: any) => row.section === 'Financial model')).toBe(true)
    expect(report.pitch_deck_outline).toHaveLength(12)
    expect(report.pitch_deck_outline.every((row: any) => Array.isArray(row.field_keys))).toBe(true)
    expect(report.pitch_deck_outline[9].model_output_keys).toContain('monthly_revenue')
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

  it('compares two or three scenarios in entry order and refuses a mixed currency', async () => {
    const plan_sets = [
      { pack_id: packId, pack_version: '2.1.0', inputs: { ...baseInputs, venture_name: 'A' } },
      { pack_id: packId, pack_version: '2.1.0', inputs: { ...baseInputs, venture_name: 'B' } },
    ]
    const compared: any = await invokeSmePackTool('business.plan.compare', { plan_sets })
    expect(compared).toMatchObject({ schema: 'sme-business-plan/comparison/v1', currency_code: 'USD',
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
    expect(await result?.json()).toMatchObject({ schema: 'sme-business-plan/report/v1', persisted: false, inference_tokens: 0 })
    const service = await handleSmeBusinessPackRequest(new Request(`https://local.test${PACK_PATH}/service.json`), 'local-unreleased')
    expect(await service?.json()).toMatchObject({ persistence: 'none', inferenceTokens: 0, packs: [{ id: packId }] })
  })
})
