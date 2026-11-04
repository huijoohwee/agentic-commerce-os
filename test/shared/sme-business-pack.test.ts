import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// @ts-expect-error The browser-safe JavaScript module is shared by the Worker and UI.
import { invokeSmePackTool, PACK_INDEX, TOOL_NAMES, TOOL_SCHEMAS } from '../../public/local-first/sme-business-pack-core.js'
import { handleSmeBusinessPackRequest, SME_PACK_LIMITS, SME_PACK_TOOLS } from '../../src/local-first/sme-business-pack'
import { default as localFirstWorker, type LocalFirstEnv } from '../../src/local-first/worker'

const fixture = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/sme-business-pack-v1.json'), 'utf8'))
const baseFacts = {
  asset_subtype: 'cafe', business_age_band: '3_5', legal_form: 'private_limited', seating_band: 'b2', staff_band: 'b2',
  asking_price_band: 'b3', monthly_sales_band: 'b3', monthly_rent_band: 'b2', lease_remaining_band: 'b3', licence_status: 'unknown',
  equipment_included: true, inventory_included: false, sale_reason: 'relocation', handover_support_band: 'b2',
}
function factsFor(row: Record<string, any>) {
  const facts: Record<string, unknown> = { ...baseFacts }
  if (row.omit) delete facts[row.omit]
  if (row.country_code) facts.country_code = row.country_code
  if (row.rent) facts.monthly_rent_band = row.rent
  if (row.sales) facts.monthly_sales_band = row.sales
  if (row.addUnknown) facts.private_contact = 'DO-NOT-ECHO@example.invalid'
  if (row.invalidSubtype) facts.asset_subtype = row.invalidSubtype
  return facts
}
const baseCashClaims = {
  listing_source: 'classifieds', subtype: 'cafe', price: 150000, equipment_included: true, equipment_cost: 0,
  rent_monthly: 6000, lease_remaining_months: 24, deposit_months: 3, utilities_deposits: 2500,
  transfer_cost: 8000, repairs_provision: 12000, monthly_sales: 45000, staff_count: 5,
  payroll_monthly: 14000, utilities_monthly: 900, runway_months: 3, variable_cost_bps: 3500, licence_status: 'unknown',
}
function oracleRange(value: any) {
  return typeof value === 'number' ? { low: value, high: value } : { low: value.low, high: value.high }
}
function oracleBudget(claims: Record<string, any>) {
  const rent = oracleRange(claims.rent_monthly), price = oracleRange(claims.price)
  const payroll = oracleRange(claims.payroll_monthly), utilities = oracleRange(claims.utilities_monthly)
  const fixed = { low: rent.low + payroll.low + utilities.low, high: rent.high + payroll.high + utilities.high }
  const lines = [
    oracleRange(claims.price), oracleRange(claims.equipment_cost),
    { low: rent.low * claims.deposit_months, high: rent.high * claims.deposit_months },
    oracleRange(claims.utilities_deposits), oracleRange(claims.transfer_cost), oracleRange(claims.repairs_provision),
    { low: fixed.low * claims.runway_months, high: fixed.high * claims.runway_months },
  ]
  const low = lines.reduce((sum, line) => sum + line.low, 0), high = lines.reduce((sum, line) => sum + line.high, 0)
  return { lines, total: { low, high }, lease: { low: rent.low * claims.lease_remaining_months, high: rent.high * claims.lease_remaining_months },
    gap: { low: low - price.high, high: high - price.low },
    breakEven: { low: Math.ceil(fixed.low * 10000 / (10000 - claims.variable_cost_bps)),
      high: Math.ceil(fixed.high * 10000 / (10000 - claims.variable_cost_bps)) } }
}

describe('SME takeover pack contracts', () => {
  it('lists the current provisional pack and keeps the tool envelope pack-neutral', async () => {
    expect((PACK_INDEX as Array<{ id: string }>).map(pack => pack.id)).toEqual(['sg.fnb.takeover'])
    expect(await invokeSmePackTool('pack.list')).toMatchObject({ inference_tokens: 0, packs: [
      { id: 'sg.fnb.takeover', review_status: 'provisional', as_of: '2026-10-22' },
    ] })
    expect(TOOL_NAMES).toEqual(['pack.list', 'pack.protocol', 'takeover.check', 'takeover.budget', 'takeover.plan', 'takeover.compare_claim_sets', 'takeover.transfer_checklist'])
    expect(TOOL_SCHEMAS).toHaveLength(7)
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toContain('my.fnb.takeover')
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toContain('sg.fnb.takeover')
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toContain('SGD')
    expect(TOOL_SCHEMAS.find((tool: any) => tool.name === 'pack.protocol')?.inputSchema.properties.pack_id.pattern)
      .toBe('^[a-z0-9][a-z0-9._-]{0,63}$')
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: 'sg.fnb.takeover' })
    expect(protocol).toMatchObject({ schema: 'sme-business-pack/protocol/v1', parameters: [],
      ratios: [{ id: 'rent_to_sales', basis: 'arithmetic-sanity-only', reviewed: false }], tolerances: [], inference_tokens: 0 })
    expect(protocol).not.toHaveProperty('fields')
    expect(protocol.claim_kinds.map((field: any) => field.name)).toContain('price')
    expect(protocol.budget_lines).toHaveLength(7)
    await expect(invokeSmePackTool('pack.protocol', { pack_id: 'my.fnb.takeover' })).rejects.toThrow('sme_pack_not_found')
    const required = await invokeSmePackTool('pack.required_fields', { pack_id: 'sg.fnb.takeover' })
    expect(required.fields).toHaveLength(15)
    expect(required.fields.find((field: any) => field.name === 'asking_price_band')).toMatchObject({ type: 'money_band', currency: 'SGD' })
    await expect(invokeSmePackTool('pack.required_fields', { pack_id: '../other' })).rejects.toThrow('sme_pack_not_found')
  })

  it('preserves the legacy SG contract and refuses the deferred MY fixtures', async () => {
    expect(fixture.schema).toBe('sme-business-pack-fixtures/v1')
    expect(fixture.cases).toHaveLength(40)
    expect(fixture.cases.filter((row: any) => row.pack_id === 'sg.fnb.takeover')).toHaveLength(20)
    expect(fixture.cases.filter((row: any) => row.pack_id === 'my.fnb.takeover')).toHaveLength(20)
    for (const row of fixture.cases) {
      if (row.pack_id === 'my.fnb.takeover') {
        await expect(invokeSmePackTool('takeover.check_listing', { pack_id: row.pack_id, facts: factsFor(row) }))
          .rejects.toThrow('sme_pack_not_found')
        continue
      }
      const report = await invokeSmePackTool('takeover.check_listing', { pack_id: row.pack_id, facts: factsFor(row) }, Date.parse('2026-10-22'))
      expect(report.schema, row.id).toBe('sme-business-pack/check-report/v1')
      expect(report.label, row.id).toBe('Indicative, not verified')
      expect(report.pack.review_status, row.id).toBe('provisional')
      expect(report.persisted, row.id).toBe(false)
      expect(report.inference_tokens, row.id).toBe(0)
      if (row.omit) expect(report.missing_fields, row.id).toContain(row.omit)
      else expect(report.missing_fields, row.id).toEqual([])
      if (row.country_code) expect(report.flags.some((flag: any) => flag.code === 'pack_country_mismatch'), row.id).toBe(true)
      if (row.rent === 'b5' && row.sales === 'b1') expect(report.flags.some((flag: any) => flag.ratio === 'rent_to_sales'), row.id).toBe(true)
      if (row.rent === 'b1' && row.sales === 'b5') expect(report.flags, row.id).toEqual([])
      if (row.addUnknown) {
        expect(report.unknown_fields_dropped).toBe(1)
        expect(JSON.stringify(report)).not.toContain('DO-NOT-ECHO')
      }
      if (row.invalidSubtype) {
        expect(report.invalid_fields).toContain('asset_subtype')
        expect(JSON.stringify(report)).not.toContain('<img')
      }
    }
  })

  it('matches an independent budget oracle across 30 labelled SG fixtures', async () => {
    expect(fixture.cash_cases).toHaveLength(30)
    const durations: number[] = [], checkDurations: number[] = []
    for (const row of fixture.cash_cases) {
      const claims = { ...baseCashClaims, ...row.claims }, expected = oracleBudget(claims)
      const started = performance.now()
      const report = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims })
      durations.push(performance.now() - started)
      const checkStarted = performance.now()
      const check = await invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims })
      checkDurations.push(performance.now() - checkStarted)
      expect(check.schema, row.id).toBe('sme-business-pack/check-report/v2')
      expect(check.inference_tokens, row.id).toBe(0)
      expect(report.schema, row.id).toBe('sme-business-pack/budget-report/v1')
      expect(report.budget.cash_to_close).toMatchObject({ ...expected.total, incomplete: false })
      expect(report.budget.gap_above_asking_price).toEqual(expected.gap)
      expect(report.budget.lease_exposure).toMatchObject(expected.lease)
      expect(report.budget.monthly_fixed_cost).toEqual({
        low: oracleRange(claims.rent_monthly).low + claims.payroll_monthly + claims.utilities_monthly,
        high: oracleRange(claims.rent_monthly).high + claims.payroll_monthly + claims.utilities_monthly,
      })
      expect(report.budget.break_even_monthly_sales).toEqual(expected.breakEven)
      expect(report.budget.arithmetic_flags.some((flag: any) => flag.ratio === 'rent_to_sales')).toBe(false)
      expect(report.budget.lines.map((line: any) => ({ low: line.low, high: line.high }))).toEqual(expected.lines)
      expect(report.budget.cash_to_close.low).toBeLessThanOrEqual(report.budget.cash_to_close.high)
      expect(report.budget.lines.every((line: any) => line.low <= line.high)).toBe(true)
      expect(report.budget.unchecked_share).toBe(1)
      expect(report.persisted).toBe(false)
    }
    expect([...durations].sort((a, b) => a - b)[28]).toBeLessThan(2000)
    expect([...checkDurations].sort((a, b) => a - b)[28]).toBeLessThan(2000)
  })

  it('reports every omitted required cash claim from the pack protocol', async () => {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: 'sg.fnb.takeover' })
    for (const field of protocol.claim_kinds.filter((row: any) => row.required)) {
      const claims = { ...baseCashClaims }; delete (claims as Record<string, unknown>)[field.name]
      const report = await invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims })
      expect(report.completeness.missing_claims).toContain(field.name)
    }
  })

  it('compares two or three claim sets in fixed slots with the individual plan result across 30 cash fixtures', async () => {
    const identity = { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD' }
    const cases = fixture.cash_cases, testedAt = 1793481600000
    let firstPair, firstTriple
    const pairDurations: number[] = [], tripleDurations: number[] = []
    const p95 = (samples: number[]) => [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]!
    for (let index = 0; index < cases.length; index++) {
      const selected = [cases[index], cases[(index + 1) % cases.length], cases[(index + 2) % cases.length]]
      const pairs = selected.slice(0, 2).map(row => ({ ...identity, claims: row.claims }))
      expect(new TextEncoder().encode(JSON.stringify({ claim_sets: pairs })).byteLength).toBeLessThanOrEqual(32768)
      const pairStarted = performance.now()
      const compared = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: pairs }, testedAt)
      pairDurations.push(performance.now() - pairStarted)
      expect(new TextEncoder().encode(JSON.stringify(compared)).byteLength).toBeLessThanOrEqual(65536)
      expect(JSON.stringify(compared)).not.toMatch(/winner|rank|score|recommendation/iu)
      expect(compared.slots.map((slot: any) => slot.slot)).toEqual(['A', 'B', 'C'])
      expect(compared.slots[2]).toEqual({ slot: 'C', status: 'not_supplied', report: null })
      for (let slotIndex = 0; slotIndex < pairs.length; slotIndex++) {
        const individual = await invokeSmePackTool('takeover.plan', { pack_id: identity.pack_id, claims: pairs[slotIndex]!.claims }, testedAt)
        expect(compared.slots[slotIndex]).toMatchObject({ status: 'included', report: individual })
        expect(compared.slots[slotIndex].report.pack).toMatchObject({ id: identity.pack_id,
          version: identity.pack_version, currency: identity.currency, as_of: '2026-10-22' })
      }
      expect(compared).toMatchObject({ inference_tokens: 0, persisted: false, pack: { id: identity.pack_id,
        version: identity.pack_version, currency: identity.currency, as_of: '2026-10-22' } })

      const claim_sets = selected.map(row => ({ ...identity, claims: row.claims }))
      expect(new TextEncoder().encode(JSON.stringify({ claim_sets })).byteLength).toBeLessThanOrEqual(32768)
      const tripleStarted = performance.now()
      const three = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets }, testedAt)
      tripleDurations.push(performance.now() - tripleStarted)
      expect(new TextEncoder().encode(JSON.stringify(three)).byteLength).toBeLessThanOrEqual(65536)
      expect(JSON.stringify(three)).not.toMatch(/winner|rank|score|recommendation/iu)
      expect(three.slots.map((slot: any) => slot.slot)).toEqual(['A', 'B', 'C'])
      for (let slotIndex = 0; slotIndex < claim_sets.length; slotIndex++) {
        const individual = await invokeSmePackTool('takeover.plan', { pack_id: identity.pack_id,
          claims: claim_sets[slotIndex]!.claims }, testedAt)
        expect(three.slots[slotIndex]).toMatchObject({ status: 'included', report: individual })
        expect(three.slots[slotIndex].report.pack).toMatchObject({ id: identity.pack_id,
          version: identity.pack_version, currency: identity.currency, as_of: '2026-10-22' })
      }
      if (index === 0) { firstPair = { claim_sets: pairs, result: compared }; firstTriple = { claim_sets, result: three } }
    }
    const repeatedPair = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: firstPair!.claim_sets }, testedAt)
    const repeatedTriple = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: firstTriple!.claim_sets }, testedAt)
    expect(p95(pairDurations)).toBeLessThan(2000)
    expect(p95(tripleDurations)).toBeLessThan(2000)
    expect(repeatedPair).toEqual(firstPair!.result)
    expect(repeatedTriple).toEqual(firstTriple!.result)
    const three = firstTriple!.result
    expect(three.slots.every((slot: any) => slot.status === 'included' && slot.report?.tasks)).toBe(true)
  })

  it('rejects comparison identity drift before evaluating claims and refuses open candidate data', async () => {
    const base = { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD', claims: { private_contact: 'name@example.invalid' } }
    for (const second of [{ ...base, pack_version: '0.9.0' }, { ...base, currency: 'MYR' }, { ...base, pack_id: 'my.fnb.takeover' }]) {
      await expect(invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: [base, second] }))
        .rejects.toThrow('sme_pack_comparison_identity_mismatch')
    }
    for (const forbidden of [
      { candidate_name: 'Cafe A' }, { url: 'https://example.invalid' },
      { contact: 'buyer@example.invalid' }, { address: '1 Example Road' },
    ]) await expect(invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: [base, { ...base, ...forbidden }] }))
      .rejects.toThrow('sme_pack_arguments_invalid')
    await expect(invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: [
      { ...base, claims: { ...base.claims, subtype: 'https://example.invalid' } }, { ...base, claims: {} },
    ] })).rejects.toThrow('sme_pack_free_text_refused')
    for (const claim_sets of [[], [base], [base, base, base, base]]) {
      await expect(invokeSmePackTool('takeover.compare_claim_sets', { claim_sets })).rejects.toThrow('sme_pack_arguments_invalid')
    }
  })

  it('keeps evidence tier calculations isolated to the comparison slot that supplied them', async () => {
    const identity = { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD' }
    const evidence = [{ claim_kind: 'price', value: 150000, provenance: 'document_sighted',
      observer_role: 'adviser', date: '2026-10-31' }]
    const result: any = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: [
      { ...identity, claims: { price: 150000 }, evidence }, { ...identity, claims: { price: 180000 } },
    ] })
    expect(result.slots[0].report.check.claim_counts_by_tier.T2).toBe(1)
    expect(result.slots[0].report.budget.budget.lines.find((line: any) => line.id === 'L1').checked).toBe(true)
    expect(result.slots[1].report.check.claim_counts_by_tier.T2).toBe(0)
  })

  it('keeps unchecked share monotonic as each cash claim reaches its retiring tier', async () => {
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: 'sg.fnb.takeover' }), evidence: any[] = []
    const cashClaims = baseCashClaims as Record<string, unknown>
    let share = (await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims })).budget.unchecked_share
    expect(share).toBe(1)
    for (const field of protocol.claim_kinds.filter((row: any) => row.retiring_tier && cashClaims[row.name] !== undefined)) {
      evidence.push({ claim_kind: field.name, value: cashClaims[field.name], provenance: 'document_sighted',
        observer_role: 'adviser', date: '2026-10-31' })
      const report = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims, evidence })
      expect(report.budget.unchecked_share).toBeLessThanOrEqual(share); share = report.budget.unchecked_share
    }
    evidence.push({ claim_kind: 'rent_monthly', value: baseCashClaims.rent_monthly, provenance: 'third_party_confirmed',
      observer_role: 'adviser', date: '2026-10-31' })
    const final = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims, evidence })
    expect(final.budget.unchecked_share).toBeLessThanOrEqual(share)
  })

  it('reports planted claim conflicts without claiming a verified discrepancy', async () => {
    for (const row of fixture.cash_cases) {
      const claims = { ...baseCashClaims, ...row.claims }, price = claims.price
      const priceRange = typeof price === 'object' && price !== null ? price : null
      const observed = priceRange ? { low: priceRange.low + 1, high: priceRange.high + 1 } : Number(price) + 1
      const report = await invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims,
        evidence: [{ claim_kind: 'price', value: observed, provenance: 'document_sighted', observer_role: 'adviser', date: '2026-10-31' }] })
      expect(report.raw_differences).toContainEqual(expect.objectContaining({ claim_kind: 'price', observed }))
      expect(report.raw_differences.some((difference: any) => difference.status === 'discrepancy')).toBe(false)
      expect(report.evidence_results.find((item: any) => item.claim_kind === 'price').status).toBe('unsupported')
      expect(report.tolerances_applied).toBe(false)
    }
    const exact = await invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims,
      evidence: [{ claim_kind: 'price', value: baseCashClaims.price, provenance: 'document_sighted', observer_role: 'adviser', date: '2026-10-31' }] })
    expect(exact.raw_differences).toEqual([])
  })

  it('serves the same seven tools offline through the local stdio MCP adapter', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/sme-business-pack-local.mjs'] })
    const client = new Client({ name: 'sme-local-contract', version: '1.0.0' }, { capabilities: {} })
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(TOOL_NAMES)
      expect(JSON.stringify(listed.tools)).not.toContain('my.fnb.takeover')
      const compare = { claim_sets: [150000, 180000].map(price => ({ pack_id: 'sg.fnb.takeover',
        pack_version: '1.0.0', currency: 'SGD', claims: { price } })) }
      const routes: Record<string, Record<string, unknown>> = {
        'pack.list': {}, 'pack.protocol': { pack_id: 'sg.fnb.takeover' },
        'takeover.check': { pack_id: 'sg.fnb.takeover', claims: baseCashClaims },
        'takeover.budget': { pack_id: 'sg.fnb.takeover', claims: baseCashClaims },
        'takeover.plan': { pack_id: 'sg.fnb.takeover', claims: baseCashClaims },
        'takeover.compare_claim_sets': compare, 'takeover.transfer_checklist': { pack_id: 'sg.fnb.takeover' },
      }
      for (const name of TOOL_NAMES) {
        const expected = await invokeSmePackTool(name, routes[name]!)
        const actual = await client.callTool({ name, arguments: routes[name]! })
        expect(actual.structuredContent).toEqual(expected)
      }
      expect((await client.callTool({ name: 'takeover.check_listing', arguments: {
        pack_id: 'sg.fnb.takeover', facts: baseFacts,
      } })).structuredContent).toMatchObject({ schema: 'sme-business-pack/check-report/v1' })
    } finally { await client.close() }
  })

  it('keeps missing cash lines unknown, computes evidence tiers without unreviewed tolerances, and ranks tasks', async () => {
    const claims: Record<string, any> = { ...baseCashClaims }
    delete claims.price
    const incomplete = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims })
    expect(incomplete.budget.incomplete).toBe(true)
    expect(incomplete.budget.lines[0]).toMatchObject({ id: 'L1', low: null, high: null, complete: false })
    expect(incomplete.budget.cash_to_close).toMatchObject({ high: null, incomplete: true, basis: 'known-subtotal-lower-bound' })
    expect(incomplete.budget.cash_to_close.low).toBeGreaterThan(0)
    const t0 = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims,
      evidence: [{ claim_kind: 'price', provenance: 'seller_stated', observer_role: 'buyer', date: '2026-10-31', value: 150000 }] })
    expect(t0.budget.unchecked_share).toBe(1)
    const evidence = [
      { claim_kind: 'price', provenance: 'document_sighted', observer_role: 'buyer', date: '2026-10-31', value: 155000 },
      { claim_kind: 'equipment_cost', provenance: 'counted_on_site', observer_role: 'field_checker', date: '2026-10-31', value: 0 },
      { claim_kind: 'rent_monthly', provenance: 'third_party_confirmed', observer_role: 'adviser', date: '2026-10-31', value: 6100 },
    ]
    const check = await invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims, evidence })
    expect(check.tolerances_applied).toBe(false)
    expect(check.evidence_results.find((row: any) => row.claim_kind === 'price')).toMatchObject({ status: 'unsupported', tier: 'T2' })
    expect(check.raw_differences).toContainEqual(expect.objectContaining({ claim_kind: 'price', claimed: 150000, observed: 155000 }))
    expect(check.raw_differences.some((row: any) => row.status === 'discrepancy')).toBe(false)
    const report = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims, evidence })
    expect(report.budget.unchecked_share).toBeLessThan(1)
    expect(report.budget.arithmetic_flags).toEqual([])
    const rentRatio = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: {
      ...baseCashClaims, rent_monthly: 60000,
    } })
    expect(rentRatio.budget.arithmetic_flags).toContainEqual(expect.objectContaining({
      code: 'rent_to_sales_arithmetic_bound', ratio: 'rent_to_sales', observation: 'above',
      limit: 1, basis: 'arithmetic-sanity-only', reviewed: false,
    }))
    const plan = await invokeSmePackTool('takeover.plan', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims, evidence })
    expect(plan.tasks.map((task: any) => task.cash_retired_midpoint)).toEqual(
      [...plan.tasks.map((task: any) => task.cash_retired_midpoint)].sort((a: number, b: number) => b - a))
    expect(plan.worksheet.json).toContain('sme-business-pack/worksheet/v1')
    expect(plan.worksheet.csv).toContain('"kind","key","value","provenance","observer_role","date"')
    expect(plan.worksheet.markdown).toContain(String.fromCharCode(96).repeat(3) + 'json')
    expect(plan.persisted).toBe(false)
  })

  it('rejects open text and personal data while dropping harmless unknown numeric claims', async () => {
    const result = await invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover',
      claims: { ...baseCashClaims, unused_numeric_hint: 7 } })
    expect(result.unknown_fields_dropped).toBe(1)
    for (const claims of [
      { ...baseCashClaims, private_contact: 'person@example.invalid' },
      { ...baseCashClaims, counterparty_name: 'Someone' },
      { ...baseCashClaims, listing_source: 'https://example.invalid' },
      { ...baseCashClaims, subtype: 'a free-form story' },
    ]) await expect(invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims }))
      .rejects.toThrow('sme_pack_free_text_refused')
    const prohibited = [
      'business_name', 'business_description', 'candidate_name', 'seller_name', 'buyer_name', 'counterparty_name',
      'contact', 'phone', 'email', 'address', 'website', 'listing_url', 'photo', 'image', 'valuation',
      'price_opinion', 'brokerage_fee', 'success_fee', 'introduction', 'private_notes',
    ] as const
    expect(prohibited).toHaveLength(20)
    for (const field of prohibited) await expect(invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover',
      claims: { ...baseCashClaims, [field]: field === 'image' || field === 'photo' ? { data: 'base64' } : 'restricted' } }))
      .rejects.toThrow('sme_pack_free_text_refused')
    await expect(invokeSmePackTool('takeover.check', { pack_id: 'sg.fnb.takeover', claims: {
      ...baseCashClaims, price: 100000001,
    } })).resolves.toMatchObject({ completeness: { invalid_claims: ['price'] } })
  })

  it('withholds all transfer-checklist content until a qualified reviewer approves the pack', async () => {
    for (const pack of PACK_INDEX as Array<{ id: string }>) {
      expect(await invokeSmePackTool('takeover.transfer_checklist', { pack_id: pack.id })).toMatchObject({
        available: false, withheld: true, reason: 'qualified_reviewer_approval_required', checklist: [], pack: { review_status: 'provisional' },
      })
    }
  })

  it('keeps local SME computation free of network clients and browser storage', () => {
    for (const file of ['public/local-first/sme-business-pack-core.js', 'public/local-first/sme-business-pack.js']) {
      const source = fs.readFileSync(path.resolve(file), 'utf8')
      expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB)\b/u)
    }
  })

  it('keeps every buyer report typed, versioned, sourced and neutral in its output wording', async () => {
    const args = { pack_id: 'sg.fnb.takeover', claims: baseCashClaims }
    const comparison: any = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets: [
      { pack_id: args.pack_id, pack_version: '1.0.0', currency: 'SGD', claims: baseCashClaims },
      { pack_id: args.pack_id, pack_version: '1.0.0', currency: 'SGD', claims: baseCashClaims },
    ] })
    const reports = [await invokeSmePackTool('takeover.check', args), await invokeSmePackTool('takeover.budget', args),
      await invokeSmePackTool('takeover.plan', args), ...comparison.slots.map((slot: any) => slot.report).filter(Boolean)]
    for (const report of reports) {
      expect(report.label).toBe('Indicative, not verified')
      expect(report.pack).toMatchObject({ id: 'sg.fnb.takeover', version: '1.0.0', as_of: '2026-10-22' })
      const counts = report.check?.claim_counts_by_tier ?? report.claim_counts_by_tier
      expect(counts).toEqual(expect.objectContaining({ T0: expect.any(Number), T1: expect.any(Number), T2: expect.any(Number), T3: expect.any(Number) }))
    }
    expect(JSON.stringify(reports)).not.toMatch(/\b(?:fair|overpriced|good deal|price opinion|composite score|verdict|recommendation)\b/iu)
  })

  it('rejects credentials, foreign origins, oversized bodies, invalid release identity, and unknown routes', async () => {
    const request = (body: unknown, extra: Record<string, string> = {}) => new Request('https://local.test' + '/agentic-commerce-os/services/sme-business-pack/api', {
      method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
    })
    expect((await handleSmeBusinessPackRequest(request({ tool: 'pack.list', arguments: {} }), 'local-unreleased'))?.status).toBe(200)
    const localBudget = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims })
    const apiBudget = await handleSmeBusinessPackRequest(request({ tool: 'takeover.budget',
      arguments: { pack_id: 'sg.fnb.takeover', claims: baseCashClaims } }), 'local-unreleased')
    expect(apiBudget?.status).toBe(200)
    expect(await apiBudget?.json()).toEqual(localBudget)
    const claim_sets = [150000, 180000].map(price => ({ pack_id: 'sg.fnb.takeover', pack_version: '1.0.0',
      currency: 'SGD', claims: { ...baseCashClaims, price } }))
    const localComparison = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets })
    const apiComparison = await handleSmeBusinessPackRequest(request({ tool: 'takeover.compare_claim_sets',
      arguments: { claim_sets } }), 'local-unreleased')
    expect(apiComparison?.status).toBe(200)
    expect(await apiComparison?.json()).toEqual(localComparison)
    for (const headers of [{ authorization: 'Bearer secret' }, { cookie: 'sid=secret' }, { origin: 'https://other.invalid' }]) {
      expect((await handleSmeBusinessPackRequest(request({ tool: 'pack.list', arguments: {} }, headers), 'local-unreleased'))?.status).toBe(403)
    }
    expect((await handleSmeBusinessPackRequest(new Request('https://local.test/agentic-commerce-os/services/sme-business-pack/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(SME_PACK_LIMITS.requestBytes + 1),
    }), 'local-unreleased'))?.status).toBe(413)
    const releaseSha = 'a'.repeat(40)
    const production = await handleSmeBusinessPackRequest(request({ tool: 'pack.list', arguments: {} }), releaseSha)
    expect(production?.status).toBe(200)
    expect(await production?.json()).toMatchObject({ inference_tokens: 0, packs: [{ id: 'sg.fnb.takeover' }] })
    const localDescriptor = await handleSmeBusinessPackRequest(new Request('https://local.test/agentic-commerce-os/services/sme-business-pack/service.json'), 'local-unreleased')
    expect(localDescriptor?.headers.get('cache-control')).toContain('no-store')
    const descriptor: any = await localDescriptor?.json()
    expect(descriptor).toMatchObject({ availability: 'local-development', sourceRevision: 'local-unreleased', persistence: 'none' })
    expect(descriptor.tools.map((tool: any) => tool.name)).toEqual(TOOL_NAMES)
    const releaseDescriptor = await handleSmeBusinessPackRequest(new Request('https://local.test/agentic-commerce-os/services/sme-business-pack/service.json'), releaseSha)
    expect(await releaseDescriptor?.json()).toMatchObject({ availability: 'edge-enabled', sourceRevision: releaseSha })
    expect((await handleSmeBusinessPackRequest(request({ tool: 'pack.list', arguments: {} }), 'not-a-release'))?.status).toBe(503)
    expect(await handleSmeBusinessPackRequest(new Request('https://local.test/agentic-commerce-os/services/sme-business-pack/unknown'), 'local-unreleased')).toBeNull()
  })

  it('routes the release descriptor through the production Worker entrypoint', async () => {
    const sourceRevision = 'c'.repeat(40)
    const env = { RELEASE_CANDIDATE_SHA: sourceRevision,
      ASSETS: { fetch: async (request: Request) => Response.json({ asset: new URL(request.url).pathname }) },
    } as unknown as LocalFirstEnv
    const response = await localFirstWorker.fetch(new Request(
      'https://airvio.co/agentic-commerce-os/services/sme-business-pack/service.json'),
    env)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-commerce-source')).toBe(sourceRevision)
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(await response.json()).toMatchObject({ availability: 'edge-enabled', sourceRevision })
    const claim_sets = [150000, 180000].map(price => ({ pack_id: 'sg.fnb.takeover', pack_version: '1.0.0',
      currency: 'SGD', claims: { ...baseCashClaims, price } }))
    const expectedComparison = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets })
    const comparison = await localFirstWorker.fetch(new Request(
      'https://airvio.co/agentic-commerce-os/services/sme-business-pack/api', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'takeover.compare_claim_sets', arguments: { claim_sets } }) }), env)
    expect(comparison.status).toBe(200)
    expect(comparison.headers.get('x-commerce-source')).toBe(sourceRevision)
    expect(await comparison.json()).toEqual(expectedComparison)
    const asset = await localFirstWorker.fetch(new Request('https://airvio.co/agentic-commerce-os/sme-business-pack.js'), env)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('x-commerce-source')).toBe(sourceRevision)
    expect(await asset.json()).toEqual({ asset: '/sme-business-pack.js' })
    const legacyAsset = await localFirstWorker.fetch(new Request(
      'https://airvio.co/agentic-commerce-os/services/sme-business-pack/sme-business-pack.js'), env)
    expect(legacyAsset.status).toBe(404)
    const legacyPage = await localFirstWorker.fetch(new Request(
      'https://airvio.co/agentic-commerce-os/services/sme-business-pack/'), env)
    expect(legacyPage.status).toBe(308)
    expect(legacyPage.headers.get('location')).toBe('https://airvio.co/agentic-commerce-os/#sme')
  })

  it('serves seven canonical Singapore capabilities plus direct legacy compatibility over stateless MCP', async () => {
    expect(SME_PACK_TOOLS.map((tool: { name: string }) => tool.name)).toEqual([
      'pack.list', 'pack.protocol', 'takeover.check', 'takeover.budget', 'takeover.plan', 'takeover.compare_claim_sets', 'takeover.transfer_checklist',
    ])
    expect(JSON.stringify(SME_PACK_TOOLS)).not.toContain('my.fnb.takeover')
    const endpoint = 'https://local.test/agentic-commerce-os/services/sme-business-pack/mcp'
    const rpc = (message: object) => new Request(endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' },
      body: JSON.stringify(message),
    })
    const revision = 'b'.repeat(40)
    const initialized = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sme-pack-contract', version: '1' },
    } }), revision)
    expect(initialized?.status).toBe(200)
    expect(initialized?.headers.get('mcp-session-id')).toBeNull()
    expect(JSON.stringify(await initialized?.json())).toContain('2025-03-26')
    const notification = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), revision)
    expect(notification?.status).toBe(202)
    const listed = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), revision)
    expect(listed?.status).toBe(200)
    expect(listed?.headers.get('mcp-session-id')).toBeNull()
    const toolList = JSON.stringify(await listed?.json())
    expect(toolList).toContain('pack.protocol')
    expect(toolList).toContain('takeover.budget')
    expect(toolList).not.toContain('my.fnb.takeover')
    expect(toolList).not.toContain('pack.required_fields')
    const called = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pack.list', arguments: {} } }), revision)
    expect(called?.status).toBe(200)
    expect(called?.headers.get('mcp-session-id')).toBeNull()
    expect(JSON.stringify(await called?.json())).toContain('sg.fnb.takeover')
    const expected = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims: baseCashClaims })
    const budgetCall = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'takeover.budget', arguments: { pack_id: 'sg.fnb.takeover', claims: baseCashClaims } } }), revision)
    expect(budgetCall?.status).toBe(200)
    const mcpBudget: any = await budgetCall?.json()
    expect(mcpBudget.result.structuredContent).toEqual(expected)
    const claim_sets = [0, 1].map(() => ({ pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD', claims: baseCashClaims }))
    const expectedComparison = await invokeSmePackTool('takeover.compare_claim_sets', { claim_sets })
    const comparisonCall = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'takeover.compare_claim_sets', arguments: { claim_sets } } }), revision)
    expect(comparisonCall?.status).toBe(200)
    expect(await comparisonCall?.json()).toMatchObject({ result: { structuredContent: expectedComparison } })
    const oldClient = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'takeover.check_listing', arguments: { pack_id: 'sg.fnb.takeover', facts: baseFacts } } }), revision)
    expect(oldClient?.status).toBe(200)
    expect(JSON.stringify(await oldClient?.json())).toContain('sme-business-pack/check-report/v1')
  })
})
