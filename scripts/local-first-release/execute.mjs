import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORKER, sourceManifest, assertCleanCandidate, git, digest } from './artifact.mjs';
import { createProvider } from './provider.mjs';
import { parseLocalFirstAuthorization } from './authorization.mjs';
import { parseProductionRouteAuthority } from '../production-release/route-authority.ts';
import { observeBefore, deployLocalFirst } from './deployment.mjs';
import { verifyRetainedBaseline } from './retained-baseline.mjs';
import { assertBrowserProof } from './browser-proof.mjs';

const env = process.env, revision = env.CANDIDATE_SHA, runId = Number(env.GITHUB_RUN_ID);
if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'huijoohwee/agentic-commerce-os'
  || env.GITHUB_WORKFLOW !== 'Local-first Production Release' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_SHA !== revision || env.GITHUB_RUN_ATTEMPT !== '1'
  || !Number.isSafeInteger(runId) || runId <= 0) throw Error('Protected first-attempt release context required');
const output = path.resolve(env.LOCAL_FIRST_EVIDENCE_DIR || 'node_modules/.cache/local-first-verification');
const read = file => JSON.parse(fs.readFileSync(path.join(output, file), 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + '\n');
const checkMain = () => {
  assertCleanCandidate(revision);
  if (git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0] !== revision) throw Error('Protected main advanced');
};
checkMain();
const artifact = sourceManifest(revision);
if (JSON.stringify(read('artifact.json')) !== JSON.stringify(artifact)) throw Error('Prepared artifact changed');
assertBrowserProof(read('browser-proof.json'), revision);
const routeAuthority = parseProductionRouteAuthority(JSON.parse(env.PRODUCTION_ROUTE_AUTHORITY_JSON || '{}'));
const mode = routeAuthority.mode;
const authorization = parseLocalFirstAuthorization(read('human-authorization.json'), {
  candidateSha: revision, runId, runAttempt: 1, releaseMode: mode, artifactDigest: artifact.artifactDigest,
});
const provider = createProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID, zoneId: routeAuthority.zoneId,
  token: env.CLOUDFLARE_API_TOKEN });
const retainedBaseline = await verifyRetainedBaseline(env.LOCAL_FIRST_RETAINED_BASELINE, env.GH_TOKEN);
if (JSON.stringify(read('retained-baseline.json')) !== JSON.stringify(retainedBaseline)) throw Error('Retained baseline changed after preparation');
const before = await observeBefore(provider, routeAuthority, retainedBaseline);
const plan = { schema: 'commerce.local-first-release-plan/v1', sourceRevision: revision,
  artifactDigest: artifact.artifactDigest, runId, profile: 'local-first', checkout: 'deferred',
  before, retainedBaseline, routeAuthority, authorization, createdAt: new Date().toISOString() };
write('plan.json', plan);
const journal = { schema: 'commerce.local-first-release-journal/v1', planDigest: digest(JSON.stringify(plan)),
  stage: 'prepared', outcome: 'pending', active: null, route: null };
const record = stage => { journal.stage = stage; write('journal.json', journal); };
function wrangler(args) {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    stdio: 'inherit', timeout: 180000, env: { ...env, CI: 'true' },
  });
}
const verifyLive = async active => {
  execFileSync(process.execPath, ['scripts/local-first-release/check.mjs', '--base-url=https://airvio.co'], {
    stdio: 'inherit', timeout: 180000, env: { ...env, LOCAL_FIRST_EVIDENCE_DIR: path.join(output, 'live'),
      LOCAL_FIRST_EXPECTED_VERSION: active.versionId },
  });
  const ready = await fetch('https://airvio.co/agentic-commerce-os/readyz', { signal: AbortSignal.timeout(20000) });
  const identity = await ready.json();
  if (!ready.ok || identity.sourceRevision !== revision || identity.workerVersionId !== active.versionId) {
    throw Error('Live source/version identity mismatch');
  }
};
await deployLocalFirst({ provider, routeAuthority, before, journal, revision, checkMain, record, wrangler, verifyLive });
journal.outcome = 'production-complete'; record('complete');
const body = { schema: 'commerce.local-first-production-completion/v1', status: 'production-complete',
  profile: 'local-first', checkout: 'deferred', sourceRevision: revision, artifactDigest: artifact.artifactDigest,
  runId, worker: WORKER, deployment: journal.active, route: journal.route,
  completedAt: new Date().toISOString(), browserProofDigest: digest(fs.readFileSync(path.join(output, 'live/browser-proof.json'))) };
write('completion.json', { ...body, receiptDigest: digest(JSON.stringify(body)) });
console.log(JSON.stringify({ status: body.status, sourceRevision: revision, profile: body.profile, checkout: body.checkout }));
