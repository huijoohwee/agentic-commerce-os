import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF } from '../../src/core/acos-admission.ts'
import { sha256Hex } from '../../src/shared/digest.ts'

const CONTRACT_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'x-commerce-contract': 'commerce.edge-core/v1',
  'x-commerce-release-candidate': 'b'.repeat(40),
  'x-commerce-release-candidate-digest': 'e'.repeat(64),
})

describe('ACOS to Commerce registration boundary', () => {
  it.each([
    ['test-acos-forged-500-boundary', 1],
    ['test-acos-unknown-409-boundary', 2],
  ] as const)(
    'keeps %s retriable until an exact durable terminal rejection arrives',
    async (failureId, leaseEpoch) => {
      const claimId = `claim-${failureId}`
      const fence = `fence-${failureId}`
      const headers = Object.freeze({
        'x-authoring-semantic-scope': 'operator-registry',
        'x-authoring-claim-id': claimId,
        'x-authoring-lease-epoch': String(leaseEpoch),
        'x-authoring-fence-revision': fence,
      })
      const acquired = await post('/internal/v1/operator/claims/acquire', {
        claimId,
        actorId: 'test-operator',
        deviceId: 'test-device',
        sessionId: 'test-session',
        worktree: '/test/registration-boundary',
        branch: 'agent/test/registration-boundary',
        semanticScope: 'operator-registry',
        declaredWriteSet: ['registry'],
        leaseEpoch,
        leaseExpiresAtMs: Date.now() + 60_000,
        fenceRevision: fence,
      }, headers)
      expect(acquired.status).toBe(200)

      const first = await register(failureId, '9'.repeat(64), headers)
      expect(first.status).toBe(502)
      await expect(first.json()).resolves.toMatchObject({
        ok: false,
        code: 'acos_admission_rejection_invalid',
        reservationSafeToComplete: false,
      })
      const blocked = await register(`${failureId}-different-operation`, '8'.repeat(64), headers)
      expect(blocked.status).toBe(409)
      await expect(blocked.json()).resolves.toMatchObject({
        ok: false,
        code: 'mutation_reconciliation_required',
      })
      const terminal = await register(failureId, '9'.repeat(64), headers)
      expect(terminal.status).toBe(409)
      await expect(terminal.json()).resolves.toMatchObject({
        ok: false,
        code: 'acos_admission_rejected',
        reservationSafeToComplete: true,
      })
      const mutationStatus = await post('/internal/v1/operator/claims/status', {
        semanticScope: 'operator-registry',
      }, headers)
      const mutationStatusPayload = await mutationStatus.json<Record<string, unknown>>()
      expect(mutationStatus.status, JSON.stringify(mutationStatusPayload)).toBe(200)
      expect(mutationStatusPayload).toMatchObject({ ok: true, status: 'none' })
      const claimAdmission = await post('/internal/v1/operator/claims/admit', {
        semanticScope: 'operator-registry', claimId, leaseEpoch,
        fenceRevision: fence, requiredWriteTarget: 'registry',
      }, headers)
      const claimAdmissionPayload = await claimAdmission.json<Record<string, unknown>>()
      expect(claimAdmission.status, JSON.stringify(claimAdmissionPayload)).toBe(200)
      const released = await post('/internal/v1/operator/claims/release', {
        semanticScope: 'operator-registry', claimId, leaseEpoch, fenceRevision: fence,
      }, headers)
      const releasePayload = await released.json<Record<string, unknown>>()
      expect(released.status, JSON.stringify(releasePayload)).toBe(200)
    },
  )
})

async function register(
  agentId: string,
  contentHash: string,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  const discoveryTool = 'commerce.test.discover'
  const executableSource = `export async function executeTool(toolId, input) { return { toolId, input }; }`
  return post('/internal/v1/agents', {
    agentDefinition: {
      id: agentId,
      revision: `${agentId}-v1`,
      name: 'test discovery',
      source: { uri: `workspace:/agents/${agentId}.json`, digest: contentHash },
      model: { providerId: 'workspace-provider', modelId: 'workspace-model' },
      instructions: [{ name: 'purpose', content: 'Discover bounded test offers.' }],
      tools: [{ name: discoveryTool, loading: 'direct' }],
      executableTarget: {
        contract: 'agentic-graph-sandbox-executable/v1',
        kind: 'javascript-module',
        source: executableSource,
        sourceDigest: await sha256Hex(executableSource),
      },
    },
    toolAllowlistEntry: {
      entry_id: `allowlist-${agentId}`,
      agent_definition_id: agentId,
      adapter_identity: 'commerce-discovery',
      tool_names: [discoveryTool],
      review_required: true,
    },
    invocationRegisterEntry: {
      route: '/tool.route', tag: '#mcp', binding: '@mcp-gateway', tool_identity: 'acos.adapter.register',
    },
    operatorInstructionRef: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
    commerceProjection: {
      category: 'test',
      discoveryTool,
      declaredAttributes: { priceMinor: 100, qualityScore: 100, latencyMs: 10 },
      fallbackAgentId: null,
    },
    expectedPreviousContentHash: null,
  }, headers)
}

function post(
  pathname: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return SELF.fetch(`https://core.test${pathname}`, {
    method: 'POST',
    headers: { ...CONTRACT_HEADERS, ...headers },
    body: JSON.stringify(body),
  })
}
