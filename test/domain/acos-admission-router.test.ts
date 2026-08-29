import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
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
      tool_identity: 'acos.adapter.register',
    },
    operatorInstructionRef: 'operator-instruction/commerce/flight-v1',
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
    invocation_register_tokens: ['/tool.route', '#mcp', '@mcp-gateway', 'acos.adapter.register'],
    resulting_status: 'active',
    operator_instruction_reference: inputs.operatorInstructionRef,
    registered_at_ms: 1_787_702_400_000,
  }
}

test('ACOS admission accepts only an exact active receipt bound to all four authoritative inputs', () => {
  const inputs = admissionInputs()
  const exact = receipt(inputs)
  assert.equal(isAcosAdmissionReceiptBoundToInputs(exact, inputs), true)
  assert.equal(isAcosAdmissionReceiptBoundToInputs({ ...exact, extra: true }, inputs), false)
  assert.equal(isAcosAdmissionReceiptBoundToInputs({
    ...exact,
    invocation_register_tokens: ['/tool.route', '#mcp', '@wrong', 'acos.adapter.register'],
  }, inputs), false)
  assert.equal(isAcosAdmissionReceiptBoundToInputs({ ...exact, resulting_status: 'proposed' }, inputs), false)
})

test('exclusive router dispatches exactly one verified active ACOS admission', () => {
  const registry: RegisteredAgent[] = [
    { agentId: 'agent-shopping', category: 'shopping', admissionVerified: true, registrationState: 'active' },
    { agentId: 'agent-flight', category: 'flight', admissionVerified: true, registrationState: 'active' },
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
    { agentId: 'agent-flight', category: 'flight', admissionVerified: false, registrationState: 'active' },
  ]).status, 'no-dispatch')
  assert.equal(routeIntentExclusively(intent, [
    { agentId: 'agent-flight', category: 'flight', admissionVerified: true, registrationState: 'inactive' },
  ]).status, 'no-dispatch')

  const ambiguous = routeIntentExclusively(intent, [
    { agentId: 'agent-flight', category: 'flight', admissionVerified: true, registrationState: 'active' },
    { agentId: 'agent-backup', category: 'flight', admissionVerified: true, registrationState: 'active' },
  ])
  assert.equal(ambiguous.status, 'no-dispatch')
  if (ambiguous.status === 'no-dispatch') assert.equal(ambiguous.reason, 'ambiguous-category')

  const duplicate = routeIntentExclusively(intent, [
    { agentId: 'agent-flight', category: 'flight', admissionVerified: true, registrationState: 'active' },
    { agentId: 'agent-flight', category: 'flight', admissionVerified: true, registrationState: 'active' },
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
})

test('exclusive router rejects payment credentials before discovery egress', () => {
  const decision = routeIntentExclusively({
    intentId: 'intent-credential',
    category: 'flight',
    constraints: { origin: 'SIN', payment: { cardNumber: '4111111111111111' } },
  }, [{
    agentId: 'flight-primary',
    category: 'flight',
    admissionVerified: true,
    registrationState: 'active',
  }])
  assert.equal(decision.status, 'no-dispatch')
  if (decision.status === 'no-dispatch') assert.equal(decision.reason, 'invalid-intent')
})
