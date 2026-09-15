import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAgentDefinitionRegistry } from 'agentic-os/agents/agent-definitions';
import { createCommerceWorkerExtension } from '../../src/admission/worker-extension.js';
import { readAuthoringMutationPermit, commerceAdmissionAuthHeaders, sha256Hex } from '../../src/admission/commerce-admission-contract.js';
import { createGraphAuthorityBinding, createGraphAuthorityFixture } from './lib/commerce-admission-auth-fixture.mjs';
import { createNamespace, DEPLOYMENT_IDENTITY, AUTH_SECRET } from './lib/commerce-admission-provider-fixture.mjs';

test('product extension keeps internal admission private and declines unrelated routes', async () => {
  const extension = createCommerceWorkerExtension();
  assert.equal(await extension.handle(new Request('https://airvio.co/api/ready')), null);
  const hidden = await extension.handle(new Request('https://airvio.co/agentic-os/internal/admission'));
  assert.equal(hidden.status, 404);
  const probe = await extension.handle(new Request('https://airvio.co/release-proof/commerce-admission'));
  assert.equal(probe.status, 503);
  assert.equal((await probe.json()).code, 'release_probe_unconfigured');
  await extension.beforeReadiness();
});

test('product extension rehydrates another isolate registration into the injected OS registry', async () => {
  const fixture = JSON.parse(await readFile(new URL(import.meta.resolve('agentic-os/test/contracts/admission-v2.fixture.json'))));
  const permit = readAuthoringMutationPermit(new Headers(fixture.request.headers));
  assert.ok(permit);
  const now = Date.now();
  const authority = createGraphAuthorityFixture({ authorization: createGraphAuthorityBinding({
    authoringMutationIntent: fixture.request.body.authoring_mutation_intent, permit,
  }), operatorInstructionRef: fixture.request.body.operator_instruction_ref,
  issuedAtMs: now - 1_000, expiresAtMs: now + 60_000 });
  const namespace = createNamespace();
  const env = { AGENT_STATE: namespace, AGENTIC_OS_ADMISSION_AUTH_SECRET: AUTH_SECRET,
    AGENTIC_OS_ADMISSION_AUTHORITY_REF: authority.authorityRef,
    AGENTIC_OS_ADMISSION_OPERATOR_INSTRUCTION_REF: authority.operatorInstructionRef,
    AGENTIC_OS_ADMISSION_AUTHORITY_EVIDENCE: authority.evidence,
    AGENTIC_OS_ADMISSION_AUTHORITY_HMAC_SECRET: authority.secret,
    ACOS_SOURCE_REVISION: DEPLOYMENT_IDENTITY.sourceRevision,
    ACOS_CANDIDATE_DIGEST: DEPLOYMENT_IDENTITY.candidateDigest,
    CF_VERSION_METADATA: { id: DEPLOYMENT_IDENTITY.versionId, tag: DEPLOYMENT_IDENTITY.versionTag,
      timestamp: DEPLOYMENT_IDENTITY.versionTimestamp } };
  const registry = createAgentDefinitionRegistry();
  const first = createCommerceWorkerExtension({ env, agentDefinitions: registry });
  const second = createCommerceWorkerExtension({ env: { ...env }, agentDefinitions: createAgentDefinitionRegistry() });
  await first.beforeReadiness(); assert.equal(registry.stats().agents, 0);
  const body = JSON.stringify(fixture.request.body);
  const headers = new Headers(fixture.request.headers);
  const authentication = await commerceAdmissionAuthHeaders({ method: fixture.request.method, url: fixture.request.url,
    bodyDigest: await sha256Hex(new TextEncoder().encode(body)), headers, secret: AUTH_SECRET });
  for (const [name, value] of Object.entries(authentication)) headers.set(name, value);
  const response = await second.handle(new Request(fixture.request.url, { method: fixture.request.method, headers, body }));
  assert.equal(response.status, 200, await response.text());
  assert.equal(registry.stats().agents, 0);
  await first.beforeReadiness();
  assert.equal(registry.stats().agents, 1); assert.equal(registry.stats().statusCounts.active, 1);
});
