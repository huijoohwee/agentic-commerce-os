import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error The browser-safe JavaScript module is shared by the Worker and UI.
import { invokeSmePackTool, PACK_INDEX } from '../../public/local-first/sme-business-pack-core.js'
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

describe('SME takeover pack contracts', () => {
  it('lists both provisional packs without inference and loads details only for the chosen pack', async () => {
    expect((PACK_INDEX as Array<{ id: string }>).map(pack => pack.id)).toEqual(['sg.fnb.takeover', 'my.fnb.takeover'])
    expect(await invokeSmePackTool('pack.list')).toMatchObject({ inference_tokens: 0, packs: [
      { id: 'sg.fnb.takeover', review_status: 'provisional', as_of: '2026-10-22' },
      { id: 'my.fnb.takeover', review_status: 'provisional', as_of: '2026-10-22' },
    ] })
    const required = await invokeSmePackTool('pack.required_fields', { pack_id: 'sg.fnb.takeover' })
    expect(required.fields).toHaveLength(15)
    expect(required.fields.find((field: any) => field.name === 'asking_price_band')).toMatchObject({ type: 'money_band', currency: 'SGD' })
    await expect(invokeSmePackTool('pack.required_fields', { pack_id: '../other' })).rejects.toThrow('sme_pack_not_found')
  })

  it('runs 40 labelled fixtures with 100% omitted-field recall for both packs', async () => {
    expect(fixture.schema).toBe('sme-business-pack-fixtures/v1')
    expect(fixture.cases).toHaveLength(40)
    expect(fixture.cases.filter((row: any) => row.pack_id === 'sg.fnb.takeover')).toHaveLength(20)
    expect(fixture.cases.filter((row: any) => row.pack_id === 'my.fnb.takeover')).toHaveLength(20)
    for (const row of fixture.cases) {
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
    for (const headers of [{ authorization: 'Bearer secret' }, { cookie: 'sid=secret' }, { origin: 'https://other.invalid' }]) {
      expect((await handleSmeBusinessPackRequest(request({ tool: 'pack.list', arguments: {} }, headers), 'local-unreleased'))?.status).toBe(403)
    }
    expect((await handleSmeBusinessPackRequest(new Request('https://local.test/agentic-commerce-os/services/sme-business-pack/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(SME_PACK_LIMITS.requestBytes + 1),
    }), 'local-unreleased'))?.status).toBe(413)
    const releaseSha = 'a'.repeat(40)
    const production = await handleSmeBusinessPackRequest(request({ tool: 'pack.list', arguments: {} }), releaseSha)
    expect(production?.status).toBe(200)
    expect(await production?.json()).toMatchObject({ inference_tokens: 0, packs: [{ id: 'sg.fnb.takeover' }, { id: 'my.fnb.takeover' }] })
    const localDescriptor = await handleSmeBusinessPackRequest(new Request('https://local.test/agentic-commerce-os/services/sme-business-pack/service.json'), 'local-unreleased')
    expect(localDescriptor?.headers.get('cache-control')).toContain('no-store')
    expect(await localDescriptor?.json()).toMatchObject({ availability: 'local-development', sourceRevision: 'local-unreleased', persistence: 'none' })
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

  it('serves the four named capabilities through independent stateless MCP requests', async () => {
    expect(SME_PACK_TOOLS.map((tool: { name: string }) => tool.name)).toEqual([
      'pack.list', 'pack.required_fields', 'takeover.check_listing', 'takeover.transfer_checklist',
    ])
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
    expect(JSON.stringify(await listed?.json())).toContain('pack.required_fields')
    const called = await handleSmeBusinessPackRequest(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pack.list', arguments: {} } }), revision)
    expect(called?.status).toBe(200)
    expect(called?.headers.get('mcp-session-id')).toBeNull()
    expect(JSON.stringify(await called?.json())).toContain('sg.fnb.takeover')
  })
})
