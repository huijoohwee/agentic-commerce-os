import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  api, captureState, pagedRows, readZone, readDeployments, readReadiness,
  captureBaseline, authorizeRun, assertCurrentBaseline,
} from './provider.mjs';
import { WORKER, ROUTES, verifyCandidate } from './verify.mjs';
import { fetchGitHubJson } from '../production-release/human-authorization.ts';

const APP_ROUTE = 'airvio.co/agentic-commerce-os*';
const APP_WORKER = 'agentic-commerce-edge-production';
const REPOSITORY = 'huijoohwee/agentic-commerce-os';
const WORKFLOW = 'Commerce Storage Management Static Route Release';
const WORKFLOW_PATH = '.github/workflows/storage-management-static-release.yml';
const canonical = value => JSON.stringify(value);
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeOnce = (filename, value) => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
};

function verifyApplication(readiness, baseline) {
  const identity = value => ({ profile: value.profile, checkout: value.checkout, realMoney: value.realMoney,
    storage: value.storage, sourceRevision: value.sourceRevision, workerVersionId: value.workerVersionId });
  assert.equal(canonical(identity(readiness)), canonical(baseline.state.application), 'commerce_live_identity_changed');
}

function verifyPublic(previous, current) {
  assert(previous && current, 'retained_static_asset_readback_missing');
  const identity = value => value.assets.map(row => ({ path: row.path, status: row.status,
    bytes: row.bytes, sha256: row.sha256, contentType: row.contentType, cacheControl: row.cacheControl,
    csp: row.csp, nosniff: row.nosniff, permissions: row.permissions, referrer: row.referrer }));
  assert.equal(canonical(identity(previous)), canonical(identity(current)), 'retained_static_assets_not_restored');
}

async function restoreInitialRoute({ baseline, candidateSha, message, directory }) {
  const zone = await readZone(), account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const [routes, workers, app] = await Promise.all([
    pagedRows(`/zones/${zone.id}/workers/routes`),
    pagedRows(`/accounts/${account}/workers/workers`), readReadiness(),
  ]);
  verifyApplication(app, baseline);
  const broad = routes.filter(row => row.pattern === APP_ROUTE);
  assert.equal(broad.length, 1);
  assert.equal(broad[0].id, baseline.state.commerceRoute.id);
  assert.equal(broad[0].script, APP_WORKER);
  const collisions = routes.filter(row => ROUTES.includes(row.pattern)
    || String(row.pattern ?? '').startsWith('airvio.co/agentic-commerce-os/storage-management'));
  assert.equal(collisions.length <= ROUTES.length, true, 'rollback_route_identity_ambiguous');
  assert.equal(collisions.every(route => ROUTES.includes(route.pattern) && route.script === WORKER), true,
    'rollback_route_identity_ambiguous');
  if (collisions.length) {
    for (const route of collisions) {
      await api(`/zones/${zone.id}/workers/routes/${encodeURIComponent(route.id)}`, { method: 'DELETE' });
    }
  }
  const afterRouteRows = await pagedRows(`/zones/${zone.id}/workers/routes`);
  assert.equal(afterRouteRows.some(row => ROUTES.includes(row.pattern)
    || String(row.pattern ?? '').startsWith('airvio.co/agentic-commerce-os/storage-management')), false,
  'rollback_route_not_absent');
  const afterBroad = afterRouteRows.filter(row => row.pattern === APP_ROUTE);
  assert.equal(afterBroad.length, 1);
  assert.equal(afterBroad[0].id, baseline.state.commerceRoute.id);
  assert.equal(afterBroad[0].script, APP_WORKER);

  const scriptRows = workers.filter(row => row.name === WORKER || row.id === WORKER);
  assert.equal(scriptRows.length <= 1, true);
  if (scriptRows.length === 1) {
    const active = await readDeployments();
    assert.equal(active.message, message, 'rollback_worker_is_not_this_candidate');
    assert.equal((await pagedRows(`/zones/${zone.id}/workers/routes`)).some(row => row.script === WORKER), false,
      'rollback_worker_has_other_routes');
    await api(`/accounts/${account}/workers/scripts/${encodeURIComponent(WORKER)}`, { method: 'DELETE' });
  }
  const afterWorkers = await pagedRows(`/accounts/${account}/workers/workers`);
  assert.equal(afterWorkers.some(row => row.name === WORKER || row.id === WORKER), false,
    'rollback_worker_not_absent');
  const finalReadiness = await readReadiness();
  verifyApplication(finalReadiness, baseline);
  const receipt = { schema: 'commerce.storage-management-static-rollback/v1',
    candidateSha, action: collisions.length === 0 && scriptRows.length === 0 ? 'already-absent' : 'remove-new-route-and-worker',
    routePatterns: ROUTES, routeAbsent: true, workerAbsent: true,
    commerceRoute: { id: afterBroad[0].id, pattern: afterBroad[0].pattern, script: afterBroad[0].script },
    application: baseline.state.application, completedAt: new Date().toISOString() };
  writeOnce(path.resolve(directory, 'rollback-receipt.json'), receipt);
  return receipt;
}

async function restorePreviousVersion({ baseline, candidateSha, message, directory }) {
  const current = await captureState();
  verifyApplication(await readReadiness(), baseline);
  assert.deepEqual(current.commerceRoute, baseline.state.commerceRoute, 'commerce_route_changed_before_rollback');
  assert.deepEqual(current.storageRoutes, baseline.state.storageRoutes, 'storage_route_changed_before_rollback');
  assert.deepEqual(current.application, baseline.state.application, 'commerce_live_identity_changed');
  if (current.staticWorker.deployment.versionId === baseline.state.staticWorker.deployment.versionId) {
    verifyPublic(baseline.state.public, current.public);
    const receipt = { schema: 'commerce.storage-management-static-rollback/v1', candidateSha,
      action: 'already-at-retained-version', worker: WORKER,
      restoredVersionId: current.staticWorker.deployment.versionId, routePatterns: ROUTES,
      public: current.public, application: baseline.state.application, completedAt: new Date().toISOString() };
    writeOnce(path.resolve(directory, 'rollback-receipt.json'), receipt);
    return receipt;
  }
  assert.equal(current.staticWorker.deployment.message, message, 'rollback_refused_independent_worker_change');
  const priorVersion = baseline.state.staticWorker?.deployment?.versionId;
  assert.match(priorVersion ?? '', /^[0-9a-f-]{36}$/iu, 'retained_worker_version_missing');
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'rollback', priorVersion,
    '--config', 'wrangler.storage-management.jsonc', '--message', `Restore retained storage route version ${priorVersion}`,
    '--yes'], {
    stdio: 'inherit', timeout: 120000,
  });
  const after = await captureState();
  assert.equal(after.storageRoutes.length, ROUTES.length);
  assert.deepEqual(after.storageRoutes, baseline.state.storageRoutes);
  assert.equal(after.storageRoutes.every(route => route.script === WORKER), true);
  assert.equal(after.staticWorker.deployment.versionId, priorVersion, 'retained_worker_version_not_restored');
  verifyPublic(baseline.state.public, after.public);
  verifyApplication(await readReadiness(), baseline);
  const receipt = { schema: 'commerce.storage-management-static-rollback/v1', candidateSha,
    action: 'rollback-retained-worker-version', worker: WORKER, versionId: priorVersion,
    routePatterns: ROUTES, routeIds: after.storageRoutes.map(route => route.id),
    public: after.public, application: baseline.state.application, completedAt: new Date().toISOString() };
  writeOnce(path.resolve(directory, 'rollback-receipt.json'), receipt);
  return receipt;
}

export async function restoreBaseline({ baseline, candidateSha, message, directory }) {
  assert.equal(baseline.candidateSha, candidateSha);
  assert.equal(baseline.state.application.checkout, 'live');
  if (baseline.releaseMode === 'bootstrap') return restoreInitialRoute({ baseline, candidateSha, message, directory });
  assert.equal(baseline.releaseMode, 'steady-state');
  return restorePreviousVersion({ baseline, candidateSha, message, directory });
}

async function validateReleaseRun(receipt, expectedRunId) {
  const authorization = receipt.authorization;
  assert.equal(authorization.repository, REPOSITORY);
  assert.equal(authorization.workflow, WORKFLOW_PATH);
  assert.equal(Number(authorization.runId), expectedRunId);
  assert.match(authorization.candidateSha ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(authorization.approval?.runId, expectedRunId);
  assert.equal(authorization.approval?.candidateSha, authorization.candidateSha);
  const token = process.env.GH_TOKEN ?? '';
  const run = await fetchGitHubJson(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${expectedRunId}`, token);
  assert.equal(run.id, expectedRunId);
  assert.equal(run.name, WORKFLOW);
  assert.equal(run.path, WORKFLOW_PATH);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, authorization.candidateSha);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.repository?.full_name, REPOSITORY);
}

export async function rollbackRelease({ releaseDirectory, evidenceDirectory, candidateSha }) {
  const receipt = read(path.join(releaseDirectory, 'release-receipt.json'));
  assert.equal(receipt.schema, 'commerce.storage-management-static-release/v1');
  assert.equal(receipt.baseline?.candidateSha, receipt.candidate?.candidateSha);
  assert.equal(receipt.baseline?.candidateDigest, receipt.candidate?.assetDigest);
  assert.equal(receipt.authorization?.candidateSha, receipt.candidate?.candidateSha);
  assert.equal(receipt.authorization?.approval?.decision, 'approved');
  assert.equal(receipt.production?.staticWorker?.name, WORKER);
  const expectedRunId = Number(process.env.STORAGE_MANAGEMENT_ROLLBACK_RUN_ID);
  assert(Number.isSafeInteger(expectedRunId) && expectedRunId > 0);
  await validateReleaseRun(receipt, expectedRunId);
  verifyCandidate({ candidateSha });
  const baseline = await captureBaseline(candidateSha, evidenceDirectory);
  assert.equal(baseline.releaseMode, 'steady-state', 'rollback_requires_an_existing_static_route');
  const authorization = await authorizeRun(candidateSha, evidenceDirectory);
  assert.equal(authorization.releaseMode, 'steady-state');
  const currentBaseline = await assertCurrentBaseline(evidenceDirectory);
  assert.equal(currentBaseline.baseline.stateDigest, baseline.stateDigest);

  const retainedBaseline = receipt.baseline;
  const releaseCandidate = receipt.candidate.candidateSha;
  const message = receipt.deploymentMessage;
  const current = await captureState();
  assert.deepEqual(current, currentBaseline.current, 'provider_baseline_drift_before_rollback');
  assert.equal(current.staticWorker?.deployment.versionId, receipt.production.staticWorker.deployment.versionId,
    'rollback_target_is_not_the_selected_release');
  assert.equal(current.staticWorker?.deployment.message, message, 'rollback_target_changed_after_release');
  assert.deepEqual(current.commerceRoute, receipt.production.commerceRoute, 'commerce_route_changed_after_release');
  assert.deepEqual(current.storageRoutes, receipt.production.storageRoutes, 'storage_routes_changed_after_release');
  assert.deepEqual(current.application, receipt.production.application, 'commerce_live_identity_changed_after_release');
  const rollbackReceipt = await restoreBaseline({ baseline: retainedBaseline, candidateSha: releaseCandidate,
    message, directory: evidenceDirectory });
  return { releaseRunId: receipt.authorization.runId, releaseCandidate, rollbackReceipt,
    rollbackAuthorization: authorization };
}

async function main() {
  const [command, candidateSha, releaseDirectory, evidenceDirectory, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  assert.equal(command, 'rollback');
  assert(candidateSha && releaseDirectory && evidenceDirectory);
  const result = await rollbackRelease({ releaseDirectory: path.resolve(releaseDirectory),
    evidenceDirectory: path.resolve(evidenceDirectory), candidateSha });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
