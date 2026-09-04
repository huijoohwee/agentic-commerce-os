import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ACOS_ADMISSION_FINDING_SCHEMA,
  ACOS_ADMISSION_PATH,
  COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  ACOS_ADMISSION_PROVIDER_CONTRACT,
  ACOS_ADMISSION_RECEIPT_SCHEMA,
  agenticOsAdmissionHeaders,
  agenticOsAdmissionRequestDigest,
  agenticOsAdmissionServingIdentityHeaders,
  createAgenticOsAdmissionPermit,
  projectCommerceAgentDefinitionForAcos,
  readAgenticOsAdmissionPermit,
  requestAcosAdmission,
  type AcosAdmissionInputs,
  type AcosAdmissionReceipt,
  type AgenticGraphAdmissionAuthority,
} from '../../src/core/acos-admission.ts'
import {
  AGENT_REGISTRY_CLAIM,
  authoringMutationRequestDigest,
  type ClaimMutationPermit,
} from '../../src/domain/authoring-claim-policy.ts'
import { devProviderFetch } from '../../src/dev/provider.ts'
import {
  DEV_ACOS_DEPLOYMENT_IDENTITY,
  DEV_AGENTIC_OS_ADMISSION_AUTH_SECRET as ADMISSION_AUTH_SECRET,
} from '../../src/dev/acos-admission-provider.ts'
import { authenticateAcosAdmissionRequest } from '../../src/shared/acos-admission-auth.ts'
import { canonicalJson, sha256Hex } from '../../src/shared/digest.ts'

const ACOS_DEPLOYMENT_PIN = Object.freeze({
  sourceRevision: 'a'.repeat(40),
  candidateDigest: 'f'.repeat(64),
})

describe('Commerce Agentic OS admission provider v3 contract', () => {
  it('pins the exact acceptance vector bytes with an owner-copyable SHA-256 manifest', () => {
    const fixtureBytes = readFileSync(new URL('../contracts/acos-admission-v2.fixture.json', import.meta.url))
    const manifest = readFileSync(
      new URL('../contracts/acos-admission-v2.fixture.sha256', import.meta.url), 'utf8',
    ).trim()
    const digest = createHash('sha256').update(fixtureBytes).digest('hex')
    expect(manifest).toBe(`${digest}  acos-admission-v2.fixture.json`)
  })

  it('emits the checked-in acceptance request fixture byte-for-byte from live producer code', async () => {
    const fixture = readAcceptanceFixture()
    expect(projectCommerceAgentDefinitionForAcos(fixture.commerceAgentDefinition))
      .toEqual(fixture.request.body.agent_definition)
    const input = Object.freeze({
      agentDefinition: fixture.request.body.agent_definition,
      toolAllowlistEntry: fixture.request.body.tool_allowlist_entry,
      invocationRegisterEntry: fixture.request.body.invocation_register_entry,
      operatorInstructionRef: fixture.request.body.operator_instruction_ref,
    })
    const authoringIntent = fixture.request.body.authoring_mutation_intent
    const expectedPermit = readAgenticOsAdmissionPermit(new Request(fixture.request.url, {
      headers: fixture.request.headers,
    }))
    expect(expectedPermit).not.toBeNull()
    if (!expectedPermit) throw new Error('checked-in Agentic OS v2 fixture permit is malformed')
    const permit = await permitFor(authoringIntent, Object.freeze({
      epoch: 41,
      claimId: 'claim-agentic-os-v2-fixture',
      fenceRevision: 'fence-agentic-os-v2-fixture',
      leaseExpiresAtMs: 4_102_444_800_000,
      reservedAtMs: 1_788_396_300_000,
    }), 7)
    await expect(createAgenticOsAdmissionPermit(authoringIntent, permit)).resolves.toEqual(expectedPermit)
    await expect(agenticOsAdmissionRequestDigest(authoringIntent)).resolves.toBe(expectedPermit.requestDigest)

    let emitted: unknown = null
    const binding = fetcher(async (request) => {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => {
        headers[name] = value
      })
      emitted = Object.freeze({
        url: request.url,
        method: request.method,
        headers,
        body: await request.text(),
      })
      const responsePermit = readAgenticOsAdmissionPermit(request)
      if (!responsePermit) throw new Error('emitted Agentic OS permit is malformed')
      return Response.json({
        status: 'registered',
        record: { ...fixture.expectedReceiptIdentity, registered_at_ms: 1_788_396_300_000 },
        finding: null,
      }, {
        headers: {
          ...agenticOsAdmissionHeaders(responsePermit),
          ...agenticOsAdmissionServingIdentityHeaders(fixture.expectedReceiptIdentity.deployment_identity),
        },
      })
    })

    const result = await requestAcosAdmission(
      binding, input, authoringIntent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    )
    expect(emitted).toEqual({
      url: fixture.request.url,
      method: fixture.request.method,
      headers: fixture.request.headers,
      body: JSON.stringify(fixture.request.body),
    })
    expect(result).toEqual({
      ok: true,
      receipt: { ...fixture.expectedReceiptIdentity, registered_at_ms: 1_788_396_300_000 },
    })
    await expect(requestAcosAdmission(binding, input, authoringIntent, permit, {
      sourceRevision: 'b'.repeat(40), candidateDigest: 'e'.repeat(64),
    }, ADMISSION_AUTH_SECRET)).resolves.toMatchObject({
      ok: false, code: 'acos_admission_serving_identity_invalid',
    })
  })

  it('sends the exact five-key body and complete stable authoring mutation intent', async () => {
    const inputs = admissionInputs()
    const intent = authoringIntent(inputs)
    const permit = await permitFor(intent, lease(10), 1)
    let wireBody: unknown = null
    const binding = fetcher(async (request) => {
      wireBody = await request.json()
      return Response.json({ status: 'registered', record: await receipt(inputs, intent, permit), finding: null }, {
        headers: await successfulAdmissionHeaders(intent, permit),
      })
    })

    await expect(requestAcosAdmission(
      binding, inputs, intent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    ))
      .resolves.toMatchObject({ ok: true })
    expect(ACOS_ADMISSION_PROVIDER_CONTRACT).toBe('commerce.agentic-os-admission-provider/v3')
    expect(ACOS_ADMISSION_PATH).toBe('/agentic-os/internal/v2/adapter-registrations')
    expect(wireBody).toEqual({
      agent_definition: inputs.agentDefinition,
      authoring_mutation_intent: intent,
      tool_allowlist_entry: inputs.toolAllowlistEntry,
      invocation_register_entry: inputs.invocationRegisterEntry,
      operator_instruction_ref: inputs.operatorInstructionRef,
    })
    expect(Object.keys(wireBody as Record<string, unknown>).sort()).toEqual([
      'agent_definition',
      'authoring_mutation_intent',
      'invocation_register_entry',
      'operator_instruction_ref',
      'tool_allowlist_entry',
    ])
  })

  it('rejects a permit that does not authorize the complete intent before provider I/O', async () => {
    const inputs = admissionInputs('agent-digest')
    const intent = authoringIntent(inputs)
    const wrongIntent = { ...intent, commerceProjection: { ...intent.commerceProjection, category: 'shopping' } }
    const currentLease = lease(20)
    const mismatchedPermit = await permitFor(wrongIntent, currentLease, 1)
    let providerCalls = 0
    const binding = fetcher(async (request) => {
      providerCalls += 1
      return devProviderFetch(request)
    })

    const rejected = await requestAcosAdmission(
      binding, inputs, intent, mismatchedPermit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    )
    expect(rejected).toMatchObject({
      ok: false,
      code: 'acos_admission_permit_invalid',
      providerStatus: 0,
      reservationSafeToComplete: false,
      finding: null,
    })
    expect(providerCalls).toBe(0)

    const nextPermit = await permitFor(intent, currentLease, 2)
    await expect(requestAcosAdmission(
      binding, inputs, intent, nextPermit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    )).resolves.toMatchObject({
      ok: true,
      receipt: { agent_definition_id: 'agent-digest' },
    })
  })

  it('rejects any divergence between the full intent admission inputs and the four wire fields', async () => {
    const intentInputs = admissionInputs('agent-intent')
    const wireInputs = admissionInputs('agent-wire')
    const intent = authoringIntent(intentInputs)
    const permit = await permitFor(intent, lease(30), 1)
    const admissionPermit = await createAgenticOsAdmissionPermit(intent, permit)
    if (!admissionPermit) throw new Error('Agentic OS admission permit translation failed')
    const unsigned = new Request(
      `https://agentic-os-admission.internal${ACOS_ADMISSION_PATH}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...agenticOsAdmissionHeaders(admissionPermit) },
        body: JSON.stringify({
          agent_definition: wireInputs.agentDefinition,
          authoring_mutation_intent: intent,
          tool_allowlist_entry: wireInputs.toolAllowlistEntry,
          invocation_register_entry: wireInputs.invocationRegisterEntry,
          operator_instruction_ref: wireInputs.operatorInstructionRef,
        }),
      },
    )
    const signed = await authenticateAcosAdmissionRequest(
      unsigned,
      await unsigned.clone().text(),
      ACOS_ADMISSION_PROVIDER_CONTRACT,
      ADMISSION_AUTH_SECRET,
    )
    if (!signed) throw new Error('ACOS test request authentication failed')
    const response = await devProviderFetch(signed)

    expect(response.status).toBe(409)
    expect(Object.entries(agenticOsAdmissionHeaders(admissionPermit)).every(
      ([name, value]) => response.headers.get(name) === value,
    )).toBe(true)
    await expect(response.json()).resolves.toMatchObject({
      status: 'rejected',
      record: null,
      finding: { reason_code: 'mutation_request_mismatch' },
    })
  })

  it('rejects obsolete authentication headers before parsing the admission body', async () => {
    const inputs = admissionInputs('agent-obsolete-auth')
    const intent = authoringIntent(inputs)
    const permit = await permitFor(intent, lease(31), 1)
    const admissionPermit = await createAgenticOsAdmissionPermit(intent, permit)
    if (!admissionPermit) throw new Error('Agentic OS admission permit translation failed')
    const request = new Request(`https://agentic-os-admission.internal${ACOS_ADMISSION_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...agenticOsAdmissionHeaders(admissionPermit),
        'x-retired-admission-auth-schema': 'retired-admission-auth/v0',
        'x-retired-admission-auth-signature': '0'.repeat(64),
      },
      body: '{not-json',
    })

    const response = await devProviderFetch(request)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: 'acos_admission_authentication_invalid',
    })
  })

  it('rejects an unowned operator instruction reference before provider I/O', async () => {
    const inputs = Object.freeze({
      ...admissionInputs('agent-operator-ref'),
      operatorInstructionRef: 'operator://unowned/commerce-admission',
    })
    const intent = authoringIntent(inputs)
    const permit = await permitFor(intent, lease(40), 1)
    let providerCalls = 0
    const binding = fetcher(async () => {
      providerCalls += 1
      return new Response(null, { status: 500 })
    })

    await expect(requestAcosAdmission(
      binding, inputs, intent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    )).resolves.toEqual({
      ok: false,
      code: 'acos_admission_operator_instruction_reference_invalid',
      providerStatus: 0,
      finding: null,
      reservationSafeToComplete: false,
    })
    expect(providerCalls).toBe(0)
  })

  it.each([
    Object.freeze({
      name: 'server failure carrying a forged terminal envelope',
      status: 500,
      body: rejectionEnvelope('agent_revision_conflict'),
    }),
    Object.freeze({
      name: 'unknown rejection reason',
      status: 409,
      body: rejectionEnvelope('future_or_transient_reason'),
    }),
    Object.freeze({
      name: 'extra rejection field',
      status: 409,
      body: { ...rejectionEnvelope('agent_revision_conflict'), retryable: false },
    }),
    Object.freeze({
      name: 'malformed finding',
      status: 409,
      body: { ...rejectionEnvelope('agent_revision_conflict'), finding: { reason_code: 'agent_revision_conflict' } },
    }),
  ])('keeps the reservation open for $name', async ({ status, body }) => {
    const inputs = admissionInputs(`agent-rejection-${status}`)
    const intent = authoringIntent(inputs)
    const permit = await permitFor(intent, lease(50 + status), 1)
    const binding = fetcher(async () => Response.json(body, {
      status,
      headers: await admissionHeaders(intent, permit),
    }))

    await expect(requestAcosAdmission(
      binding, inputs, intent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    )).resolves.toEqual({
      ok: false,
      code: 'acos_admission_rejection_invalid',
      providerStatus: status,
      finding: null,
      reservationSafeToComplete: false,
    })
  })

  it('requires exact HTTP 200 for an otherwise valid admission receipt', async () => {
    const inputs = admissionInputs('agent-created-status')
    const intent = authoringIntent(inputs)
    const permit = await permitFor(intent, lease(999), 1)
    const binding = fetcher(async () => Response.json({
      status: 'registered',
      record: await receipt(inputs, intent, permit),
      finding: null,
    }, { status: 201, headers: await successfulAdmissionHeaders(intent, permit) }))

    await expect(requestAcosAdmission(
      binding, inputs, intent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    )).resolves.toEqual({
      ok: false,
      code: 'acos_admission_receipt_invalid',
      providerStatus: 201,
      finding: null,
      reservationSafeToComplete: false,
    })
  })

  it.each(['agent_revision_capacity', 'outcome_capacity']) (
    'accepts the producer-aligned durable %s terminal rejection',
    async (reasonCode) => {
      const inputs = admissionInputs(`agent-${reasonCode}`)
      const intent = authoringIntent(inputs)
      const permit = await permitFor(intent, lease(1_000 + reasonCode.length), 1)
      const binding = fetcher(async () => Response.json(rejectionEnvelope(reasonCode), {
        status: 409,
        headers: await admissionHeaders(intent, permit),
      }))

      await expect(requestAcosAdmission(
        binding, inputs, intent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
      ))
        .resolves.toMatchObject({
          ok: false,
          code: 'acos_admission_rejected',
          providerStatus: 409,
          reservationSafeToComplete: true,
          finding: { type: 'unfederated-tool', reason_code: reasonCode },
        })
    },
  )

  it('cancels an untrusted response body before returning a fence mismatch', async () => {
    const inputs = admissionInputs('agent-fence-stream')
    const intent = authoringIntent(inputs)
    const permit = await permitFor(intent, lease(1_001), 1)
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"registered"}'))
      },
      cancel() {
        cancelled = true
      },
    })
    const binding = fetcher(async () => new Response(body, { status: 200 }))

    await expect(requestAcosAdmission(
      binding, inputs, intent, permit, ACOS_DEPLOYMENT_PIN, ADMISSION_AUTH_SECRET,
    ))
      .resolves.toMatchObject({ ok: false, code: 'acos_admission_fence_unconfirmed' })
    expect(cancelled).toBe(true)
  })
})

function rejectionEnvelope(reasonCode: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: 'rejected',
    record: null,
    finding: Object.freeze({
      schema: ACOS_ADMISSION_FINDING_SCHEMA,
      type: 'unfederated-tool',
      adapter_identity: null,
      reason_code: reasonCode,
      message: 'Registration was durably rejected.',
      details: Object.freeze({}),
    }),
  })
}

function admissionInputs(agentId = 'agent-flight'): AcosAdmissionInputs {
  return Object.freeze({
    agentDefinition: Object.freeze({
      id: agentId,
      revision: `${agentId}-v1`,
      name: `${agentId} discovery`,
      source: Object.freeze({ uri: `workspace:/agents/${agentId}.json`, digest: '1'.repeat(64) }),
      model: Object.freeze({ providerId: 'workspace-provider', modelId: 'workspace-model' }),
      instructions: Object.freeze([
        Object.freeze({ name: 'purpose', content: 'Discover bounded commerce offers.' }),
      ]),
    }),
    toolAllowlistEntry: Object.freeze({
      entry_id: `allowlist-${agentId}`,
      agent_definition_id: agentId,
      adapter_identity: 'commerce-discovery',
      tool_names: Object.freeze(['commerce.flight.discover']),
      review_required: true,
    }),
    invocationRegisterEntry: Object.freeze({
      route: '/tool.route',
      tag: '#mcp',
      binding: '@mcp-gateway',
      tool_identity: 'agentic-os.adapter.register',
    }),
    operatorInstructionRef: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  })
}

function authoringIntent(inputs: AcosAdmissionInputs) {
  return Object.freeze({
    admissionInputs: inputs,
    invocationProof: Object.freeze({
      sourceRevision: 'a'.repeat(40),
      catalogDigest: 'b'.repeat(64),
      routingSchema: 'agentic-canvas-os-docs-routing/v1',
      routingDigest: 'c'.repeat(64),
      counts: Object.freeze({ command: 1, semantic: 1, binding: 1 }),
      requiredTokens: Object.freeze(['/tool.route', '#mcp', '@mcp-gateway']),
    }),
    commerceProjection: Object.freeze({
      category: 'flight',
      discoveryTool: 'commerce.flight.discover',
      declaredAttributes: Object.freeze({ priceMinor: 100, qualityScore: 100, latencyMs: 10 }),
      fallbackAgentId: null,
    }),
    expectedPreviousContentHash: null,
    sandboxDryRun: Object.freeze({
      instanceId: `registration-${String((inputs.agentDefinition as { id: string }).id)}`,
      purpose: 'registration-dry-run',
      outcome: 'completed',
      exceededLimit: null,
      configuredValue: null,
      attemptedCalls: Object.freeze([
        Object.freeze({ toolId: 'commerce.flight.discover', allowlisted: true, outcome: 'executed' }),
      ]),
    }),
  })
}

async function receipt(
  inputs: AcosAdmissionInputs,
  intent: unknown,
  permit: ClaimMutationPermit,
): Promise<AcosAdmissionReceipt> {
  const definition = inputs.agentDefinition as { id: string }
  const allowlist = inputs.toolAllowlistEntry as { entry_id: string; adapter_identity: string }
  return Object.freeze({
    schema: ACOS_ADMISSION_RECEIPT_SCHEMA,
    adapter_identity: allowlist.adapter_identity,
    agent_definition_id: definition.id,
    tool_allowlist_entry_id: allowlist.entry_id,
    invocation_register_tokens: Object.freeze([
      '/tool.route', '#mcp', '@mcp-gateway', 'agentic-os.adapter.register',
    ]),
    resulting_status: 'active',
    operator_instruction_reference: inputs.operatorInstructionRef,
    registered_at_ms: 1_787_702_400_000,
    agentic_graph_authority: await authorityProjection(inputs, intent, permit),
    deployment_identity: DEV_ACOS_DEPLOYMENT_IDENTITY,
  })
}

async function authorityProjection(
  inputs: AcosAdmissionInputs,
  intent: unknown,
  permit: ClaimMutationPermit,
): Promise<AgenticGraphAdmissionAuthority> {
  const admissionPermit = await createAgenticOsAdmissionPermit(intent, permit)
  if (!admissionPermit) throw new Error('Agentic OS admission permit translation failed')
  return Object.freeze({
    schema: 'agentic-graph-commerce-admission-authority-projection/v1',
    admission_inputs_digest: await digest(inputs),
    admission_request_digest: admissionPermit.requestDigest,
    authority_ref: `authority://agentic-graph/commerce-admission/test-${admissionPermit.requestDigest.slice(0, 32)}`,
    evidence_digest: 'e'.repeat(64),
    issuer_repository: 'huijoohwee/agentic-graph',
    issuer_revision: 'd'.repeat(40),
    permit_digest: await digest(admissionPermit),
    expires_at_ms: 4_102_444_800_000,
  })
}

async function admissionHeaders(
  intent: unknown,
  permit: ClaimMutationPermit,
): Promise<Readonly<Record<string, string>>> {
  const admissionPermit = await createAgenticOsAdmissionPermit(intent, permit)
  if (!admissionPermit) throw new Error('Agentic OS admission permit translation failed')
  return agenticOsAdmissionHeaders(admissionPermit)
}

async function successfulAdmissionHeaders(
  intent: unknown,
  permit: ClaimMutationPermit,
): Promise<Readonly<Record<string, string>>> {
  return {
    ...await admissionHeaders(intent, permit),
    ...agenticOsAdmissionServingIdentityHeaders(DEV_ACOS_DEPLOYMENT_IDENTITY),
  }
}

async function digest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value))
}

type TestLease = Readonly<{
  epoch: number
  claimId: string
  fenceRevision: string
  leaseExpiresAtMs: number
  reservedAtMs: number
}>

function lease(epoch: number): TestLease {
  const reservedAtMs = Date.now()
  return Object.freeze({
    epoch,
    claimId: `claim-acos-v2-${epoch}`,
    fenceRevision: `fence-acos-v2-${epoch}`,
    leaseExpiresAtMs: reservedAtMs + 60_000,
    reservedAtMs,
  })
}

async function permitFor(
  intent: unknown,
  currentLease: TestLease,
  mutationSequence: number,
): Promise<ClaimMutationPermit> {
  const requestDigest = await authoringMutationRequestDigest(AGENT_REGISTRY_CLAIM, intent)
  return Object.freeze({
    schema: 'agentic-graph-authoring-mutation-permit/v2',
    mutationId: `mutation:${currentLease.epoch}:${mutationSequence}:${requestDigest.slice(0, 32)}`,
    operationId: `operation:${requestDigest}`,
    requestDigest,
    mutationSequence,
    semanticScope: AGENT_REGISTRY_CLAIM.semanticScope,
    claimId: currentLease.claimId,
    leaseEpoch: currentLease.epoch,
    leaseExpiresAtMs: currentLease.leaseExpiresAtMs,
    fenceRevision: currentLease.fenceRevision,
    requiredWriteTarget: AGENT_REGISTRY_CLAIM.writeTarget,
    reservedAtMs: currentLease.reservedAtMs,
  })
}

function fetcher(handler: (request: Request) => Promise<Response>): Fetcher {
  return Object.freeze({ fetch: handler }) as unknown as Fetcher
}

type AcceptanceFixture = Readonly<{
  $schema: 'commerce.agentic-os-admission-v2-request-fixture/v1'
  commerceAgentDefinition: Readonly<Record<string, unknown>>
  request: Readonly<{
    url: string
    method: 'POST'
    headers: Readonly<Record<string, string>>
    body: Readonly<{
      agent_definition: unknown
      authoring_mutation_intent: unknown
      tool_allowlist_entry: unknown
      invocation_register_entry: unknown
      operator_instruction_ref: string
    }>
  }>
  expectedReceiptIdentity: Omit<AcosAdmissionReceipt, 'registered_at_ms'>
}>

function readAcceptanceFixture(): AcceptanceFixture {
  return JSON.parse(readFileSync(
    new URL('../contracts/acos-admission-v2.fixture.json', import.meta.url),
    'utf8',
  )) as AcceptanceFixture
}
