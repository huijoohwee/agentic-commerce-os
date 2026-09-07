import { createHash } from 'node:crypto'
import { COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF } from '../../src/core/acos-admission.ts'
import { CORE_REQUEST_TIMEOUT_MS, REGISTRATION_CORE_REQUEST_TIMEOUT_MS } from '../../src/shared/registration-budget.ts'

export const DEV_REGISTRATION_CLIENT_TIMEOUT_MS = CORE_REQUEST_TIMEOUT_MS + REGISTRATION_CORE_REQUEST_TIMEOUT_MS + 5_000
export const DEV_PAID_LOOP_TIMEOUT_MS = 2 * DEV_REGISTRATION_CLIENT_TIMEOUT_MS + 90_000

export function devRuntimeEnvironment() {
  const required = (name: string) => {
    const value = process.env[name]
    if (!value) throw new Error(`Run the browser check owner first: missing ${name}`)
    return value
  }
  const baseUrl = required('AGENTIC_COMMERCE_DEV_E2E_BASE_URL')
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl)) throw new Error('dev_e2e_loopback_origin_required')
  return Object.freeze({
    baseUrl,
    agentToken: required('AGENTIC_COMMERCE_DEV_E2E_AGENT_TOKEN'),
    operatorToken: required('AGENTIC_COMMERCE_DEV_E2E_OPERATOR_TOKEN'),
    runId: required('AGENTIC_COMMERCE_DEV_E2E_RUN_ID'),
  })
}

export function registryClaim(runId: string) {
  return {
    claimId: `dev-e2e-${runId}`, actorId: 'dev-e2e-operator', deviceId: 'dev-e2e-device',
    sessionId: runId, worktree: process.cwd(), branch: 'dev-e2e-fixture',
    semanticScope: 'operator-registry', declaredWriteSet: ['registry'],
    leaseEpoch: 1, leaseExpiresAtMs: Date.now() + DEV_PAID_LOOP_TIMEOUT_MS, fenceRevision: `dev-e2e-${runId}`,
  }
}

export function registryClaimHeaders(claim: ReturnType<typeof registryClaim>) {
  return {
    'x-authoring-semantic-scope': claim.semanticScope,
    'x-authoring-claim-id': claim.claimId,
    'x-authoring-lease-epoch': String(claim.leaseEpoch),
    'x-authoring-fence-revision': claim.fenceRevision,
  }
}

export function registrationInput(category: 'flight' | 'shopping') {
  const agentId = `dev-e2e-${category}`
  const tool = `commerce.${category}.discover`
  const source = `export async function executeTool(toolId, input) { if (toolId !== ${JSON.stringify(tool)}) throw new Error('tool_not_declared'); return { toolId, input }; }`
  const digest = createHash('sha256').update(source).digest('hex')
  return {
    agentDefinition: {
      id: agentId, revision: `${agentId}-v1`, name: `${category} discovery`,
      source: { uri: `workspace:/agents/${agentId}.json`, digest },
      model: { providerId: 'workspace-provider', modelId: 'workspace-model' },
      instructions: [{ name: 'purpose', content: `Discover bounded ${category} offers.` }],
      tools: [{ name: tool, loading: 'direct' }],
      executableTarget: { contract: 'agentic-graph-sandbox-executable/v1', kind: 'javascript-module', source, sourceDigest: digest },
    },
    toolAllowlistEntry: {
      entry_id: `allowlist-${agentId}`, agent_definition_id: agentId,
      adapter_identity: 'commerce-discovery', tool_names: [tool], review_required: true,
    },
    invocationRegisterEntry: {
      route: '/tool.route', tag: '#mcp', binding: '@mcp-gateway', tool_identity: 'agentic-os.adapter.register',
    },
    operatorInstructionRef: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
    commerceProjection: {
      category, discoveryTool: tool,
      declaredAttributes: { priceMinor: 100, qualityScore: 100, latencyMs: 10 },
      fallbackAgentId: null,
    },
    expectedPreviousContentHash: null,
  }
}
