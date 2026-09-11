import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGitHubJson } from '../production-release/human-authorization.ts';

// An operator-selected expected state, not a substitute for the provider readback.
export function parseRetainedBaseline(input) {
  if (input === '' || input === undefined || input === null) return null;
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  assert.deepEqual(Object.keys(value).sort(), ['deploymentId', 'failedRunId', 'sourceRevision', 'versionId']);
  assert(Number.isSafeInteger(value.failedRunId) && value.failedRunId > 0, 'Retained run ID invalid');
  assert.match(value.sourceRevision, /^[a-f0-9]{40}$/);
  for (const id of [value.deploymentId, value.versionId]) assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return { failedRunId: value.failedRunId, sourceRevision: value.sourceRevision,
    deploymentId: value.deploymentId, versionId: value.versionId };
}
export function validateRetainedRun(value, run, jobs) {
  const baseline = parseRetainedBaseline(value);
  assert(baseline && run.id === baseline.failedRunId && run.head_sha === baseline.sourceRevision
    && run.status === 'completed' && run.conclusion === 'failure' && run.run_attempt === 1
    && run.head_branch === 'main' && run.event === 'workflow_dispatch'
    && run.path === '.github/workflows/local-first-release.yml'
    && run.name === 'Local-first Production Release', 'Retained local-first run mismatch');
  assert.equal(run.repository.full_name, 'huijoohwee/agentic-commerce-os');
  const owner = run.repository.owner;
  assert(owner.type === 'User' && owner.login === 'huijoohwee' && owner.id > 0, 'Retained owner mismatch');
  for (const actor of [run.actor, run.triggering_actor]) {
    assert(actor.type === 'User' && actor.id === owner.id && actor.login === owner.login, 'Retained actor mismatch');
  }
  const release = jobs.jobs.filter(job => job.name === 'Authorized Local-first Production Release');
  assert(release.length === 1 && release[0].conclusion === 'failure', 'Retained release job mismatch');
  for (const [name, conclusion] of [['Verify scoped owner policy and actual run approval', 'success'],
    ['Deploy asset-only Worker and verify the exact public release', 'failure']]) {
    const steps = release[0].steps.filter(step => step.name === name);
    assert(steps.length === 1 && steps[0].conclusion === conclusion, 'Retained release did not pass owner authorization');
  }
  return baseline;
}
export async function verifyRetainedBaseline(input, token) {
  const baseline = parseRetainedBaseline(input);
  if (!baseline) return null;
  const base = `https://api.github.com/repos/huijoohwee/agentic-commerce-os/actions/runs/${baseline.failedRunId}`;
  const [run, jobs] = await Promise.all([fetchGitHubJson(base, token), fetchGitHubJson(`${base}/jobs`, token)]);
  return validateRetainedRun(baseline, run, jobs);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.env.LOCAL_FIRST_EVIDENCE_DIR || 'node_modules/.cache/local-first-verification');
  verifyRetainedBaseline(process.env.LOCAL_FIRST_RETAINED_BASELINE, process.env.GH_TOKEN).then(value => {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'retained-baseline.json'), JSON.stringify(value) + '\n');
    console.log(JSON.stringify({ retainedBaseline: value }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
