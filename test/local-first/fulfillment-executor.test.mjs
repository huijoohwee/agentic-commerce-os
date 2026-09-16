import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createListingExecutor } from '../../scripts/durable-fulfillment/executor.mjs';
import { LISTING_DEFINITION, LISTING_DEFINITION_SHA256, FULFILLMENT_AGENT } from '../../src/local-first/fulfillment-definition.ts';

const call = () => ({ agent: FULFILLMENT_AGENT, execution: { idempotencyKey: 'fixture-listing-1' },
  input: { task: { context: { title: 'Blue mug', description: '300 ml ceramic mug', draftId: 'private-draft' } },
    privatePrompt: 'must not reach the model' }, signal: new AbortController().signal });
const observed = () => ({ verified: true, modelSha256: LISTING_DEFINITION.modelSha256,
  imageDigest: LISTING_DEFINITION.imageDigest });
function setup(options = {}) {
  let calls = 0, request;
  const execute = createListingExecutor({ endpoint: 'http://127.0.0.1:18765/v1/chat/completions',
    getHeaders: () => new Headers(), verifyArtifacts: observed,
    fetchImpl: async (_url, init) => {
      calls++; request = JSON.parse(init.body);
      return Response.json({ model: 'sha256:' + LISTING_DEFINITION.modelSha256,
        choices: [{ finish_reason: 'stop', message: { content: 'Blue mug\n- Ceramic\n- 300 ml' } }],
        usage: { prompt_tokens: 50, completion_tokens: 15 } });
    }, ...options });
  return { execute, calls: () => calls, request: () => request };
}

test('listing revision binds the complete immutable execution definition', () => {
  assert.equal(createHash('sha256').update(JSON.stringify(LISTING_DEFINITION)).digest('hex'), LISTING_DEFINITION_SHA256);
  assert.equal(FULFILLMENT_AGENT.revision, 'listing-' + LISTING_DEFINITION_SHA256);
});

test('listing executor uses only reviewed artifacts and the bounded product draft', async () => {
  const fixture = setup(); const result = await fixture.execute(call());
  assert.equal(fixture.calls(), 1); assert.equal(result.effect, 'read-only');
  assert.equal(result.output.definitionDigest, LISTING_DEFINITION_SHA256);
  assert.equal(result.output.costUsd, null);
  const request = fixture.request();
  assert.equal(request.max_tokens, 256); assert.equal(request.temperature, 0);
  assert.deepEqual(JSON.parse(request.messages[0].content), { instructions: LISTING_DEFINITION.instructions,
    draft: { title: 'Blue mug', description: '300 ml ceramic mug' } });
});

test('changed definition, absent verification and artifact drift stop before inference', async () => {
  for (const observation of [null, { ...observed(), verified: false },
    { ...observed(), modelSha256: '0'.repeat(64) }, { ...observed(), imageDigest: 'sha256:' + '0'.repeat(64) }]) {
    const fixture = setup({ verifyArtifacts: () => observation });
    await assert.rejects(fixture.execute(call()), error => error.reasonCode === 'listing_artifacts_mismatch');
    assert.equal(fixture.calls(), 0);
  }
  const fixture = setup();
  await assert.rejects(fixture.execute({ ...call(), agent: { ...FULFILLMENT_AGENT, revision: 'listing-v1' } }),
    error => error.reasonCode === 'listing_definition_mismatch');
  assert.equal(fixture.calls(), 0);
});

test('host must supply credentials and an artifact verifier', () => {
  assert.throws(() => createListingExecutor({ endpoint: 'http://127.0.0.1:18765' }), /host-owned/);
});

test('admitted inference records measured local usage and missing usage stays unknown', async () => {
  const resourceBounds = { inputTokens: 2048, outputTokens: 256, attempts: 1, elapsedMs: 55000 };
  const fixture = setup();
  const result = await fixture.execute({ ...call(), resourceBounds });
  assert.equal(result.costLog.prompt_tokens, 50); assert.equal(result.costLog.completion_tokens, 15);
  assert.equal(result.costLog.estimated_cost_usd, 0);
  assert.equal(result.output.costUsd, null);
  const unknown = setup({ fetchImpl: async () => Response.json({ model: 'sha256:' + LISTING_DEFINITION.modelSha256,
    choices: [{ finish_reason: 'stop', message: { content: 'Listing' } }] }) });
  const value = await unknown.execute({ ...call(), resourceBounds });
  assert.equal(value.costLog, undefined); assert.equal(value.output.usage, null);
});
