import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyVendorTransition,
  validSettlement,
  validVendorList,
} from '../../src/core/marketplace-provider-response.ts'
import {
  MARKETPLACE_PROVIDER_RESPONSE_KEYS,
  MARKETPLACE_PROVIDER_RESPONSE_SCHEMA,
  MARKETPLACE_RECOVERY_409_CODES,
  MARKETPLACE_TERMINAL_409_CODES,
  MARKETPLACE_VENDOR_STATES,
} from '../../src/core/marketplace-provider-response-contract.ts'

const CONTRACT = 'commerce.marketplace-provider/v1'
const TRANSITION = Object.freeze({
  ok: true,
  contract: CONTRACT,
  vendorId: 'vendor-1',
  actorId: 'operator-1',
  state: 'active',
  mutationId: 'mutation-1',
})

test('marketplace success parsers require exact status, shape, identities, amounts, currency, and state', () => {
  assert.equal(validVendorList(200, { ok: true, contract: CONTRACT, vendors: [] }), true)
  assert.equal(validVendorList(200, { ok: true, contract: CONTRACT, vendors: [], demo: true }), false)
  assert.equal(validVendorList(202, { ok: true, contract: CONTRACT, vendors: [] }), false)

  assert.equal(classifyVendorTransition(
    200, TRANSITION, 'vendor-1', 'operator-1', 'active', 'mutation-1',
  ), 'success')
  for (const mutation of [
    { ...TRANSITION, vendorId: 'vendor-2' },
    { ...TRANSITION, actorId: 'operator-2' },
    { ...TRANSITION, mutationId: 'mutation-2' },
    { ...TRANSITION, state: 'suspended' },
    { ...TRANSITION, extra: true },
  ]) {
    assert.equal(classifyVendorTransition(
      200, mutation, 'vendor-1', 'operator-1', 'active', 'mutation-1',
    ), 'invalid')
  }

  const settlement = {
    ok: true, contract: CONTRACT, splitId: 'split-1', state: 'settled', amountMinor: 12_500, currency: 'USD',
  }
  assert.equal(validSettlement(200, settlement, 'split-1'), true)
  assert.equal(validSettlement(200, { ...settlement, splitId: 'split-2' }, 'split-1'), false)
  assert.equal(validSettlement(200, { ...settlement, amountMinor: -1 }, 'split-1'), false)
  assert.equal(validSettlement(200, { ...settlement, currency: 'usd' }, 'split-1'), false)
  assert.equal(validSettlement(200, { ...settlement, extra: true }, 'split-1'), false)
})

test('vendor reservation completion classification accepts only exact durable 409 outcomes', () => {
  const terminal = { ok: false, contract: CONTRACT, code: 'authoring_mutation_fence_stale' }
  assert.equal(classifyVendorTransition(
    409, terminal, 'vendor-1', 'operator-1', 'active', 'mutation-1',
  ), 'terminal')
  assert.equal(classifyVendorTransition(
    500, terminal, 'vendor-1', 'operator-1', 'active', 'mutation-1',
  ), 'invalid')
  assert.equal(classifyVendorTransition(
    409, { ...terminal, code: 'unknown_terminal' }, 'vendor-1', 'operator-1', 'active', 'mutation-1',
  ), 'invalid')
  assert.equal(classifyVendorTransition(
    409, { ...terminal, detail: 'extra' }, 'vendor-1', 'operator-1', 'active', 'mutation-1',
  ), 'invalid')
})

test('pins the owner response SSOT and keeps terminal and recovery dispositions disjoint', () => {
  assert.equal(MARKETPLACE_PROVIDER_RESPONSE_SCHEMA, 'commerce.marketplace-provider-response/v1')
  assert.deepEqual(MARKETPLACE_VENDOR_STATES, ['pending_review', 'approved', 'active', 'suspended'])
  assert.deepEqual(MARKETPLACE_TERMINAL_409_CODES, [
    'authoring_mutation_lease_expired', 'authoring_mutation_fence_stale',
    'authoring_mutation_fence_conflict', 'authoring_mutation_id_conflict', 'transition_rejected',
  ])
  assert.deepEqual(MARKETPLACE_RECOVERY_409_CODES, [
    'operational_evidence_binding_invalid', 'authoring_mutation_permit_invalid',
    'authoring_mutation_payload_mismatch', 'authoring_mutation_reconciliation_required',
  ])
  assert.equal(MARKETPLACE_TERMINAL_409_CODES.some((code) => (
    MARKETPLACE_RECOVERY_409_CODES as readonly string[]).includes(code)), false)
  assert.deepEqual(MARKETPLACE_PROVIDER_RESPONSE_KEYS.transition,
    ['actorId', 'contract', 'mutationId', 'ok', 'state', 'vendorId'])
})
