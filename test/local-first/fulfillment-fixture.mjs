import { createHash } from 'node:crypto';
import { FULFILLMENT_AGENT, FULFILLMENT_GOAL } from '../../src/local-first/fulfillment-contract.ts';
import { LISTING_DEFINITION_SHA256 } from '../../src/local-first/fulfillment-definition.ts';

// Synthetic plan identity for deterministic tests; never a deployment or source attestation.
export const listingPlanFixture = (revision = 'a'.repeat(40)) => ({
  repository: 'github.com/huijoohwee/agentic-commerce-os', path: 'docs/durable-fulfillment.md', revision,
  digest: createHash('sha256').update('listing-plan-fixture:' + revision).digest('hex'),
  continuityId: 'DURABLE-LISTING-FULFILLMENT-001',
  revisions: Object.fromEntries(['prd', 'tad', 'adr', 'mvp', 'gtm'].map(role => [role, '0.2.0'])),
});
export const listingInputFixture = (suffix = '1') => ({ runId: 'listing-' + suffix.repeat(64),
  conversationId: '12345678-1234-1234-1234-123456789012', agent: FULFILLMENT_AGENT,
  goal: FULFILLMENT_GOAL, maxParallel: 1, input: { draftId: '12345678-1234-1234-1234-123456789012',
    revision: 1, title: 'Ceramic mug', description: 'Blue, 300 ml' } });
export const listingOutputFixture = () => ({ status: 'completed', effect: 'read-only',
  costLog: { model: 'deterministic-fixture', prompt_tokens: 10, completion_tokens: 8,
    cache_hits: 0, estimated_cost_usd: 0 },
  output: { text: 'Ceramic mug\n- Blue\n- 300 ml', definitionDigest: LISTING_DEFINITION_SHA256,
    usage: { promptTokens: 10, completionTokens: 8 }, costUsd: null } });
