import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
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
  it('lists only the provisional Singapore pack and exposes the closed protocol', async () => {
    expect((PACK_INDEX as Array<{ id: string }>).map(pack => pack.id)).toEqual(['sg.fnb.takeover'])
    expect(await invokeSmePackTool('pack.list')).toMatchObject({ inference_tokens: 0, packs: [
      { id: 'sg.fnb.takeover', review_status: 'provisional', as_of: '2026-10-22' },
    ] })
    expect(TOOL_NAMES).toEqual(['pack.list', 'pack.protocol', 'takeover.check', 'takeover.budget', 'takeover.plan', 'takeover.transfer_checklist'])
    expect(TOOL_SCHEMAS).toHaveLength(6)
    expect(JSON.stringify(TOOL_SCHEMAS)).not.toContain('my.fnb.takeover')
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: 'sg.fnb.takeover' })
    expect(protocol).toMatchObject({ schema: 'sme-business-pack/protocol/v1', parameters: [], tolerances: [], inference_tokens: 0 })
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
    const durations: number[] = []
    for (const row of fixture.cash_cases) {
      const claims = { ...baseCashClaims, ...row.claims }, expected = oracleBudget(claims)
      const started = performance.now()
      const report = await invokeSmePackTool('takeover.budget', { pack_id: 'sg.fnb.takeover', claims })
      durations.push(performance.now() - started)
      expect(report.schema, row.id).toBe('sme-business-pack/budget-report/v1')
      expect(report.budget.cash_to_close).toMatchObject({ ...expected.total, incomplete: false })
      expect(report.budget.gap_above_asking_price).toEqual(expected.gap)
      expect(report.budget.lease_exposure).toMatchObject(expected.lease)
      expect(report.budget.monthly_fixed_cost).toEqual({
        low: oracleRange(claims.rent_monthly).low + claims.payroll_monthly + claims.utilities_monthly,
        high: oracleRange(claims.rent_monthly).high + claims.payroll_monthly + claims.utilities_monthly,
      })
      expect(report.budget.break_even_monthly_sales).toEqual(expected.breakEven)
      expect(report.budget.lines.map((line: any) => ({ low: line.low, high: line.high }))).toEqual(expected.lines)
      expect(report.budget.unchecked_share).toBe(1)
      expect(report.persisted).toBe(false)
    }
    expect([...durations].sort((a, b) => a - b)[28]).toBeLessThan(2000)
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

  it('serves six canonical Singapore capabilities plus direct legacy compatibility over stateless MCP', async () => {
    expect(SME_PACK_TOOLS.map((tool: { name: string }) => tool.name)).toEqual([
      'pack.list', 'pack.protocol', 'takeover.check', 'takeover.budget', 'takeover.plan', 'takeover.transfer_checklist',
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
    const oldClient = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'takeover.check_listing', arguments: { pack_id: 'sg.fnb.takeover', facts: baseFacts } } }), revision)
    expect(oldClient?.status).toBe(200)
    expect(JSON.stringify(await oldClient?.json())).toContain('sme-business-pack/check-report/v1')
  })
})
