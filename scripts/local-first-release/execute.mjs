import os from 'node:os';
import { stripeTestKey } from '../../src/local-first/stripe-checkout.ts';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORKER, sourceManifest, assertCleanCandidate, git, digest } from './artifact.mjs';
import { createProvider } from './provider.mjs';
import { parseLocalFirstAuthorization } from './authorization.mjs';
import { parseProductionRouteAuthority } from '../production-release/route-authority.ts';
import { observeBefore, deployLocalFirst, rehearseLocalFirstRollback, selectFailureRecovery } from './deployment.mjs';
import { verifyRetainedBaseline } from './retained-baseline.mjs';
import { assertBrowserProof, assertLiveBrowserProof } from './browser-proof.mjs';
import { LIVE_CHECKOUT_PROFILE_SHA256 } from '../../src/local-first/checkout-offer.ts';
import { readCheckoutRelease, verifyLiveReleasePrerequisites, LIVE_COMPLETION_SCHEMA } from './live-profile.mjs';
import { readFulfillmentRelease, verifyFulfillmentRelease } from './fulfillment.mjs';
import { requireRollbackRehearsal, assertFulfillmentRollbackProof, waitForReadiness } from './readiness.mjs';
import { readJsonResponse } from '../../src/shared/http.ts';

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
const selection = readCheckoutRelease(), live = selection.checkout !== 'sandbox';
const artifact = sourceManifest(revision,selection);
if (JSON.stringify(read('artifact.json')) !== JSON.stringify(artifact)) throw Error('Prepared artifact changed');
if (live) assertLiveBrowserProof(read('browser-proof.json'),revision,{checkout:selection.checkout,
  profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,scope:'local-fixture'});
else assertBrowserProof(read('browser-proof.json'), revision);
const routeAuthority = parseProductionRouteAuthority(JSON.parse(env.PRODUCTION_ROUTE_AUTHORITY_JSON || '{}'));
const mode = routeAuthority.mode;
const authorization = parseLocalFirstAuthorization(read('human-authorization.json'), {
  candidateSha: revision, runId, runAttempt: 1, releaseMode: mode, artifactDigest: artifact.artifactDigest,
  selection,
});
const provider = createProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID, zoneId: routeAuthority.zoneId,
  token: env.CLOUDFLARE_API_TOKEN });
const retainedBaseline = await verifyRetainedBaseline(env.LOCAL_FIRST_RETAINED_BASELINE, env.GH_TOKEN);
if (JSON.stringify(read('retained-baseline.json')) !== JSON.stringify(retainedBaseline)) throw Error('Retained baseline changed after preparation');
const before = await observeBefore(provider, routeAuthority, retainedBaseline);
const predecessor = before.active ? await provider.version(before.active.versionId) : null;
if (!live && predecessor?.checkout)
  throw Error('A sandbox release cannot replace an existing live buyer reader');
const fulfillment = readFulfillmentRelease();
const rehearsal = live ? false : requireRollbackRehearsal(env.LOCAL_FIRST_ROLLBACK_REHEARSAL, fulfillment);
const verifyHost = (rendezvous = null) => verifyFulfillmentRelease(fulfillment, { provider, routeAuthority,
  token: env.GH_TOKEN, bearer: env.LISTING_HOST_BEARER, rendezvous });
// Only the first approved sandbox host transition may wait for the operator's
// exact pinned host. All live and post-deployment checks remain single attempts.
const hostTransition = selectFailureRecovery({ checkout: selection.checkout, mode, predecessor, fulfillment });
const fulfillmentProof = await verifyHost(hostTransition ? { previousPins: hostTransition.previousPins,
  observe: evidence => write('host-rendezvous.json', evidence) } : null);
const failureRecovery = selectFailureRecovery({ checkout: selection.checkout, mode, predecessor,
  fulfillment: fulfillmentProof?.config ?? null });
const livePrerequisites = live ? await verifyLiveReleasePrerequisites(selection,{env,provider,routeAuthority,evidenceDir:output}) : null;
const plan = { schema: live ? 'commerce.local-first-live-release-plan/v1' : 'commerce.local-first-release-plan/v2', sourceRevision: revision,
  artifactDigest: artifact.artifactDigest, runId, profile: 'local-first', checkout: selection.checkout,
  before, retainedBaseline, routeAuthority, authorization, fulfillmentProof,
  ...(failureRecovery ? { failureRecovery } : {}),
  ...(live ? {livePrerequisites} : {}), createdAt: new Date().toISOString() };
write('plan.json', plan);
const journal = { schema: 'commerce.local-first-release-journal/v1', planDigest: digest(JSON.stringify(plan)),
  stage: 'prepared', outcome: 'pending', active: null, route: null,
  ...(failureRecovery ? { failureRecovery } : {}) };
const record = stage => { journal.stage = stage; write('journal.json', journal); };
function wrangler(args) {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    stdio: 'inherit', timeout: 180000, env: { ...env, CI: 'true' },
  });
}
const verifyFailureReader = failureRecovery ? async active => {
  const evidence = { ...failureRecovery, deployment: active, verified: false, observations: [] };
  try {
    if (active.versionId !== failureRecovery.reader.versionId) throw Error('Failure reader version mismatch');
    evidence.identity = await waitForReadiness({ url: 'https://airvio.co/agentic-commerce-os/readyz',
      revision: failureRecovery.reader.sourceRevision, versionId: active.versionId, checkout: 'sandbox',
      observe: observation => evidence.observations.push(observation) });
    evidence.verified = true;
  } catch (error) { evidence.error = error.message; throw error; }
  finally { write('failure-reader-readiness.json', evidence); }
} : undefined;
const verifyLive = async active => {
  execFileSync(process.execPath, ['scripts/local-first-release/check.mjs', '--base-url=https://airvio.co'], {
    stdio: 'inherit', timeout: 180000, env: { ...env, LOCAL_FIRST_EVIDENCE_DIR: path.join(output, 'live'),
      LOCAL_FIRST_EXPECTED_VERSION: active.versionId,
      ...(live && predecessor ? {LOCAL_FIRST_PREVIOUS_READINESS_JSON:JSON.stringify({
        sourceRevision:predecessor.sourceRevision,workerVersionId:before.active.versionId,
        checkout:predecessor.checkout ?? 'sandbox'})} : {}) },
  });
  if (live) assertLiveBrowserProof(JSON.parse(fs.readFileSync(path.join(output,'live/browser-proof.json'),'utf8')),
    revision,{checkout:selection.checkout,profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,scope:'live-read-only'});
  const ready = await fetch('https://airvio.co/agentic-commerce-os/readyz', { signal: AbortSignal.timeout(20000) });
  const identity = await ready.json();
  if (!ready.ok || identity.sourceRevision !== revision || identity.workerVersionId !== active.versionId
    || identity.checkout !== selection.checkout) {
    throw Error('Live source/version identity mismatch');
  }
  if (fulfillment) {
    await verifyHost();
    const response = await fetch('https://airvio.co/agentic-commerce-os/fulfillment/session', {
      redirect: 'error', signal: AbortSignal.timeout(20000) });
    const session = await readJsonResponse(response, 4096);
    write('fulfillment-session-observation.json', { sourceRevision: revision, versionId: active.versionId,
      status: response.status, ok: session.ok === true, code: typeof session.code === 'string' ? session.code.slice(0, 120) : null,
      csrfPresent: typeof session.csrfToken === 'string', cookiePresent: response.headers.has('set-cookie'),
      observedAt: new Date().toISOString() });
    if (response.status !== 200 || session.ok !== true || typeof session.csrfToken !== 'string'
      || !response.headers.get('set-cookie')?.startsWith('__Host-airvio_sandbox=')) throw Error('Public fulfillment admission unavailable');
    write('fulfillment-readiness.json', { sourceRevision: revision, versionId: active.versionId,
      host: fulfillmentProof.host, publicSessionVerified: true, verifiedAt: new Date().toISOString() });
  }
};
if (typeof env.STOREFRONT_SESSION_SECRET !== 'string' || env.STOREFRONT_SESSION_SECRET.length < 32) throw Error('Checkout session signing secret required');
if (!stripeTestKey(env.STRIPE_TEST_SECRET_KEY)) throw Error('Retained Stripe test key required');
const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-checkout-release-'));
const secretsFile = path.join(secretDir, 'secrets.json');
try {
  if (fulfillment && [env.STOREFRONT_SESSION_SECRET, env.STRIPE_TEST_SECRET_KEY,env.STRIPE_LIVE_SECRET_KEY,
    env.STRIPE_LIVE_WEBHOOK_SECRET,env.CHECKOUT_RECOVERY_SECRET].includes(env.LISTING_HOST_BEARER)) throw Error('Listing credentials must be independent');
  fs.writeFileSync(secretsFile, JSON.stringify({ STOREFRONT_SESSION_SECRET: env.STOREFRONT_SESSION_SECRET,
    STRIPE_TEST_SECRET_KEY: env.STRIPE_TEST_SECRET_KEY,
    ...(live ? {STRIPE_LIVE_SECRET_KEY:env.STRIPE_LIVE_SECRET_KEY,STRIPE_LIVE_WEBHOOK_SECRET:env.STRIPE_LIVE_WEBHOOK_SECRET,
      CHECKOUT_RECOVERY_SECRET:env.CHECKOUT_RECOVERY_SECRET} : {}),
    ...(fulfillment ? { LISTING_HOST_BEARER: env.LISTING_HOST_BEARER } : {}) }), { mode: 0o600, flag: 'wx' });
  await deployLocalFirst({ provider, routeAuthority, before, journal, revision, checkMain, record, wrangler, verifyLive, secretsFile, fulfillment,
    checkout:selection.checkout,secretSetDigest:livePrerequisites?.secretSetDigest, failureRecovery, verifyFailureReader });
} finally { fs.rmSync(secretDir, { recursive: true }); }
if (rehearsal) {
  const { createRollbackBrowserObservation } = await import('./rollback-browser.mjs');
  const observation = await createRollbackBrowserObservation({ output });
  try {
    const proof = await rehearseLocalFirstRollback({ provider, routeAuthority, candidate: journal.active,
      reader: fulfillment.reader, revision, pins: fulfillment.pins, checkMain, record, wrangler, observation, journal });
    journal.active = proof.restoredDeployment;
    assertFulfillmentRollbackProof(proof, { revision, active: journal.active, reader: fulfillment.reader });
    write('fulfillment-rollback-proof.json', proof);
    await verifyLive(journal.active);
  } catch (error) {
    journal.outcome = 'preserve-required'; journal.error = error.message; record('rollback-rehearsal-failed'); throw error;
  } finally { await observation.close(); }
}
journal.outcome = 'production-complete'; record('complete');
const body = { schema: live ? LIVE_COMPLETION_SCHEMA : 'commerce.local-first-production-completion/v3', status: 'production-complete',
  profile: 'local-first', checkout: selection.checkout, sourceRevision: revision, artifactDigest: artifact.artifactDigest,
  runId, worker: WORKER, deployment: journal.active, route: journal.route, fulfillment: fulfillmentProof,
  ...(live ? {livePrerequisites} : {}),
  rollbackProofDigest: rehearsal ? digest(fs.readFileSync(path.join(output, 'fulfillment-rollback-proof.json'))) : null,
  completedAt: new Date().toISOString(), browserProofDigest: digest(fs.readFileSync(path.join(output, 'live/browser-proof.json'))) };
write('completion.json', { ...body, receiptDigest: digest(JSON.stringify(body)) });
console.log(JSON.stringify({ status: body.status, sourceRevision: revision, profile: body.profile, checkout: body.checkout }));
