import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readAuthoringMutationPermit } from "../../src/admission/commerce-admission-contract.js";
import { createNamespace } from "./lib/commerce-admission-provider-fixture.mjs";
import { handleCloudflareRequest } from "../../src/admission/worker.js";
import {
  createGraphAuthorityBinding,
  createGraphAuthorityFixture,
} from "./lib/commerce-admission-auth-fixture.mjs";
import { DEPLOYMENT_IDENTITY } from "./lib/commerce-admission-provider-fixture.mjs";

const AUTH_SECRET = "agentic-os-admission-dev-secret-rotate-before-production";

function environment(namespace, fixture) {
  const now = Date.now();
  const permit = readAuthoringMutationPermit(new Headers(fixture.request.headers));
  if (!permit) throw new TypeError("Fixture admission permit is malformed.");
  const authority = createGraphAuthorityFixture({
    authorization: createGraphAuthorityBinding({
      authoringMutationIntent: fixture.request.body.authoring_mutation_intent,
      permit,
    }),
    operatorInstructionRef: fixture.request.body.operator_instruction_ref,
    issuedAtMs: now - 1_000,
    expiresAtMs: now + 60_000,
  });
  return {
    AGENT_STATE: namespace,
    AGENTIC_OS_ADMISSION_AUTH_SECRET: AUTH_SECRET,
    AGENTIC_OS_ADMISSION_AUTHORITY_REF: authority.authorityRef,
    AGENTIC_OS_ADMISSION_OPERATOR_INSTRUCTION_REF: authority.operatorInstructionRef,
    AGENTIC_OS_ADMISSION_AUTHORITY_EVIDENCE: authority.evidence,
    AGENTIC_OS_ADMISSION_AUTHORITY_HMAC_SECRET: authority.secret,
    ACOS_SOURCE_REVISION: DEPLOYMENT_IDENTITY.sourceRevision,
    ACOS_CANDIDATE_DIGEST: DEPLOYMENT_IDENTITY.candidateDigest,
    CF_VERSION_METADATA: {
      id: DEPLOYMENT_IDENTITY.versionId,
      tag: DEPLOYMENT_IDENTITY.versionTag,
      timestamp: DEPLOYMENT_IDENTITY.versionTimestamp,
    },
  };
}

test("a warm isolate refreshes its public definition projection when another isolate commits", async () => {
  const fixture = JSON.parse(await readFile(new URL(import.meta.resolve(
    "agentic-os/test/contracts/admission-v2.fixture.json",
  ))));
  const namespace = createNamespace();
  const isolateA = environment(namespace, fixture);
  const isolateB = environment(namespace, fixture);
  const readyRequest = () => new Request("https://airvio.co/api/ready");

  const before = await (await handleCloudflareRequest(readyRequest(), isolateA)).json();
  assert.equal(before.agentDefinitions.agents, 0);

  const committed = await handleCloudflareRequest(new Request(fixture.request.url, {
    method: fixture.request.method,
    headers: fixture.request.headers,
    body: JSON.stringify(fixture.request.body),
  }), isolateB);
  assert.equal(committed.status, 200);

  const refreshed = await (await handleCloudflareRequest(readyRequest(), isolateA)).json();
  assert.equal(refreshed.agentDefinitions.agents, 1);
  assert.equal(refreshed.agentDefinitions.configured, true);
  assert.equal(refreshed.agentDefinitions.statusCounts.active, 1);
});
