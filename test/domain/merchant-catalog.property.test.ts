import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'

import {
  projectMerchantCatalog,
  readListing,
  type MerchantListing,
} from '../../src/core/merchant-catalog.ts'

const identifierArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u)

// Feature: agentic-graph-commerce-platform, Property 9: Catalog scope containment
test('merchant catalog returns every and only listing inside its declared agent scope', () => {
  fc.assert(fc.property(
    fc.uniqueArray(
      fc.tuple(identifierArbitrary, fc.boolean()),
      { minLength: 1, maxLength: 50, selector: ([agentId]) => agentId },
    ),
    (entries) => {
      const listings: readonly MerchantListing[] = entries.map(([agentId]) => Object.freeze({
        listingId: `listing-${agentId}`,
        owningAgentId: agentId,
        category: 'shopping',
        capabilities: Object.freeze(['catalog.read']),
      }))
      const scope = entries.filter(([, included]) => included).map(([agentId]) => agentId)
      const projected = projectMerchantCatalog(listings, scope)
      const expected = listings.filter(({ owningAgentId }) => scope.includes(owningAgentId))

      assert.deepEqual(projected, expected)
      assert.equal(projected.every(({ owningAgentId }) => scope.includes(owningAgentId)), true)
      for (const listing of listings) {
        assert.deepEqual(
          readListing(projected, scope, listing.listingId),
          scope.includes(listing.owningAgentId) ? listing : null,
        )
      }
    },
  ), { numRuns: 300, seed: 20_260_909 })
})
