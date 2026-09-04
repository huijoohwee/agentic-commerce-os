import { describe, expect, it } from 'vitest'

import {
  ACOS_ADMISSION_PROVIDER_CONTRACT,
  ACOS_ADMISSION_RECEIPT_SCHEMA,
  probeAcosAdmission,
} from '../../src/core/acos-admission.ts'
import { readAcosDeploymentIdentity } from '../../src/core/acos-deployment-identity.ts'

const AUTH_SECRET = 'agentic-os-admission-dev-secret-rotate-before-production'
const IDENTITY = Object.freeze({
  schema: 'acos-cloudflare-deployment-identity/v1' as const,
  sourceRevision: 'a'.repeat(40), candidateDigest: 'f'.repeat(64),
  versionId: '11111111-1111-4111-8111-111111111111',
  versionTag: `acos-prod-${'f'.repeat(64)}`,
  versionTimestamp: '2026-09-03T00:00:00.000Z',
})
const AUTHORITY = Object.freeze({
  schema: 'agentic-graph-commerce-admission-authority-projection/v1',
  admission_inputs_digest: '1'.repeat(64), admission_request_digest: '2'.repeat(64),
  authority_ref: 'authority://agentic-graph/commerce-admission/identity-test',
  evidence_digest: '3'.repeat(64), issuer_repository: 'huijoohwee/agentic-graph',
  issuer_revision: '4'.repeat(40), permit_digest: '5'.repeat(64),
  expires_at_ms: 4_102_444_800_000,
})

const binding = Object.freeze({
  async fetch() {
    return Response.json({
      ok: true,
      contract: ACOS_ADMISSION_PROVIDER_CONTRACT,
      receiptSchema: ACOS_ADMISSION_RECEIPT_SCHEMA,
      operations: ['register-fenced'],
      productionReady: true,
      deploymentIdentity: IDENTITY,
      authority: AUTHORITY,
    })
  },
}) as unknown as Fetcher

describe('ACOS deployment identity', () => {
  it('accepts authenticated readiness only for the owner-published exact deployment pin', async () => {
    const matching = await probeAcosAdmission(binding, {
      sourceRevision: IDENTITY.sourceRevision, candidateDigest: IDENTITY.candidateDigest,
    }, AUTH_SECRET) as { ok: boolean; deploymentIdentity?: unknown }
    expect(matching.ok).toBe(true)
    expect(matching.deploymentIdentity).toEqual(IDENTITY)

    const unrelated = await probeAcosAdmission(binding, {
      sourceRevision: 'b'.repeat(40), candidateDigest: 'e'.repeat(64),
    }, AUTH_SECRET) as { ok: boolean; deploymentIdentity?: unknown }
    expect(unrelated.ok).toBe(false)
    expect(unrelated.deploymentIdentity).toBeNull()
  })

  it('rejects extra fields and mismatched version tags', () => {
    expect(readAcosDeploymentIdentity({ ...IDENTITY, extra: true })).toBeNull()
    expect(readAcosDeploymentIdentity({
      ...IDENTITY, versionTag: 'acos-prod-wrong',
    })).toBeNull()
  })
})
