import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import {
  claimWouldBeAdmitted,
  validClaim,
  type Claim,
} from '../../src/domain/authoring-claim-policy.ts'

test('claim admission rejects live overlap and ignores expired holders without mutating inputs', () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u), { minLength: 1, maxLength: 8 }),
    fc.nat({ max: 10_000 }),
    fc.boolean(),
    (writeSet, offset, sameScope) => {
      const now = 1_000_000
      const held = claim('held', sameScope ? 'scope-a' : 'scope-b', writeSet, now + offset + 1)
      const incoming = claim('incoming', 'scope-a', writeSet, now + 20_000)
      const before = JSON.stringify([held, incoming])
      const denied = claimWouldBeAdmitted(incoming, [held], now)
      assert.equal(denied.ok, false)
      if (!denied.ok) assert.equal(denied.code, sameScope ? 'scope_held' : 'write_set_overlap')
      const afterExpiry = claimWouldBeAdmitted(incoming, [{ ...held, leaseExpiresAtMs: now }], now)
      assert.equal(afterExpiry.ok, true)
      assert.equal(JSON.stringify([held, incoming]), before)
    },
  ), { numRuns: 200 })
})

test('claim metadata is exact and fails closed when any undeclared field is supplied', () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u),
    (unknownField) => {
      const now = 1_000_000
      const input = {
        ...claim('exact', 'scope-a', ['registry'], now + 1_000),
        [`undeclared-${unknownField}`]: true,
      }
      assert.equal(validClaim(input as Claim, now), false)
    },
  ), { numRuns: 200 })
})

function claim(claimId: string, semanticScope: string, declaredWriteSet: readonly string[], expires: number): Claim {
  return Object.freeze({
    claimId,
    actorId: `actor-${claimId}`,
    deviceId: `device-${claimId}`,
    sessionId: `session-${claimId}`,
    worktree: `/tmp/${claimId}`,
    branch: `agent/test/${claimId}`,
    semanticScope,
    declaredWriteSet: Object.freeze([...declaredWriteSet]),
    leaseEpoch: 1,
    leaseExpiresAtMs: expires,
    fenceRevision: 'fence-v1',
  })
}
