import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  ACOS_ADMISSION_PATH,
  ACOS_ADMISSION_RECEIPT_SCHEMA,
  ACOS_DEPLOYMENT_IDENTITY_SCHEMA,
  COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  requestAcosAdmission,
  type AcosAdmissionInputs,
  type AcosAdmissionReceipt,
} from '../../src/core/acos-admission.ts'
import {
  AgentRegistry,
  agentRegistrationMutationIntent,
  type AgentRegistrationInput,
  type AgentRegistrationIntent,
} from '../../src/core/agent-registry.ts'
import { authoringMutationHeaders } from '../../src/core/authoring-mutation-headers.ts'
import { DEV_ACOS_ADMISSION_AUTH_SECRET } from '../../src/dev/acos-admission-provider.ts'
import {
  AGENT_REGISTRY_CLAIM,
  authoringMutationOperationId,
  authoringMutationRequestDigest,
  type Claim,
  type ClaimMutationPermit,
  type ClaimMutationRequest,
} from '../../src/domain/authoring-claim-policy.ts'

describe('AgentRegistry immutable terminal outcome replay', () => {
  it('returns completed A after B advances the fence and AuthoringClaim reissues A', async () => {
    const claims = env.AUTHORING_CLAIM.get(env.AUTHORING_CLAIM.newUniqueId())
    const registry = env.AGENT_REGISTRY.get(env.AGENT_REGISTRY.newUniqueId())
    const now = Date.now()
    const claim = registryClaim(now)
    const claimRequest = mutationRequest(claim)
    await expect(claims.acquire(claim, now)).resolves.toMatchObject({ ok: true })

    const intentA = registrationIntent('agent-replay-a', 'flight', 'commerce.flight.discover', 100)
    const operationA = await mutationOperation(intentA)
    const reservedA = await claims.beginMutation(claimRequest, operationA.id, operationA.digest, now + 1)
    expect(reservedA).toMatchObject({ ok: true, permit: { mutationSequence: 1 } })
    if (!reservedA.ok) throw new Error('registration A mutation was not reserved')
    const inputA = await admittedRegistration(intentA, reservedA.permit)
    const firstA = await registry.register(inputA, reservedA.permit)
    expect(firstA).toMatchObject({ ok: true, idempotent: false, record: { agentId: 'agent-replay-a' } })
    await expect(claims.completeMutation(reservedA.permit, now + 2)).resolves.toEqual({ ok: true })

    const intentB = registrationIntent('agent-replay-b', 'shopping', 'commerce.shopping.discover', 200)
    const operationB = await mutationOperation(intentB)
    const reservedB = await claims.beginMutation(claimRequest, operationB.id, operationB.digest, now + 3)
    expect(reservedB).toMatchObject({ ok: true, permit: { mutationSequence: 2 } })
    if (!reservedB.ok) throw new Error('registration B mutation was not reserved')
    const inputB = await admittedRegistration(intentB, reservedB.permit)
    const appliedB = await registry.register(inputB, reservedB.permit)
    expect(appliedB).toMatchObject({ ok: true, idempotent: false, record: { agentId: 'agent-replay-b' } })
    await expect(claims.completeMutation(reservedB.permit, now + 4)).resolves.toEqual({ ok: true })

    const replayReservationA = await claims.beginMutation(
      claimRequest,
      operationA.id,
      operationA.digest,
      now + 5,
    )
    expect(replayReservationA).toEqual(reservedA)
    if (!replayReservationA.ok) throw new Error('completed registration A permit was not reissued')
    const replayIntentA = registrationIntent(
      'agent-replay-a',
      'flight',
      'commerce.flight.discover',
      100,
      '2026-09-03T00:01:00.000Z',
    )
    expect(await mutationOperation(replayIntentA)).toEqual(operationA)
    const replayInputA = await admittedRegistration(replayIntentA, replayReservationA.permit)
    const replayA = await registry.register(replayInputA, replayReservationA.permit)
    expect(replayA).toEqual(firstA)
    await expect(claims.completeMutation(replayReservationA.permit, now + 6)).resolves.toEqual({ ok: true })

    const driftedIntentA = registrationIntent(
      'agent-replay-a',
      'flight',
      'commerce.flight.discover',
      101,
      '2026-09-03T00:02:00.000Z',
    )
    const driftedInputA = Object.freeze({
      ...driftedIntentA,
      admissionReceipt: inputA.admissionReceipt,
    }) satisfies AgentRegistrationInput
    await expect(registry.register(driftedInputA, reservedA.permit)).resolves.toMatchObject({
      ok: false,
      code: 'mutation_request_mismatch',
    })

    const snapshot = await runInDurableObject(registry, async (instance) => (
      (instance as AgentRegistry).list()
    ))
    expect(snapshot).toMatchObject({ ok: true, revision: 2 })
    expect(snapshot.agents.map(({ agentId }) => agentId)).toEqual(['agent-replay-a', 'agent-replay-b'])
    const persisted = await runInDurableObject(registry, async (_instance, state) => Object.freeze({
      fence: state.storage.sql.exec<{
        mutation_id: string
        mutation_sequence: number
      }>(
        'SELECT mutation_id, mutation_sequence FROM authoring_mutation_fence WHERE semantic_scope = ?',
        AGENT_REGISTRY_CLAIM.semanticScope,
      ).toArray()[0] ?? null,
      outcomeCount: state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM authoring_mutation_outcome',
      ).one().count,
    }))
    expect(persisted).toEqual({
      fence: { mutation_id: reservedB.permit.mutationId, mutation_sequence: 2 },
      outcomeCount: 2,
    })
  })
})

async function mutationOperation(intent: AgentRegistrationIntent): Promise<Readonly<{ id: string; digest: string }>> {
  const digest = await authoringMutationRequestDigest(
    AGENT_REGISTRY_CLAIM,
    agentRegistrationMutationIntent(intent),
  )
  const id = authoringMutationOperationId(digest)
  if (!id) throw new Error('registration mutation operation ID was not derived')
  return Object.freeze({ id, digest })
}

async function admittedRegistration(
  intent: AgentRegistrationIntent,
  permit: ClaimMutationPermit,
): Promise<AgentRegistrationInput> {
  const authoringIntent = agentRegistrationMutationIntent(intent)
  const result = await requestAcosAdmission(
    admissionProvider(intent.admissionInputs, authoringIntent, permit),
    intent.admissionInputs,
    authoringIntent,
    permit,
    Object.freeze({ sourceRevision: 'a'.repeat(40), candidateDigest: 'f'.repeat(64) }),
    DEV_ACOS_ADMISSION_AUTH_SECRET,
  )
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error(`ACOS v2 admission failed: ${result.code}`)
  return Object.freeze({ ...intent, admissionReceipt: result.receipt })
}

function admissionProvider(
  input: AcosAdmissionInputs,
  authoringIntent: unknown,
  permit: ClaimMutationPermit,
): Fetcher {
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      expect(new URL(request.url).pathname).toBe(ACOS_ADMISSION_PATH)
      await expect(request.json()).resolves.toEqual({
        agent_definition: input.agentDefinition,
        authoring_mutation_intent: authoringIntent,
        tool_allowlist_entry: input.toolAllowlistEntry,
        invocation_register_entry: input.invocationRegisterEntry,
        operator_instruction_ref: input.operatorInstructionRef,
      })
      return Response.json({ status: 'registered', record: receipt(input), finding: null }, {
        headers: authoringMutationHeaders(permit),
      })
    },
  }) as unknown as Fetcher
}

function receipt(input: AcosAdmissionInputs): AcosAdmissionReceipt {
  const definition = input.agentDefinition as { id: string }
  const allowlist = input.toolAllowlistEntry as { entry_id: string; adapter_identity: string }
  return Object.freeze({
    schema: ACOS_ADMISSION_RECEIPT_SCHEMA,
    adapter_identity: allowlist.adapter_identity,
    agent_definition_id: definition.id,
    tool_allowlist_entry_id: allowlist.entry_id,
    invocation_register_tokens: Object.freeze(['/tool.route', '#mcp', '@mcp-gateway', 'acos.adapter.register']),
    resulting_status: 'active',
    operator_instruction_reference: input.operatorInstructionRef,
    registered_at_ms: 1_788_396_300_000,
    deployment_identity: deploymentIdentity(),
  })
}

function deploymentIdentity() {
  const candidateDigest = 'f'.repeat(64)
  return Object.freeze({
    schema: ACOS_DEPLOYMENT_IDENTITY_SCHEMA,
    sourceRevision: 'a'.repeat(40),
    candidateDigest,
    versionId: '11111111-1111-4111-8111-111111111111',
    versionTag: `acos-prod-${candidateDigest}`,
    versionTimestamp: '2026-09-03T00:00:00.000Z',
  })
}

function registrationIntent(
  agentId: string,
  category: string,
  discoveryTool: string,
  priceMinor: number,
  startedAt = '2026-09-03T00:00:00.000Z',
): AgentRegistrationIntent {
  const sourceDigest = (category === 'flight' ? '1' : '2').repeat(64)
  const endedAt = new Date(Date.parse(startedAt) + 1_000).toISOString()
  return Object.freeze({
    admissionInputs: Object.freeze({
      agentDefinition: Object.freeze({
        id: agentId,
        revision: `${agentId}-v1`,
        name: `${category} discovery`,
        source: Object.freeze({ uri: `workspace:/agents/${agentId}.json`, digest: sourceDigest }),
        model: Object.freeze({ providerId: 'workspace-provider', modelId: 'workspace-model' }),
        instructions: Object.freeze([
          Object.freeze({ name: 'purpose', content: `Discover bounded ${category} offers.` }),
        ]),
        tools: Object.freeze([Object.freeze({ name: discoveryTool, loading: 'direct' })]),
      }),
      toolAllowlistEntry: Object.freeze({
        entry_id: `allowlist-${agentId}`,
        agent_definition_id: agentId,
        adapter_identity: 'commerce-discovery',
        tool_names: Object.freeze([discoveryTool]),
        review_required: true,
      }),
      invocationRegisterEntry: Object.freeze({
        route: '/tool.route',
        tag: '#mcp',
        binding: '@mcp-gateway',
        tool_identity: 'acos.adapter.register',
      }),
      operatorInstructionRef: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
    }),
    invocationProof: Object.freeze({
      sourceRevision: 'a'.repeat(40),
      catalogDigest: 'b'.repeat(64),
      routingSchema: 'agentic-canvas-os-docs-routing/v1',
      routingDigest: 'c'.repeat(64),
      counts: Object.freeze({ command: 1, semantic: 1, binding: 1 }),
      requiredTokens: Object.freeze(['/tool.route', '#mcp', '@mcp-gateway']),
    }),
    commerceProjection: Object.freeze({
      category,
      discoveryTool,
      declaredAttributes: Object.freeze({ priceMinor, qualityScore: 100, latencyMs: 10 }),
      fallbackAgentId: null,
    }),
    expectedPreviousContentHash: null,
    sandboxDryRun: Object.freeze({
      instanceId: `registration-${agentId}`,
      purpose: 'registration-dry-run',
      startedAt,
      endedAt,
      outcome: 'completed',
      exceededLimit: null,
      configuredValue: null,
      attemptedCalls: Object.freeze([
        Object.freeze({ toolId: discoveryTool, allowlisted: true, outcome: 'executed' }),
      ]),
    }),
  })
}

function registryClaim(now: number): Claim {
  return Object.freeze({
    claimId: 'agent-registration-replay-claim',
    actorId: 'agent-registration-replay-actor',
    deviceId: 'agent-registration-replay-device',
    sessionId: 'agent-registration-replay-session',
    worktree: '/test/agent-registration-replay',
    branch: 'agent/test/agent-registration-replay',
    semanticScope: AGENT_REGISTRY_CLAIM.semanticScope,
    declaredWriteSet: Object.freeze([AGENT_REGISTRY_CLAIM.writeTarget]),
    leaseEpoch: 1,
    leaseExpiresAtMs: now + 60_000,
    fenceRevision: 'agent-registration-replay-fence-v1',
  })
}

function mutationRequest(claim: Claim): ClaimMutationRequest {
  return Object.freeze({
    semanticScope: claim.semanticScope,
    claimId: claim.claimId,
    leaseEpoch: claim.leaseEpoch,
    fenceRevision: claim.fenceRevision,
    requiredWriteTarget: AGENT_REGISTRY_CLAIM.writeTarget,
  })
}
