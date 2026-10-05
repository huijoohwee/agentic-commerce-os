import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stripeClient, stripeLiveKey } from '../../src/local-first/stripe-checkout.ts';
import { LIVE_CHECKOUT_PROFILE, LIVE_CHECKOUT_PROFILE_SHA256 } from '../../src/local-first/checkout-offer.ts';
import { readBoundedJsonResponse } from '../production-release/bounded-response.ts';

const SCHEMA = 'commerce.stripe-webhook-operator-provisioning/v1';
const SOURCE_ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const LIVE_WEBHOOK_URL = 'https://airvio.co/agentic-commerce-os/checkout/webhook';
const EVENTS = ['checkout.session.async_payment_succeeded','checkout.session.completed'];
const sha = value => createHash('sha256').update(value).digest('hex');
const whsec = value => typeof value === 'string' && /^whsec_[A-Za-z0-9]{20,}$/u.test(value);
const equal = (left,right) => /^[a-f0-9]{64}$/u.test(left ?? '') && /^[a-f0-9]{64}$/u.test(right ?? '')
  && timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
function bodyOf(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value),'Invalid operator provisioning receipt');
  const keys=['schema','sourceRevision','operationId','account','endpointId','url','apiVersion','events','profileDigest','secretDigest','createdAt','authentication'];
  assert.deepEqual(Object.keys(value).sort(),keys.sort(),'Invalid operator provisioning receipt shape');
  assert(value.schema === SCHEMA && value.account === LIVE_CHECKOUT_PROFILE.account
    && value.url === LIVE_WEBHOOK_URL && value.apiVersion === LIVE_CHECKOUT_PROFILE.webhookApiVersion
    && value.profileDigest === LIVE_CHECKOUT_PROFILE_SHA256
    && JSON.stringify(value.events) === JSON.stringify(EVENTS),'Provisioning receipt profile mismatch');
  assert.match(value.operationId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  assert.match(value.sourceRevision,/^[a-f0-9]{40}$/u);
  assert.match(value.endpointId,/^we_[A-Za-z0-9]{12,200}$/u);
  assert.match(value.secretDigest,/^[a-f0-9]{64}$/u);assert.match(value.authentication,/^[a-f0-9]{64}$/u);
  assert(typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && new Date(value.createdAt).toISOString() === value.createdAt,'Invalid provisioning timestamp');
  return {schema:SCHEMA,sourceRevision:value.sourceRevision,operationId:value.operationId,account:value.account,endpointId:value.endpointId,url:value.url,
    apiVersion:value.apiVersion,events:[...EVENTS],profileDigest:value.profileDigest,secretDigest:value.secretDigest,createdAt:value.createdAt};
}
export function parseWebhookProvisioning(value) {
  if (typeof value === 'string') {assert(Buffer.byteLength(value) <= 8192,'Provisioning receipt too large');value=JSON.parse(value);}
  return Object.freeze({...bodyOf(value),authentication:value.authentication});
}
/** Authenticates controlled-operator evidence, not a Stripe cryptographic attestation. */
export function verifyWebhookProvisioning(value,{stripeLiveKey:key,webhookSecret}) {
  const receipt=parseWebhookProvisioning(value),body=bodyOf(receipt);
  assert(stripeLiveKey(key) && whsec(webhookSecret),'Live provisioning credentials required');
  const authentication=createHmac('sha256',key).update(SCHEMA+'\n'+JSON.stringify(body)).digest('hex');
  assert(equal(receipt.authentication,authentication) && equal(receipt.secretDigest,sha(webhookSecret)),
    'Configured webhook secret does not match authenticated provisioning');
  return receipt;
}
function privateConfig(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd);
    assert(stat.isFile() && stat.size > 0 && stat.size <= 8192 && (stat.mode & 0o077) === 0
      && (!process.getuid || stat.uid === process.getuid()),'Private operator configuration required');
    const value=JSON.parse(fs.readFileSync(fd,'utf8'));
    assert(Object.keys(value).join() === 'stripeLiveKey' && stripeLiveKey(value.stripeLiveKey),
      'Configuration accepts only the approved live API key');
    return value.stripeLiveKey;
  } finally {fs.closeSync(fd);}
}
function writeJson(file,value,{exclusive=false,mode=0o600}={}) {
  const fd=fs.openSync(file,(exclusive ? fs.constants.O_CREAT|fs.constants.O_EXCL : fs.constants.O_TRUNC)
    |fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,mode);
  try {fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
async function boundedStripeFetch(request) {
  const deadline=new AbortController(),signal=AbortSignal.any([request.signal,deadline.signal]);
  let cancel=()=>{},response;
  const stopped=new Promise((_,reject)=>{cancel=()=>reject(Error('stripe_provision_transport_unavailable'));});
  const timer=setTimeout(()=>{deadline.abort();cancel();},15000);
  try {
    return await Promise.race([(async()=>{
      response=await fetch(new Request(request,{signal,redirect:'error'}));
      assert(!response.redirected && response.url === request.url
        && /^application\/json(?:;|$)/u.test(response.headers.get('content-type') ?? ''),'Invalid Stripe response identity');
      const value=await readBoundedJsonResponse(response,65536);
      return Response.json(value,{status:response.status});
    })(),stopped]);
  } finally {clearTimeout(timer);deadline.abort();void response?.body?.cancel().catch(()=>{});}
}
/** One controlled create. There is intentionally no API that signs an entered whsec. */
export async function provisionStripeWebhook({configPath,outputDirectory}) {
  const key=privateConfig(configPath),directory=path.resolve(outputDirectory);
  const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:SOURCE_ROOT,encoding:'utf8',timeout:20000}).trim();
  assert.match(sourceRevision,/^[a-f0-9]{40}$/u);
  // Reusing a directory, even after a lost response or partial local write, must
  // stop before network access. Reconcile the journal with Stripe first.
  fs.mkdirSync(directory,{mode:0o700});
  const operationId=randomUUID(),journalPath=path.join(directory,'operation.json');
  // Stripe is the shared create owner across output directories. Unique operation
  // metadata makes overlapping requests conflict rather than reuse another receipt.
  // This guard lasts only for Stripe's idempotency retention; unresolved journals
  // still require operator reconciliation before a later setup attempt.
  const idempotencyKey='commerce-live-webhook:'+sha(JSON.stringify({account:LIVE_CHECKOUT_PROFILE.account,
    profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,url:LIVE_WEBHOOK_URL,apiVersion:LIVE_CHECKOUT_PROFILE.webhookApiVersion,events:EVENTS}));
  const journal={schema:'commerce.stripe-webhook-provisioning-journal/v1',sourceRevision,operationId,
    idempotencyKey,account:LIVE_CHECKOUT_PROFILE.account,
    profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,status:'preflight',createdAt:new Date().toISOString()};
  writeJson(journalPath,journal,{exclusive:true});
  let posted=false;
  try {
    await stripeClient(key,boundedStripeFetch,'live').verifyOffer();
    const inventoryResponse=await boundedStripeFetch(new Request('https://api.stripe.com/v1/webhook_endpoints?limit=100',{
      headers:{authorization:'Bearer '+key,'stripe-version':LIVE_CHECKOUT_PROFILE.webhookApiVersion}}));
    const inventory=await readBoundedJsonResponse(inventoryResponse,65536);
    assert(inventoryResponse.ok && Array.isArray(inventory.data) && inventory.data.length <= 100 && inventory.has_more === false
      && !inventory.data.some(endpoint=>endpoint.url === LIVE_WEBHOOK_URL),'Existing webhook or incomplete inventory requires reconciliation');
    const form=new URLSearchParams({url:LIVE_WEBHOOK_URL,api_version:LIVE_CHECKOUT_PROFILE.webhookApiVersion,connect:'false',
      'enabled_events[0]':EVENTS[0],'enabled_events[1]':EVENTS[1],
      'metadata[owner]':'agentic-commerce-os','metadata[operation_id]':operationId,'metadata[profile_digest]':LIVE_CHECKOUT_PROFILE_SHA256,
      'metadata[source_revision]':sourceRevision});
    journal.requestDigest=sha(form.toString());journal.status='posting';writeJson(journalPath,journal);
    posted=true;
    const response=await boundedStripeFetch(new Request('https://api.stripe.com/v1/webhook_endpoints',{method:'POST',
      headers:{authorization:'Bearer '+key,'content-type':'application/x-www-form-urlencoded',
        'stripe-version':LIVE_CHECKOUT_PROFILE.webhookApiVersion,'idempotency-key':journal.idempotencyKey},body:form.toString()}));
    const endpoint=await readBoundedJsonResponse(response,65536);
    assert(response.ok && endpoint.object === 'webhook_endpoint' && endpoint.livemode === true
      && endpoint.status === 'enabled' && endpoint.url === LIVE_WEBHOOK_URL
      && endpoint.api_version === LIVE_CHECKOUT_PROFILE.webhookApiVersion && Array.isArray(endpoint.enabled_events)
      && JSON.stringify([...endpoint.enabled_events].sort()) === JSON.stringify(EVENTS)
      && /^we_[A-Za-z0-9]{12,200}$/u.test(endpoint.id ?? '') && whsec(endpoint.secret)
      && endpoint.metadata?.owner === 'agentic-commerce-os' && endpoint.metadata.operation_id === operationId
      && endpoint.metadata.profile_digest === LIVE_CHECKOUT_PROFILE_SHA256 && endpoint.metadata.source_revision === sourceRevision,
      'Stripe endpoint creation could not be verified');
    const body={schema:SCHEMA,sourceRevision,operationId,account:LIVE_CHECKOUT_PROFILE.account,endpointId:endpoint.id,url:LIVE_WEBHOOK_URL,
      apiVersion:LIVE_CHECKOUT_PROFILE.webhookApiVersion,events:[...EVENTS],profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,
      secretDigest:sha(endpoint.secret),createdAt:new Date().toISOString()};
    const receipt={...body,authentication:createHmac('sha256',key).update(SCHEMA+'\n'+JSON.stringify(body)).digest('hex')};
    const secretPath=path.join(directory,'webhook-secret.json'),receiptPath=path.join(directory,'provisioning.json');
    writeJson(secretPath,{STRIPE_LIVE_WEBHOOK_SECRET:endpoint.secret},{exclusive:true});
    writeJson(receiptPath,receipt,{exclusive:true,mode:0o644});
    journal.status='verified';journal.endpointId=endpoint.id;journal.receiptDigest=sha(JSON.stringify(receipt));writeJson(journalPath,journal);
    return {endpointId:endpoint.id,secretPath,receiptPath};
  } catch {
    journal.status=posted?'uncertain':'preflight-failed';
    try {writeJson(journalPath,journal);} catch {/* Existing directory still prevents a duplicate create. */}
    throw Error(posted?'Webhook creation uncertain; reconcile operation.json with Stripe before another attempt':'Webhook provisioning preflight failed');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async()=>{
    const [command,configPath,outputDirectory,...extra]=process.argv.slice(2);
    if (command !== 'provision' || !configPath || !outputDirectory || extra.length) throw Error('Expected provision private-config-path private-output-directory');
    assert.equal(fs.realpathSync(process.cwd()),fs.realpathSync(SOURCE_ROOT),'Run from the integrated source root');
    // Lazy import avoids a cycle through artifact -> live-profile -> provisioner.
    const {assertCleanCandidate,git}=await import('./artifact.mjs');
    const revision=git('rev-parse','HEAD');assertCleanCandidate(revision);
    assert.equal(git('ls-remote','origin','refs/heads/main').split(/\s+/u)[0],revision,'Provisioner must use exact integrated main');
    for(const file of [configPath,outputDirectory])assert(!path.resolve(file).startsWith(path.resolve(SOURCE_ROOT)+path.sep),
      'Keep operator secrets and evidence outside source');
    return provisionStripeWebhook({configPath,outputDirectory});
  })().then(result=>console.log(JSON.stringify(result)))
    .catch(()=>{console.error('Stripe webhook provisioning did not complete; preserve and inspect the private operation journal.');process.exitCode=1;});
}
