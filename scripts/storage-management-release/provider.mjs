import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchGitHubJson, validateHumanAuthorization } from '../production-release/human-authorization.ts';
import { ROUTES, PUBLIC_PREFIX, WORKER, verifyCandidate } from './verify.mjs';

const ACCOUNT = () => required('CLOUDFLARE_ACCOUNT_ID');
const TOKEN = () => required('CLOUDFLARE_API_TOKEN');
const REPOSITORY = 'huijoohwee/agentic-commerce-os';
const WORKFLOW = 'Commerce Storage Management Static Route Release';
const WORKFLOW_PATH = '.github/workflows/storage-management-static-release.yml';
const APP_ROUTE = 'airvio.co/agentic-commerce-os*';
const APP_WORKER = 'agentic-commerce-edge-production';
const APP_READINESS = 'https://airvio.co/agentic-commerce-os/readyz';
const WORKER_LIMIT = 100;
const ROUTE_LIMIT = 1000;
const canonical = value => JSON.stringify(stable(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

function required(name) {
  const value = process.env[name] ?? '';
  assert(value === value.trim() && value.length > 0 && value.length <= 4096, `${name.toLowerCase()}_invalid`);
  return value;
}

async function boundedBody(response, maximum, label) {
  assert(response.body, `${label}_body_missing`);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      assert(length <= maximum, `${label}_body_too_large`);
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function boundedJson(response, maximum, label) {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    assert.fail(`${label}_content_type_invalid`);
  }
  const bytes = await boundedBody(response, maximum, label);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function api(route, { method = 'GET', body } = {}) {
  assert(route.startsWith('/') && !route.includes('..'));
  const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    method, redirect: 'error', cache: 'no-store',
    headers: { authorization: `Bearer ${TOKEN()}`, accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const value = await boundedJson(response, 1_048_576, 'cloudflare_api');
  assert.equal(response.redirected, false, 'cloudflare_redirect_refused');
  assert.equal(response.ok && value.success === true, true,
    `cloudflare_api_failed:${route}:${response.status}`);
  return value;
}

export async function readZone() {
  const result = await api(`/zones?name=airvio.co`);
  assert.equal(Array.isArray(result.result), true);
  assert.equal(result.result.length, 1, 'airvio_zone_not_unique');
  const row = result.result[0];
  assert.equal(row.name, 'airvio.co');
  assert.equal(row.status, 'active');
  assert.match(row.id ?? '', /^[a-f0-9]{32}$/u);
  const plan = row.plan ?? {};
  const planId = String(plan.legacy_id ?? plan.id ?? '').toLowerCase();
  const planName = String(plan.name ?? '').toLowerCase();
  assert.equal(planId === 'free' || planName === 'free' || planName === 'free website', true,
    'cloudflare_zone_not_free');
  if (plan.price !== undefined) assert.equal(Number(plan.price), 0, 'cloudflare_zone_not_zero_cost');
  return { id: row.id, plan: { id: planId, name: plan.name ?? null, price: plan.price ?? null } };
}

export async function pagedRows(route, key = null) {
  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await api(`${route}?page=${page}&per_page=100`);
    const values = key ? result.result?.[key] : result.result;
    assert.equal(Array.isArray(values), true, `cloudflare_${key ?? 'rows'}_shape_invalid`);
    rows.push(...values);
    const pages = Number(result.result_info?.total_pages ?? 1);
    assert(Number.isSafeInteger(pages) && pages >= 1 && pages <= 20, 'cloudflare_pagination_invalid');
    if (page >= pages) return rows;
  }
  throw Error('cloudflare_inventory_exceeded_page_budget');
}

export async function readDeployments() {
  const result = await api(`/accounts/${ACCOUNT()}/workers/scripts/${encodeURIComponent(WORKER)}/deployments?page=1&per_page=20`);
  const rows = result.result?.deployments;
  assert.equal(Array.isArray(rows) && rows.length > 0, true, 'static_worker_deployment_missing');
  const current = rows[0];
  assert.equal(Number.isFinite(Date.parse(current.created_on)), true, 'worker_deployment_time_invalid');
  assert.equal(Array.isArray(current.versions) && current.versions.length === 1, true,
    'static_worker_split_deployment_refused');
  const active = current.versions[0];
  assert.equal(active.percentage, 100, 'static_worker_not_fully_active');
  assert.match(active.version_id ?? '', /^[0-9a-f-]{36}$/iu);
  return { deploymentId: current.id, createdOn: current.created_on,
    versionId: active.version_id, message: current.annotations?.['workers/message'] ?? null };
}

export async function readReadiness() {
  const response = await fetch(APP_READINESS, {
    method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
    signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' },
  });
  if (response.status !== 200) await response.body?.cancel();
  assert.equal(response.status, 200, 'commerce_readiness_unavailable');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);
  const value = await boundedJson(response, 16_384, 'commerce_readiness');
  assert.equal(value.ok, true);
  assert.equal(value.profile, 'local-first');
  assert.equal(value.checkout, 'live', 'commerce_checkout_not_live');
  assert.equal(value.realMoney, true, 'commerce_live_checkout_state_changed');
  assert.equal(value.storage, 'browser-only');
  assert.match(value.sourceRevision ?? '', /^[a-f0-9]{40}$/u);
  assert.match(value.workerVersionId ?? '', /^[0-9a-f-]{36}$/iu);
  return value;
}

const routeShape = row => ({ id: row.id, pattern: row.pattern, script: row.script ?? null });
const applicationIdentity = value => ({ profile: value.profile, checkout: value.checkout,
  realMoney: value.realMoney, storage: value.storage, sourceRevision: value.sourceRevision,
  workerVersionId: value.workerVersionId });

export async function readPublicAssets(candidate = null) {
  const rows = [];
  const expected = candidate?.files ?? null;
  const files = expected?.map(row => ({ path: row.path.slice(`${PUBLIC_PREFIX.slice(1)}/`.length), bytes: row.bytes, sha256: row.sha256 }))
    ?? ['index.html', 'style.css', 'guide.js', 'sources.json', 'sw.js'].map(path => ({ path }));
  const byName = new Map(files.map(file => [file.path, file]));
  for (const name of ['index.html', 'style.css', 'guide.js', 'sources.json', 'sw.js']) {
    const expectedFile = byName.get(name);
    assert(expectedFile, `candidate_asset_missing:${name}`);
    const url = name === 'index.html' ? `https://airvio.co${PUBLIC_PREFIX}/`
      : `https://airvio.co${PUBLIC_PREFIX}/${name}`;
    const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
      credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) await response.body?.cancel();
    assert.equal(response.status, 200, `public_asset_status:${name}:${response.status}`);
    const bytes = await boundedBody(response, 80_000, `public_asset:${name}`);
    const row = { path: name, status: response.status, bytes: bytes.length, sha256: digest(bytes),
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
      csp: response.headers.get('content-security-policy'),
      nosniff: response.headers.get('x-content-type-options'),
      permissions: response.headers.get('permissions-policy'),
      referrer: response.headers.get('referrer-policy') };
    const type = name === 'index.html' ? /^text\/html(?:;|$)/u
      : name.endsWith('.css') ? /^text\/css(?:;|$)/u
        : name.endsWith('.js') ? /^(?:text|application)\/javascript(?:;|$)/u
          : /^application\/json(?:;|$)/u;
    assert.match(row.contentType ?? '', type, `asset_content_type_mismatch:${name}`);
    assert.match(row.cacheControl ?? '', /no-transform/u, `asset_cache_policy_missing:${name}`);
    assert.match(row.csp ?? '', /default-src 'none'/u, `asset_csp_missing:${name}`);
    assert.equal(row.nosniff, 'nosniff');
    assert.equal(row.permissions, 'camera=(), microphone=(), geolocation=(), payment=()');
    assert.equal(row.referrer, 'no-referrer');
    if (expectedFile.bytes !== undefined) {
      assert.equal(row.bytes, expectedFile.bytes, `asset_bytes_mismatch:${name}`);
      assert.equal(row.sha256, expectedFile.sha256, `asset_digest_mismatch:${name}`);
    }
    rows.push(row);
  }
  const slashless = await fetch(`https://airvio.co${PUBLIC_PREFIX}`, {
    method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  await slashless.body?.cancel();
  assert.equal(slashless.status, 308, 'slashless_route_redirect_missing');
  assert.equal(new URL(slashless.headers.get('location') ?? '', 'https://airvio.co').pathname, `${PUBLIC_PREFIX}/`);
  const unknown = await fetch(`https://airvio.co${PUBLIC_PREFIX}/unknown-file`, {
    redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  await unknown.body?.cancel();
  assert.equal(unknown.status, 404, 'unknown_storage_route_must_404');
  const method = await fetch(`https://airvio.co${PUBLIC_PREFIX}/`, {
    method: 'POST', body: 'read-only', redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  await method.body?.cancel();
  assert.equal([404, 405, 501].includes(method.status), true, 'storage_route_must_remain_read_only');
  return { assets: rows, slashlessStatus: slashless.status, unknownStatus: unknown.status,
    postStatus: method.status };
}

export async function captureState({ verifyPublic = true } = {}) {
  const accountId = ACCOUNT();
  assert.match(accountId, /^[a-f0-9]{32}$/u);
  const zoneState = await readZone();
  const [workerRows, routeRows, app] = await Promise.all([
    pagedRows(`/accounts/${accountId}/workers/workers`, null),
    pagedRows(`/zones/${zoneState.id}/workers/routes`, null), readReadiness(),
  ]);
  const workerMatches = workerRows.filter(row => row.name === WORKER || row.id === WORKER);
  const targetRoutes = routeRows.filter(row => ROUTES.includes(row.pattern)
    || String(row.pattern ?? '').startsWith('airvio.co/agentic-commerce-os/storage-management'))
    .map(routeShape).sort((a, b) => a.pattern.localeCompare(b.pattern) || String(a.id).localeCompare(String(b.id)));
  const appRoutes = routeRows.filter(row => row.pattern === APP_ROUTE).map(routeShape);
  assert.equal(appRoutes.length, 1, 'commerce_broad_route_not_unique');
  assert.equal(appRoutes[0].script, APP_WORKER, 'commerce_broad_route_worker_changed');
  assert.equal(workerMatches.length <= 1, true, 'static_worker_not_unique');
  const targetExists = targetRoutes.length === ROUTES.length && ROUTES.every(pattern =>
    targetRoutes.some(route => route.pattern === pattern && route.script === WORKER));
  assert.equal(targetRoutes.length === 0 || targetExists, true, 'storage_route_conflict');
  assert.equal((workerMatches.length === 1) === targetExists, true, 'static_worker_route_state_inconsistent');
  let worker = null;
  if (targetExists) {
    const deployment = await readDeployments();
    const script = workerMatches[0];
    assert.equal(script.observability?.enabled, false, 'static_worker_observability_must_be_disabled');
    worker = { name: WORKER, deployment, observabilityEnabled: false,
      hasAssets: script.has_assets === true, usageModel: script.usage_model ?? null };
    assert.equal(worker.hasAssets, true, 'static_worker_assets_missing');
  }
  const capacity = { workers: workerRows.length, maxWorkers: WORKER_LIMIT,
    routes: routeRows.length, maxRoutes: ROUTE_LIMIT };
  assert.equal(capacity.workers <= WORKER_LIMIT && capacity.routes <= ROUTE_LIMIT, true,
    'free_worker_or_route_capacity_exceeded');
  if (!targetExists) {
    assert.equal(capacity.workers < WORKER_LIMIT, true, 'no_free_worker_slot');
    assert.equal(capacity.routes + ROUTES.length <= ROUTE_LIMIT, true, 'no_free_route_slots');
  }
  const state = { schema: 'commerce.storage-management-provider-state/v1', accountId,
    zoneId: zoneState.id, zonePlan: zoneState.plan, capacity,
    commerceRoute: appRoutes[0], storageRoutes: targetRoutes, staticWorker: worker,
    application: applicationIdentity(app) };
  if (verifyPublic && targetExists) state.public = await readPublicAssets();
  return state;
}

export const stateDigest = state => digest(canonical(state));

function writeOnce(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const evidenceFile = (directory, name) => path.resolve(directory, name);

export async function captureBaseline(candidateSha, directory) {
  const candidate = verifyCandidate({ candidateSha });
  const before = await captureState();
  assert.equal(before.application.checkout, 'live');
  const baseline = { schema: 'commerce.storage-management-release-baseline/v1', candidateSha,
    candidateDigest: candidate.assetDigest, observedAt: new Date().toISOString(), state: before,
    stateDigest: stateDigest(before), releaseMode: before.storageRoutes.length === 0 ? 'bootstrap' : 'steady-state' };
  writeOnce(evidenceFile(directory, 'baseline.json'), baseline);
  return baseline;
}

export async function assertCurrentBaseline(directory) {
  const baseline = readJson(evidenceFile(directory, 'baseline.json'));
  const current = await captureState();
  assert.equal(stateDigest(current), baseline.stateDigest, 'provider_baseline_drift');
  return { baseline, current };
}

export async function authorizeRun(candidateSha, directory) {
  const baseline = readJson(evidenceFile(directory, 'baseline.json'));
  assert.equal(baseline.candidateSha, candidateSha);
  const env = process.env;
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_WORKFLOW, WORKFLOW);
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_SHA, candidateSha);
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
  assert.match(candidateSha, /^[a-f0-9]{40}$/u);
  const apiOrigin = env.GITHUB_API_URL ?? 'https://api.github.com';
  assert.equal(apiOrigin, 'https://api.github.com');
  const runId = Number(env.GITHUB_RUN_ID);
  assert(Number.isSafeInteger(runId) && runId > 0);
  const token = required('GH_TOKEN');
  const base = `${apiOrigin}/repos/${REPOSITORY}`;
  const [run, reviews, environment] = await Promise.all([
    fetchGitHubJson(`${base}/actions/runs/${runId}`, token),
    fetchGitHubJson(`${base}/actions/runs/${runId}/approvals`, token),
    fetchGitHubJson(`${base}/environments/production`, token),
  ]);
  assert.equal(run.id, runId);
  assert.equal(run.name, WORKFLOW);
  assert.equal(run.path, WORKFLOW_PATH);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, candidateSha);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.repository?.full_name, REPOSITORY);
  const actors = [run.actor, run.triggering_actor];
  for (const actor of actors) {
    assert.equal(actor?.type, 'User', 'workflow_dispatch_actor_must_be_human');
    assert.match(actor?.login ?? '', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u);
    assert.equal(actor.login.toLowerCase().endsWith('[bot]'), false);
    assert(Number.isSafeInteger(actor.id) && actor.id > 0);
  }
  assert.equal(actors[0].id, actors[1].id, 'workflow_dispatch_actor_changed');
  const approval = validateHumanAuthorization(reviews, environment, {
    releaseMode: baseline.releaseMode, candidateSha, runId, runAttempt: 1,
    // GitHub production allows the configured owner reviewer to approve their own dispatch.
    allowOwnerSelfReview: true,
  });
  const receipt = { schema: 'commerce.storage-management-production-authorization/v1',
    repository: REPOSITORY, workflow: WORKFLOW_PATH, candidateSha, candidateDigest: baseline.candidateDigest,
    runId, releaseMode: baseline.releaseMode, baselineDigest: baseline.stateDigest, approval };
  writeOnce(evidenceFile(directory, 'authorization.json'), receipt);
  return receipt;
}

export async function verifyDeployment(candidateSha, directory, message) {
  const baseline = readJson(evidenceFile(directory, 'baseline.json'));
  const authorization = readJson(evidenceFile(directory, 'authorization.json'));
  const candidate = verifyCandidate({ candidateSha });
  assert.equal(baseline.candidateSha, candidateSha);
  assert.equal(authorization.candidateSha, candidateSha);
  assert.equal(authorization.candidateDigest, candidate.assetDigest);
  const current = await captureState({ verifyPublic: false });
  assert.equal(current.storageRoutes.length, ROUTES.length);
  assert.deepEqual(current.storageRoutes.map(route => route.pattern).sort(), [...ROUTES].sort());
  assert.equal(current.storageRoutes.every(route => route.script === WORKER), true);
  if (baseline.releaseMode === 'steady-state')
    assert.deepEqual(current.storageRoutes, baseline.state.storageRoutes, 'storage_route_identity_changed');
  else assert.equal(baseline.state.storageRoutes.length, 0, 'bootstrap_route_baseline_not_empty');
  assert.equal(current.staticWorker?.deployment.message, message, 'static_worker_candidate_message_mismatch');
  assert.equal(current.staticWorker?.observabilityEnabled, false);
  assert.equal(current.staticWorker?.hasAssets, true);
  assert.notEqual(current.staticWorker?.deployment.versionId, baseline.state.staticWorker?.deployment.versionId ?? null);
  assert.equal(canonical(current.commerceRoute), canonical(baseline.state.commerceRoute), 'commerce_route_changed');
  assert.equal(canonical(current.application), canonical(baseline.state.application), 'commerce_live_identity_changed');
  const readback = await readPublicAssets(candidate);
  const finalState = await captureState({ verifyPublic: false });
  assert.equal(finalState.staticWorker.deployment.versionId, current.staticWorker.deployment.versionId,
    'static_worker_changed_during_readback');
  assert.deepEqual(finalState.commerceRoute, baseline.state.commerceRoute, 'commerce_route_changed_after_readback');
  assert.deepEqual(finalState.storageRoutes, current.storageRoutes, 'storage_routes_changed_during_readback');
  assert.equal(canonical(finalState.application), canonical(baseline.state.application), 'commerce_live_identity_changed_after_readback');
  return { candidate, baseline, authorization, production: finalState, readback };
}

async function main() {
  const [command, candidateSha, directory = 'node_modules/.cache/storage-management-evidence', ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  if (command === 'preflight') return captureBaseline(candidateSha, directory);
  if (command === 'authorize') return authorizeRun(candidateSha, directory);
  if (command === 'verify-baseline') return assertCurrentBaseline(directory);
  throw new Error('usage: provider.mjs preflight|authorize|verify-baseline <candidate-sha> [evidence-dir]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(value => {
  if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
