import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LIVE_CHECKOUT_PROFILE, LIVE_CHECKOUT_PROFILE_SHA256 } from '../../src/local-first/checkout-offer.ts';
import { checkoutConfigured } from '../../src/local-first/checkout.ts';
import { stripeClient, stripeTestKey } from '../../src/local-first/stripe-checkout.ts';
import { readBoundedJsonResponse } from '../production-release/bounded-response.ts';
import { fetchGitHubJson, validateHumanAuthorization } from '../production-release/human-authorization.ts';
import { parseWebhookProvisioning, verifyWebhookProvisioning, LIVE_WEBHOOK_URL } from './stripe-provision.mjs';

export const LIVE_COMPLETION_SCHEMA = 'commerce.local-first-live-completion/v1';
export { LIVE_WEBHOOK_URL } from './stripe-provision.mjs';
const REPOSITORY = 'huijoohwee/agentic-commerce-os';
const hash = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
export function parseLiveReader(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  exact(value,['sourceRevision','versionId','runId','receiptDigest']);
  assert.match(value.sourceRevision,/^[a-f0-9]{40}$/u);
  assert.match(value.versionId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  assert(Number.isSafeInteger(value.runId) && value.runId > 0);
  assert.match(value.receiptDigest,/^[a-f0-9]{64}$/u);
  return Object.freeze({...value});
}
/** Selection is explicit workflow input, never inferred from credentials. */
export function readCheckoutRelease(env = process.env) {
  const checkout = env.LOCAL_FIRST_CHECKOUT || 'sandbox';
  assert(['sandbox','live-reader','live'].includes(checkout),'Invalid checkout release selection');
  const rawReader = env.LOCAL_FIRST_LIVE_READER_JSON, webhookId = env.LOCAL_FIRST_LIVE_WEBHOOK_ID;
  const rawProvisioning = env.LOCAL_FIRST_WEBHOOK_PROVISIONING_JSON;
  if (checkout === 'sandbox') {
    assert(!rawReader && !webhookId && !rawProvisioning,'Sandbox release cannot adopt live authority');
    return Object.freeze({checkout});
  }
  assert.match(webhookId ?? '',/^we_[A-Za-z0-9]{12,200}$/u,'Exact live webhook destination required');
  assert(rawProvisioning,'Controlled webhook provisioning receipt required');
  const webhookProvisioning = parseWebhookProvisioning(rawProvisioning);
  assert.equal(webhookProvisioning.endpointId,webhookId,'Provisioned webhook destination mismatch');
  const reader = rawReader ? parseLiveReader(rawReader) : null;
  assert(checkout !== 'live' || reader,'Live activation requires its retained live-reader');
  return Object.freeze({checkout,profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,webhookId,reader,webhookProvisioning});
}
export function liveAuthorizationScope(selection) {
  // Roundtrip through the closed input parser prevents unchecked caller fields.
  const checked = readCheckoutRelease({LOCAL_FIRST_CHECKOUT:selection.checkout,
    LOCAL_FIRST_LIVE_WEBHOOK_ID:selection.webhookId,
    LOCAL_FIRST_WEBHOOK_PROVISIONING_JSON:selection.webhookProvisioning ? JSON.stringify(selection.webhookProvisioning) : '',
    LOCAL_FIRST_LIVE_READER_JSON:selection.reader ? JSON.stringify(selection.reader) : ''});
  if (checked.checkout === 'sandbox') return null;
  assert.equal(selection.profileDigest,LIVE_CHECKOUT_PROFILE_SHA256,'Live profile mismatch');
  return {profileDigest:checked.profileDigest,webhookId:checked.webhookId,
    provisioningDigest:hash(JSON.stringify(checked.webhookProvisioning)),
    readerDigest:checked.reader ? hash(JSON.stringify(checked.reader)) : null};
}
export function liveSecretFingerprint(env) {
  const names = ['STOREFRONT_SESSION_SECRET','STRIPE_TEST_SECRET_KEY','STRIPE_LIVE_SECRET_KEY','STRIPE_LIVE_WEBHOOK_SECRET','CHECKOUT_RECOVERY_SECRET'];
  assert(checkoutConfigured({...env,CHECKOUT_MODE:'live',CHECKOUT_LIVE_PROFILE_SHA256:LIVE_CHECKOUT_PROFILE_SHA256}),
    'Distinct retained live credentials required');
  assert(stripeTestKey(env.STRIPE_TEST_SECRET_KEY),'Retained sandbox key required');
  if (env.LISTING_HOST_BEARER) {
    assert(env.LISTING_HOST_BEARER.length >= 32 && !names.some(name => env[name] === env.LISTING_HOST_BEARER),
      'Independent retained host bearer required');
    names.push('LISTING_HOST_BEARER');
  }
  assert.equal(new Set(names.map(name => env[name])).size,names.length,'Every retained secret must have a separate purpose');
  return hash(JSON.stringify({purpose:'commerce.live-secret-set/v1',secrets:names.map(name => [name,env[name]])}));
}
export function validateLiveReaderCompletion(value, reader, {secretSetDigest,webhookId,provisioningDigest}) {
  const {receiptDigest,...body} = value;
  assert.equal(hash(JSON.stringify(body)),receiptDigest,'Reader completion content digest mismatch');
  assert.equal(receiptDigest,reader.receiptDigest,'Selected reader receipt mismatch');
  assert(value.schema === LIVE_COMPLETION_SCHEMA && value.status === 'production-complete'
    && value.profile === 'local-first' && value.checkout === 'live-reader'
    && value.sourceRevision === reader.sourceRevision && value.runId === reader.runId
    && value.worker === 'agentic-commerce-edge-production'
    && value.deployment?.versionId === reader.versionId,'Exact live-reader completion required');
  assert.match(value.artifactDigest ?? '',/^[a-f0-9]{64}$/u);
  assert.match(value.browserProofDigest ?? '',/^[a-f0-9]{64}$/u);
  assert(value.livePrerequisites?.profileDigest === LIVE_CHECKOUT_PROFILE_SHA256
    && value.livePrerequisites.checkout === 'live-reader' && value.livePrerequisites.webhookId === webhookId
    && /^[a-f0-9]{64}$/u.test(provisioningDigest ?? '') && value.livePrerequisites.provisioningDigest === provisioningDigest
    && value.livePrerequisites.secretSetDigest === secretSetDigest,'Retained reader cannot change live profile or secret set');
  return value;
}
function validateReaderRun(reader,run,jobs,reviews,environment) {
  const owner = run.repository?.owner;
  assert(run.id === reader.runId && run.head_sha === reader.sourceRevision && run.run_attempt === 1
    && run.status === 'completed' && run.conclusion === 'success' && run.head_branch === 'main'
    && run.event === 'workflow_dispatch' && run.name === 'Local-first Production Release'
    && run.path === '.github/workflows/local-first-release.yml'
    && run.repository.full_name === REPOSITORY && owner?.login === 'huijoohwee'
    && owner.type === 'User' && Number.isSafeInteger(owner.id) && owner.id > 0,'Reader run provenance mismatch');
  for (const actor of [run.actor,run.triggering_actor])
    assert(actor?.type === 'User' && actor.id === owner.id && actor.login === owner.login,'Reader owner mismatch');
  const release = jobs.jobs.filter(job => job.name === 'Authorized Local-first Production Release');
  assert(release.length === 1 && release[0].conclusion === 'success','Reader release job incomplete');
  for (const name of ['Verify scoped owner policy and actual run approval',
    'Deploy the reviewed checkout profile and verify the exact public release']) {
    const steps = release[0].steps?.filter(step => step.name === name);
    assert(steps?.length === 1 && steps[0].conclusion === 'success','Reader live-profile step did not succeed');
  }
  const approval = validateHumanAuthorization(reviews,environment,{releaseMode:'steady-state',candidateSha:reader.sourceRevision,
    runId:reader.runId,runAttempt:1,allowOwnerSelfReview:true});
  assert.equal(approval.approver.id,owner.id,'Reader approval must belong to owner');
}
/** Only reads live provider/account/price/webhook and authenticated retained evidence. */
export async function verifyLiveReleasePrerequisites(selection,{env,provider,routeAuthority,evidenceDir,
  github = fetchGitHubJson, transport = fetch} = {}) {
  const scope = liveAuthorizationScope(selection);if (!scope) return null;
  assert.equal(routeAuthority.mode,'steady-state','Live profile requires the existing reviewed route');
  const secretSetDigest = liveSecretFingerprint(env);
  const provisioning = verifyWebhookProvisioning(selection.webhookProvisioning,{
    stripeLiveKey:env.STRIPE_LIVE_SECRET_KEY,webhookSecret:env.STRIPE_LIVE_WEBHOOK_SECRET});
  const offer = await stripeClient(env.STRIPE_LIVE_SECRET_KEY,transport,'live').verifyOffer(selection.checkout === 'live');
  const endpointUrl = 'https://api.stripe.com/v1/webhook_endpoints/' + selection.webhookId;
  const response = await transport(new Request(endpointUrl,{headers:{authorization:'Bearer '+env.STRIPE_LIVE_SECRET_KEY,
    'stripe-version':LIVE_CHECKOUT_PROFILE.webhookApiVersion},redirect:'error',signal:AbortSignal.timeout(15000)}));
  const endpoint = await readBoundedJsonResponse(response,65536);
  assert(response.ok && endpoint.id === selection.webhookId && endpoint.livemode === true
    && endpoint.status === 'enabled' && endpoint.url === LIVE_WEBHOOK_URL
    && endpoint.api_version === LIVE_CHECKOUT_PROFILE.webhookApiVersion
    && endpoint.metadata?.owner === 'agentic-commerce-os' && endpoint.metadata.operation_id === provisioning.operationId
    && endpoint.metadata.profile_digest === LIVE_CHECKOUT_PROFILE_SHA256 && endpoint.metadata.source_revision === provisioning.sourceRevision
    && JSON.stringify([...endpoint.enabled_events ?? []].sort()) === JSON.stringify(
      ['checkout.session.async_payment_succeeded','checkout.session.completed']), 'Exact live webhook readback required');
  const active = await provider.active();assert(active,'Live release requires an existing deployment');
  const current = await provider.version(active.versionId);
  if (['live','live-reader'].includes(current.checkout)) {
    assert.equal(current.secretSetDigest,secretSetDigest,'Active buyer recovery secrets changed');
    assert.equal(current.profileDigest,LIVE_CHECKOUT_PROFILE_SHA256,'Active paid edition changed');
  }
  let readerProof = null;
  if (selection.reader) {
    const reader = selection.reader, root = `https://api.github.com/repos/${REPOSITORY}`;
    const [run,jobs,reviews,environment] = await Promise.all([
      github(`${root}/actions/runs/${reader.runId}`,env.GH_TOKEN),
      github(`${root}/actions/runs/${reader.runId}/jobs`,env.GH_TOKEN),
      github(`${root}/actions/runs/${reader.runId}/approvals`,env.GH_TOKEN),
      github(`${root}/environments/production`,env.GH_TOKEN)]);
    validateReaderRun(reader,run,jobs,reviews,environment);
    // The protected workflow downloads this exact run's named artifact with
    // actions/download-artifact. Do not accept a caller-supplied local receipt.
    assert(env.GITHUB_ACTIONS === 'true','Authenticated Actions reader artifact required');
    const file = path.join(evidenceDir,'retained-live-reader','completion.json'), stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 65536,'Invalid reader completion file');
    validateLiveReaderCompletion(JSON.parse(fs.readFileSync(file,'utf8')),reader,
      {secretSetDigest,webhookId:selection.webhookId,provisioningDigest:scope.provisioningDigest});
    const version = await provider.version(reader.versionId,reader.sourceRevision,'live-reader',undefined,secretSetDigest);
    if (selection.checkout === 'live') assert.equal(active.versionId,reader.versionId,'Activate the verified no-new-sales reader before live');
    readerProof = {reader,version,receiptDigest:reader.receiptDigest};
  }
  return {schema:'commerce.live-release-prerequisites/v1',checkout:selection.checkout,profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,
    webhookId:selection.webhookId,provisioningDigest:scope.provisioningDigest,secretSetDigest,offer,readerProof,verifiedAt:new Date().toISOString()};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2),['preflight']);
  const selection = readCheckoutRelease();
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `checkout=${selection.checkout}\nreader_run_id=${selection.reader?.runId ?? ''}\n`);
  console.log(JSON.stringify({checkout:selection.checkout,readerRunId:selection.reader?.runId ?? null,
    profileDigest:selection.profileDigest ?? null}));
}
