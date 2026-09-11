import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateHumanAuthorization, parseHumanAuthorizationReceipt, fetchGitHubJson } from '../production-release/human-authorization.ts';
import { CONFIG, assertLocalFirstConfig, sourceManifest } from './artifact.mjs';

const SCHEMA = 'commerce.local-first-owner-authorization/v1';
const REPOSITORY = 'huijoohwee/agentic-commerce-os';
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.sort(), 'Authorization shape mismatch');

export function parseLocalFirstAuthorization(value, expected) {
  keys(value, ['schema', 'profile', 'checkout', 'repository', 'owner', 'artifactDigest', 'approval']);
  assert(value.schema === SCHEMA && value.profile === 'local-first' && value.checkout === 'deferred', 'Local-first authorization required');
  assert.equal(value.repository, REPOSITORY);
  assert.match(value.artifactDigest, /^[a-f0-9]{64}$/);
  assert.equal(value.artifactDigest, expected.artifactDigest, 'Authorization artifact mismatch');
  keys(value.owner, ['login', 'id', 'type']);
  assert.equal(value.owner.login, REPOSITORY.split('/')[0]);
  const approval = parseHumanAuthorizationReceipt(value.approval, expected);
  assert.deepEqual(approval.approver, value.owner, 'Approval must belong to the repository owner');
  return Object.freeze({ ...value, approval });
}

export function validateLocalFirstAuthorization(reviews, environment, run, config, expected) {
  assertLocalFirstConfig(config);
  assert(run.id === expected.runId && run.head_sha === expected.candidateSha && run.run_attempt === 1
    && run.head_branch === 'main' && run.event === 'workflow_dispatch'
    && run.name === 'Local-first Production Release' && run.path === '.github/workflows/local-first-release.yml',
  'Exact first-attempt local-first workflow required');
  assert.equal(run.repository.full_name, REPOSITORY);
  const owner = run.repository.owner;
  assert(owner.type === 'User' && Number.isSafeInteger(owner.id) && owner.id > 0, 'Human repository owner required');
  for (const actor of [run.actor, run.triggering_actor]) {
    assert(actor.type === 'User' && actor.id === owner.id && actor.login === owner.login, 'Owner workflow initiation required');
  }
  const approval = validateHumanAuthorization(reviews, environment, { ...expected, allowOwnerSelfReview: true });
  return parseLocalFirstAuthorization({ schema: SCHEMA, profile: 'local-first', checkout: 'deferred',
    repository: REPOSITORY, owner: { login: owner.login, id: owner.id, type: owner.type },
    artifactDigest: expected.artifactDigest, approval }, expected);
}

async function main() {
  const [command, releaseMode, candidateSha, id, attempt, output, ...extra] = process.argv.slice(2);
  assert(command === 'fetch' && !extra.length && output, 'Expected fetch mode candidate run attempt output');
  const env = process.env;
  assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === REPOSITORY
    && env.GITHUB_WORKFLOW === 'Local-first Production Release' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_SHA === candidateSha
    && env.GITHUB_RUN_ID === id && env.GITHUB_RUN_ATTEMPT === attempt && attempt === '1', 'Protected release context required');
  const manifest = sourceManifest(candidateSha);
  const base = `https://api.github.com/repos/${REPOSITORY}`;
  const [reviews, environment, run] = await Promise.all([
    fetchGitHubJson(`${base}/actions/runs/${id}/approvals`, env.GH_TOKEN),
    fetchGitHubJson(`${base}/environments/production`, env.GH_TOKEN),
    fetchGitHubJson(`${base}/actions/runs/${id}`, env.GH_TOKEN),
  ]);
  const receipt = validateLocalFirstAuthorization(reviews, environment, run, JSON.parse(fs.readFileSync(CONFIG)), {
    releaseMode, candidateSha, runId: Number(id), runAttempt: Number(attempt), artifactDigest: manifest.artifactDigest,
  });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
