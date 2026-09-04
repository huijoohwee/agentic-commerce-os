import { describe, expect, it } from 'vitest'

import {
  ACOS_ADMISSION_RECEIPT_SCHEMA,
  ACOS_ADMISSION_SERVING_IDENTITY_HEADER,
  COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  agenticOsAdmissionHeaders,
  agenticOsAdmissionServingIdentityHeaders,
  readAgenticOsAdmissionPermit,
  requestAcosAdmission,
  type AcosAdmissionInputs,
  type AcosAdmissionReceipt,
} from '../../src/core/acos-admission.ts'
import {
  AGENT_REGISTRY_CLAIM,
  authoringMutationRequestDigest,
  type ClaimMutationPermit,
} from '../../src/domain/authoring-claim-policy.ts'
import { DEV_AGENTIC_OS_ADMISSION_AUTH_SECRET } from '../../src/dev/acos-admission-provider.ts'
import { canonicalJson, sha256Hex } from '../../src/shared/digest.ts'

const WRITER_IDENTITY = Object.freeze({
  schema: 'acos-cloudflare-deployment-identity/v1' as const,
  sourceRevision: 'a'.repeat(40),
  candidateDigest: 'f'.repeat(64),
  versionId: '11111111-1111-4111-8111-111111111111',
  versionTag: `acos-prod-${'f'.repeat(64)}`,
  versionTimestamp: '2026-09-03T00:00:00.000Z',
})
const SERVING_IDENTITY = Object.freeze({
  ...WRITER_IDENTITY,
  sourceRevision: 'b'.repeat(40),
  candidateDigest: 'e'.repeat(64),
  versionId: '22222222-2222-4222-8222-222222222222',
  versionTag: `acos-prod-${'e'.repeat(64)}`,
  versionTimestamp: '2026-09-04T00:00:00.000Z',
})
const SERVING_PIN = Object.freeze({
  sourceRevision: SERVING_IDENTITY.sourceRevision,
  candidateDigest: SERVING_IDENTITY.candidateDigest,
})
const INPUTS = Object.freeze({
  agentDefinition: Object.freeze({ id: 'agent-version-replay' }),
  toolAllowlistEntry: Object.freeze({
    entry_id: 'allowlist-agent-version-replay',
    agent_definition_id: 'agent-version-replay',
    adapter_identity: 'commerce-discovery',
  }),
  invocationRegisterEntry: Object.freeze({
    route: '/tool.route',
    tag: '#mcp',
    binding: '@mcp-gateway',
    tool_identity: 'agentic-os.adapter.register',
  }),
  operatorInstructionRef: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
}) satisfies AcosAdmissionInputs
const INTENT = Object.freeze({
  admissionInputs: INPUTS,
  commerceProjection: Object.freeze({ category: 'flight' }),
  expectedPreviousContentHash: null,
  invocationProof: Object.freeze({ sourceRevision: 'a'.repeat(40) }),
  sandboxDryRun: Object.freeze({ ok: true }),
})

describe('ACOS successful-response serving deployment identity', () => {
  it('accepts an immutable old-writer receipt after a new-current-identity restart', async () => {
    const permit = await mutationPermit()
    const servingHeaders = agenticOsAdmissionServingIdentityHeaders(SERVING_IDENTITY)
    expect(servingHeaders).toEqual({
      [ACOS_ADMISSION_SERVING_IDENTITY_HEADER]: canonicalJson(SERVING_IDENTITY),
    })

    const result = await requestAcosAdmission(
      provider(servingHeaders),
      INPUTS,
      INTENT,
      permit,
      SERVING_PIN,
      DEV_AGENTIC_OS_ADMISSION_AUTH_SECRET,
    )
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.receipt.deployment_identity).toEqual(WRITER_IDENTITY)
  })

  it.each([
    ['missing', Object.freeze({})],
    ['wrong', agenticOsAdmissionServingIdentityHeaders(WRITER_IDENTITY)],
    ['extra-field', Object.freeze({
      [ACOS_ADMISSION_SERVING_IDENTITY_HEADER]: canonicalJson({ ...SERVING_IDENTITY, extra: true }),
    })],
  ])('rejects a %s current-serving identity signal', async (_name, servingHeaders) => {
    const result = await requestAcosAdmission(
      provider(servingHeaders),
      INPUTS,
      INTENT,
      await mutationPermit(),
      SERVING_PIN,
      DEV_AGENTIC_OS_ADMISSION_AUTH_SECRET,
    )
    expect(result).toMatchObject({
      ok: false,
      code: 'acos_admission_serving_identity_invalid',
      reservationSafeToComplete: false,
    })
  })
})

function provider(servingHeaders: Readonly<Record<string, string>>): Fetcher {
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const permit = readAgenticOsAdmissionPermit(request)
      if (!permit) throw new Error('Agentic OS admission permit was malformed')
      return Response.json({
        status: 'registered',
        record: await writerReceipt(permit),
        finding: null,
      }, {
        headers: { ...agenticOsAdmissionHeaders(permit), ...servingHeaders },
      })
    },
  }) as unknown as Fetcher
}

async function mutationPermit(): Promise<ClaimMutationPermit> {
  const requestDigest = await authoringMutationRequestDigest(AGENT_REGISTRY_CLAIM, INTENT)
  return Object.freeze({
    schema: 'agentic-graph-authoring-mutation-permit/v2',
    mutationId: `mutation:1:1:${requestDigest.slice(0, 32)}`,
    operationId: `operation:${requestDigest}`,
    requestDigest,
    mutationSequence: 1,
    semanticScope: AGENT_REGISTRY_CLAIM.semanticScope,
    claimId: 'claim-version-replay',
    leaseEpoch: 1,
    leaseExpiresAtMs: 4_102_444_800_000,
    fenceRevision: 'fence-version-replay',
    requiredWriteTarget: AGENT_REGISTRY_CLAIM.writeTarget,
    reservedAtMs: 1_788_396_300_000,
  })
}

async function writerReceipt(
  permit: NonNullable<ReturnType<typeof readAgenticOsAdmissionPermit>>,
): Promise<AcosAdmissionReceipt> {
  return Object.freeze({
    schema: ACOS_ADMISSION_RECEIPT_SCHEMA,
    adapter_identity: 'commerce-discovery',
    agent_definition_id: 'agent-version-replay',
    tool_allowlist_entry_id: 'allowlist-agent-version-replay',
    invocation_register_tokens: Object.freeze([
      '/tool.route', '#mcp', '@mcp-gateway', 'agentic-os.adapter.register',
    ]),
    resulting_status: 'active',
    operator_instruction_reference: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
    registered_at_ms: 1_788_396_300_000,
    agentic_graph_authority: Object.freeze({
      schema: 'agentic-graph-commerce-admission-authority-projection/v1',
      admission_inputs_digest: await sha256Hex(canonicalJson(INPUTS)),
      admission_request_digest: permit.requestDigest,
      authority_ref: 'authority://agentic-graph/commerce-admission/version-replay',
      evidence_digest: 'd'.repeat(64),
      issuer_repository: 'huijoohwee/agentic-graph',
      issuer_revision: 'c'.repeat(40),
      permit_digest: await sha256Hex(canonicalJson(permit)),
      expires_at_ms: 4_102_444_800_000,
    }),
    deployment_identity: WRITER_IDENTITY,
  })
}
