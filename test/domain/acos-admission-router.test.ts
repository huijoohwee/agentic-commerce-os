import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  ACOS_ADMISSION_RECEIPT_SCHEMA,
  isAcosAdmissionReceiptBoundToInputs,
  type AcosAdmissionInputs,
} from '../../src/core/acos-admission.ts'
import {
  routeIntentExclusively,
  type RegisteredAgent,
} from '../../src/domain/exclusive-category-router.ts'

function admissionInputs(agentId = 'agent-flight'): AcosAdmissionInputs {
  return {
    agentDefinition: {
      id: agentId,
      revision: 'flight-v1',
      name: 'Flight discovery',
      source: { uri: `workspace:/agents/${agentId}.json`, digest: '1'.repeat(64) },
      model: { providerId: 'workspace-provider', modelId: 'workspace-model' },
      instructions: [{ name: 'purpose', content: 'Discover bounded flight offers.' }],
    },
    toolAllowlistEntry: {
      entry_id: `allowlist-${agentId}`,
      agent_definition_id: agentId,
      adapter_identity: 'commerce-discovery',
      tool_names: ['commerce.flight.discover'],
      review_required: true,
    },
    invocationRegisterEntry: {
      route: '/tool.route',
      tag: '#mcp',
      binding: '@mcp-gateway',
      tool_identity: 'agentic-os.adapter.register',
    },
    operatorInstructionRef: COMMERCE_ADMISSION_OPERATOR_INSTRUCTION_REF,
  }
}

function receipt(inputs: AcosAdmissionInputs) {
  const definition = inputs.agentDefinition as { id: string }
  const allowlist = inputs.toolAllowlistEntry as { entry_id: string; adapter_identity: string }
  return {
    schema: ACOS_ADMISSION_RECEIPT_SCHEMA,
    adapter_identity: allowlist.adapter_identity,
    agent_definition_id: definition.id,
    tool_allowlist_entry_id: allowlist.entry_id,
    invocation_register_tokens: ['/tool.route', '#mcp', '@mcp-gateway', 'agentic-os.adapter.register'],
    resulting_status: 'active',
    operator_instruction_reference: inputs.operatorInstructionRef,
    registered_at_ms: 1_787_702_400_000,
    agentic_graph_authority: authorityProjection(),
  }
}

function authorityProjection() {
  return {
    schema: 'agentic-graph-commerce-admission-authority-projection/v1',
    admission_inputs_digest: '1'.repeat(64),
    admission_request_digest: '2'.repeat(64),
    authority_ref: 'authority://agentic-graph/commerce-admission/domain-test',
    evidence_digest: '3'.repeat(64),
    issuer_repository: 'huijoohwee/agentic-graph',
    issuer_revision: '4'.repeat(40),
    permit_digest: '5'.repeat(64),
    expires_at_ms: 4_102_444_800_000,
  }
}

test('ACOS admission accepts only an exact active receipt bound to all four authoritative inputs', () => {
  const inputs = admissionInputs()
  const exact = receipt(inputs)
  assert.equal(isAcosAdmissionReceiptBoundToInputs(exact, inputs), true)
  assert.equal(isAcosAdmissionReceiptBoundToInputs({ ...exact, extra: true }, inputs), false)
  assert.equal(isAcosAdmissionReceiptBoundToInputs({
    ...exact,
    invocation_register_tokens: ['/tool.route', '#mcp', '@wrong', 'agentic-os.adapter.register'],
  }, inputs), false)
  assert.equal(isAcosAdmissionReceiptBoundToInputs({ ...exact, resulting_status: 'proposed' }, inputs), false)
})

test('exclusive router dispatches exactly one verified active ACOS admission', () => {
  const registry: RegisteredAgent[] = [
    agent('agent-shopping', 'shopping'),
    agent('agent-flight', 'flight'),
  ]
  const result = routeIntentExclusively({
    intentId: 'intent-1',
    category: ' FLIGHT ',
    constraints: { currency: 'SGD', nested: { passengers: 1 } },
  }, registry)
  assert.equal(result.status, 'dispatch')
  if (result.status !== 'dispatch') return
  assert.equal(result.agentId, 'agent-flight')
  assert.equal(result.category, 'flight')
})

test('exclusive router never dispatches unverified, inactive, ambiguous, or corrupt state', () => {
  const intent = { intentId: 'intent-2', category: 'flight', constraints: {} }
  assert.equal(routeIntentExclusively(intent, [
    { ...agent('agent-flight', 'flight'), admissionVerified: false },
  ]).status, 'no-dispatch')
  assert.equal(routeIntentExclusively(intent, [
    { ...agent('agent-flight', 'flight'), registrationState: 'inactive' },
  ]).status, 'no-dispatch')

  const ambiguous = routeIntentExclusively(intent, [
    agent('agent-flight', 'flight'),
    agent('agent-backup', 'flight'),
  ])
  assert.equal(ambiguous.status, 'dispatch')
  if (ambiguous.status === 'dispatch') assert.equal(ambiguous.agentId, 'agent-backup')

  const duplicate = routeIntentExclusively(intent, [
    agent('agent-flight', 'flight'),
    agent('agent-flight', 'flight'),
  ])
  assert.equal(duplicate.status, 'no-dispatch')
  if (duplicate.status === 'no-dispatch') assert.equal(duplicate.reason, 'registry-conflict')
})

test('exclusive router rejects unknown intent fields and non-JSON constraints', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(routeIntentExclusively({
    intentId: 'intent-3', category: 'flight', constraints: {}, extra: true,
  }, []).status, 'no-dispatch')
  assert.equal(routeIntentExclusively({
    intentId: 'intent-4', category: 'flight', constraints: cyclic,
  }, []).status, 'no-dispatch')
  assert.equal(routeIntentExclusively({
    intentId: 'intent-merchant-partial', category: 'flight', constraints: {}, merchantId: 'merchant-1',
  }, []).status, 'no-dispatch')
})

test('exclusive router binds a complete merchant listing target into its discovery input', () => {
  const decision = routeIntentExclusively({
    intentId: 'intent-merchant',
    category: 'flight',
    constraints: { origin: 'SIN' },
    merchantId: 'merchant-1',
    listingId: 'listing-1',
  }, [agent('agent-flight', 'flight')])
  assert.equal(decision.status, 'dispatch')
  if (decision.status === 'dispatch') {
    assert.equal(decision.discoveryInput.merchantId, 'merchant-1')
    assert.equal(decision.discoveryInput.listingId, 'listing-1')
  }
})

test('exclusive router rejects payment credentials before discovery egress', () => {
  const decision = routeIntentExclusively({
    intentId: 'intent-credential',
    category: 'flight',
    constraints: { origin: 'SIN', payment: { cardNumber: '4111111111111111' } },
  }, [{
    ...agent('flight-primary', 'flight'),
  }])
  assert.equal(decision.status, 'no-dispatch')
  if (decision.status === 'no-dispatch') assert.equal(decision.reason, 'invalid-intent')
})

function agent(agentId: string, category: string): RegisteredAgent {
  return Object.freeze({
    agentId,
    category,
    declaredAttributes: Object.freeze({ priceMinor: 100, qualityScore: 100, latencyMs: 100 }),
    fallbackAgentId: null,
    admissionVerified: true,
    registrationState: 'active',
  })
}
