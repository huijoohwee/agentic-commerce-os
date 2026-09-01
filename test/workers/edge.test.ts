import { createExecutionContext, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import edgeWorker from '../../src/edge/index.ts'
import { HUMAN_PRESENCE_AUDIENCE, HUMAN_PRESENCE_RECEIPT_SCHEMA } from '../../src/edge/human-presence.ts'
import { canonicalJson } from '../../src/shared/digest.ts'
import {
  EDGE_HUMAN_PRESENCE_ISSUER,
  EDGE_HUMAN_PRESENCE_PRIVATE_KEY_PKCS8_BASE64,
  EDGE_MCP_TOKEN,
  EDGE_OPERATOR_TOKEN,
  EDGE_TEST_BINDINGS,
  EDGE_TEST_SERVICE_BINDINGS,
  EDGE_TEST_VERSION,
} from './fake-services'

describe('commerce edge Worker', () => {
  it('serves a mobile-first browser console without exposing operational authority', async () => {
    const dashboard = await SELF.fetch('https://edge.test/')
    expect(dashboard.status).toBe(200)
    expect(dashboard.headers.get('content-type')).toContain('text/html')
    expect(dashboard.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await dashboard.text()
    expect(html).toContain('Agentic Commerce OS')
    expect(html).toContain('Agents discover. Humans decide.')
    expect(html).toContain('GET /livez')
    expect(html).toContain('GET /readyz')
    expect(html).not.toContain(EDGE_MCP_TOKEN)
    expect(html).not.toContain(EDGE_OPERATOR_TOKEN)
  })

  it('serves the exact production route as an explicitly closed delivery boundary', async () => {
    const mismatch = await SELF.fetch('https://edge.test/agentic-commerce-os')
    expect(mismatch.status).toBe(200)
    expect(mismatch.headers.get('x-commerce-live-readiness')).toBe('not-ready')
    expect(mismatch.headers.get('x-commerce-live-readiness-reason')).toBe('delivery_route_request_mismatch')

    const localMetadata = await SELF.fetch('https://airvio.co/agentic-commerce-os')
    expect(localMetadata.headers.get('x-commerce-live-readiness')).toBe('not-ready')
    expect(localMetadata.headers.get('x-commerce-live-readiness-reason')).toBe('edge_release_metadata_mismatch')

    const response = await edgeWorker.fetch(
      new Request('https://airvio.co/agentic-commerce-os'),
      Object.freeze({
        ...EDGE_TEST_BINDINGS,
        COMMERCE_CORE: Object.freeze({ fetch: EDGE_TEST_SERVICE_BINDINGS.COMMERCE_CORE }),
      }) as unknown as EdgeEnv,
      createExecutionContext(),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-commerce-live-readiness-contract')).toBe('commerce.edge-route-live-readiness/v1')
    expect(response.headers.get('x-commerce-live-readiness-reason')).toBe('none')
    expect(response.headers.get('x-commerce-live-readiness')).toBe('ready')
    expect(response.headers.get('x-commerce-release-candidate')).toBe(EDGE_TEST_BINDINGS.RELEASE_CANDIDATE_SHA)
    expect(response.headers.get('x-commerce-edge-version-id')).toBe(EDGE_TEST_VERSION.id)
    expect(response.headers.get('x-commerce-core-version-id')).toBe('commerce-core-worker-test-version')
    const html = await response.text()
    expect(html).toContain('Delivery boundary closed.')
    expect(html).not.toContain('id="catalog-search"')
    expect(html).not.toContain('type="module"')
  })

  it('keeps the unrouted diagnostic readiness route-live unknown', async () => {
    const live = await SELF.fetch('https://edge.test/livez')
    expect(live.status).toBe(200)
    await expect(live.json()).resolves.toMatchObject({ ok: true, contract: 'commerce.edge-live/v1' })

    const ready = await SELF.fetch('https://edge.test/readyz')
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({
      ok: false,
      contract: 'commerce.edge-readiness/v2',
      sourceReadiness: { ok: true },
      liveReleaseReadiness: { ok: false, reason: 'delivery_route_live_unknown' },
    })
  })

  it('enforces origin and separates MCP from operator authority', async () => {
    const anonymous = await SELF.fetch('https://edge.test/v1/registry')
    expect(anonymous.status).toBe(401)

    const forbiddenOrigin = await SELF.fetch('https://edge.test/v1/registry', {
      headers: {
        authorization: `Bearer ${EDGE_MCP_TOKEN}`,
        origin: 'https://example.com',
      },
    })
    expect(forbiddenOrigin.status).toBe(403)
    await expect(forbiddenOrigin.json()).resolves.toMatchObject({ ok: false, code: 'origin_forbidden' })

    const registry = await SELF.fetch('https://edge.test/v1/registry', {
      headers: { authorization: `Bearer ${EDGE_MCP_TOKEN}` },
    })
    expect(registry.status).toBe(200)
    await expect(registry.json()).resolves.toMatchObject({ ok: true, agents: [] })

    const wrongAuthority = await operatorTransition(EDGE_MCP_TOKEN)
    expect(wrongAuthority.status).toBe(401)
    const missingClaim = await operatorTransition(EDGE_OPERATOR_TOKEN)
    expect(missingClaim.status).toBe(409)
    await expect(missingClaim.json()).resolves.toMatchObject({ ok: false, code: 'authoring_claim_required' })
    const transitioned = await operatorTransition(EDGE_OPERATOR_TOKEN, true)
    expect(transitioned.status).toBe(200)
    await expect(transitioned.json()).resolves.toMatchObject({ ok: true, vendorId: 'vendor-1', state: 'active' })
  })

  it('fails closed when the deploy lane is not an exact configured enum value', async () => {
    const response = await edgeWorker.fetch(
      new Request('https://airvio.co/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://airvio.co' },
        body: JSON.stringify({ purpose: 'storefront-checkout-preparation' }),
      }),
      Object.freeze({
        ...EDGE_TEST_BINDINGS,
        DEPLOY_LANE: 'production',
        COMMERCE_CORE: Object.freeze({ fetch: EDGE_TEST_SERVICE_BINDINGS.COMMERCE_CORE }),
      }) as unknown as EdgeEnv,
      createExecutionContext(),
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ ok: false, code: 'runtime_configuration_invalid' })
  })

  it('requires a separate short-lived CSRF-bound human proof for visual checkout confirmation', async () => {
    const bearerPrepare = await SELF.fetch('https://edge.test/v1/checkouts/bearer-checkout/prepare', {
      method: 'POST',
      headers: { authorization: `Bearer ${EDGE_MCP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ checkoutId: 'bearer-checkout' }),
    })
    expect(bearerPrepare.status).toBe(409)
    await expect(bearerPrepare.json()).resolves.toMatchObject({ ok: false, code: 'visual_handoff_required' })
    const bearerConfirm = await SELF.fetch('https://edge.test/v1/checkouts/bearer-checkout/confirm', {
      method: 'POST',
      headers: { authorization: `Bearer ${EDGE_MCP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmationToken: 'x'.repeat(64) }),
    })
    expect(bearerConfirm.status).toBe(409)
    await expect(bearerConfirm.json()).resolves.toMatchObject({ ok: false, code: 'human_confirmation_required' })

    const session = await SELF.fetch('https://edge.test/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://airvio.co' },
      body: JSON.stringify({ purpose: 'storefront-checkout-preparation' }),
    })
    expect(session.status).toBe(201)
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()
    const confirmation = await SELF.fetch('https://edge.test/v1/checkouts/checkout-1/confirm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://airvio.co',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({}),
    })
    expect(confirmation.status).toBe(401)

    const checkoutId = `checkout-${crypto.randomUUID()}`
    const preparation = await SELF.fetch(`https://edge.test/v1/checkouts/${checkoutId}/prepare`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://airvio.co',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        checkoutId,
        intentId: 'intent-edge-human',
        agentId: 'agent-edge-human',
        offerId: 'offer-edge-human',
        offerReceiptDigest: 'a'.repeat(64),
        amountMinor: 1_250,
        budgetMinor: 1_250,
        currency: 'USD',
      }),
    })
    expect(preparation.status).toBe(200)
    const prepared = await preparation.json<{
      humanConfirmation: {
        csrfToken: string
        expiresAt: string
        challenge: string
        sessionNonceDigest: string
        blockerDigest: string
      }
    }>()
    expect(prepared).not.toHaveProperty('confirmationToken')
    expect(prepared.humanConfirmation.csrfToken).toEqual(expect.any(String))
    expect(preparation.headers.get('set-cookie')).toContain('Path=/; Secure; HttpOnly; SameSite=Strict')
    const humanCookie = preparation.headers.get('set-cookie')?.split(';', 1)[0]
    expect(humanCookie).toBeTruthy()
    const confirmationBody = {
      checkoutId,
      offerId: 'offer-edge-human',
      amountMinor: 1_250,
      currency: 'USD',
      blockerDigest: prepared.humanConfirmation.blockerDigest,
      presenceReceipt: await signedHumanPresenceReceipt({
        relyingPartyOrigin: 'https://airvio.co',
        challenge: prepared.humanConfirmation.challenge,
        sessionNonceDigest: prepared.humanConfirmation.sessionNonceDigest,
        blockerDigest: prepared.humanConfirmation.blockerDigest,
        checkoutId,
        offerId: 'offer-edge-human',
        amountMinor: 1_250,
        currency: 'USD',
      }),
    }
    const combinedCookies = [cookie, humanCookie].filter(Boolean).join('; ')
    const csrfRefused = await SELF.fetch(`https://edge.test/v1/human/checkouts/${checkoutId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://airvio.co', cookie: combinedCookies },
      body: JSON.stringify(confirmationBody),
    })
    expect(csrfRefused.status).toBe(401)
    const presenceRefused = await SELF.fetch(`https://edge.test/v1/human/checkouts/${checkoutId}/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://airvio.co',
        cookie: combinedCookies,
        'x-human-confirmation-csrf': prepared.humanConfirmation.csrfToken,
      },
      body: JSON.stringify({
        checkoutId,
        offerId: 'offer-edge-human',
        amountMinor: 1_250,
        currency: 'USD',
        blockerDigest: prepared.humanConfirmation.blockerDigest,
      }),
    })
    expect(presenceRefused.status).toBe(401)
    const settled = await SELF.fetch(`https://edge.test/v1/human/checkouts/${checkoutId}/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://airvio.co',
        cookie: combinedCookies,
        'x-human-confirmation-csrf': prepared.humanConfirmation.csrfToken,
      },
      body: JSON.stringify(confirmationBody),
    })
    expect(settled.status).toBe(200)
    expect(settled.headers.get('set-cookie')).toContain('Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict')
    await expect(settled.json()).resolves.toMatchObject({ ok: true, status: 'settled', checkoutId })

    const sync = await SELF.fetch('https://edge.test/v1/sync/merge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://airvio.co',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ base: { fields: [], eventLog: [] }, left: [], right: [] }),
    })
    expect(sync.status).toBe(404)
    await expect(sync.json()).resolves.toMatchObject({ ok: false, code: 'not_found' })
  })

  it('protects the MCP transport and negotiates the pinned protocol', async () => {
    const initializeBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'worker-test', version: '1.0.0' },
      },
    }
    const unauthorized = await mcpRequest(initializeBody)
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_001, message: 'Unauthorized' },
    })

    const initialized = await mcpRequest(initializeBody, EDGE_MCP_TOKEN)
    expect(initialized.status).toBe(200)
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'agentic-commerce-os' },
      },
    })
  })
})

function operatorTransition(token: string, includeClaim = false): Promise<Response> {
  return SELF.fetch('https://edge.test/v1/operator/vendors/vendor-1/transition', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(includeClaim ? {
        'x-authoring-semantic-scope': 'operator-vendor',
        'x-authoring-claim-id': 'edge-worker-test-claim',
        'x-authoring-lease-epoch': '1',
        'x-authoring-fence-revision': 'test-fence-v1',
      } : {}),
    },
    body: JSON.stringify({ actorId: 'operator-1', state: 'active' }),
  })
}

function mcpRequest(body: unknown, token = ''): Promise<Response> {
  return SELF.fetch('https://edge.test/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function signedHumanPresenceReceipt(input: Readonly<{
  relyingPartyOrigin: string
  challenge: string
  sessionNonceDigest: string
  blockerDigest: string
  checkoutId: string
  offerId: string
  amountMinor: number
  currency: string
}>): Promise<Readonly<Record<string, unknown>>> {
  const nowMs = Date.now()
  const unsigned = Object.freeze({
    schema: HUMAN_PRESENCE_RECEIPT_SCHEMA,
    issuer: EDGE_HUMAN_PRESENCE_ISSUER,
    audience: HUMAN_PRESENCE_AUDIENCE,
    relyingPartyOrigin: input.relyingPartyOrigin,
    shopperPrincipalDigest: 'd'.repeat(64),
    sessionNonceDigest: input.sessionNonceDigest,
    challenge: input.challenge,
    checkoutId: input.checkoutId,
    offerId: input.offerId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    blockerDigest: input.blockerDigest,
    confirmedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
    nonce: crypto.randomUUID(),
  })
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    copiedBuffer(decodeBase64(EDGE_HUMAN_PRESENCE_PRIVATE_KEY_PKCS8_BASE64)),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'Ed25519', privateKey, new TextEncoder().encode(canonicalJson(unsigned)),
  )
  return Object.freeze({ ...unsigned, signature: base64Url(new Uint8Array(signature)) })
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
