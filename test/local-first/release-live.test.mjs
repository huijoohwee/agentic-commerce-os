import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readCheckoutRelease, liveAuthorizationScope, liveSecretFingerprint, validateLiveReaderCompletion,
  verifyLiveReleasePrerequisites, LIVE_COMPLETION_SCHEMA, LIVE_WEBHOOK_URL } from '../../scripts/local-first-release/live-profile.mjs';
import { validateLocalFirstAuthorization, parseLocalFirstAuthorization } from '../../scripts/local-first-release/authorization.mjs';
import { createProvider } from '../../scripts/local-first-release/provider.mjs';
import { deployLocalFirst } from '../../scripts/local-first-release/deployment.mjs';
import { waitForReadiness } from '../../scripts/local-first-release/readiness.mjs';
import { LIVE_CHECKOUT_PROFILE, LIVE_CHECKOUT_PROFILE_SHA256 as PROFILE } from '../../src/local-first/checkout-offer.ts';
import { stripeFixture } from './stripe-fixture.ts';

const sha='a'.repeat(40),digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const webhookId='we_'+'w'.repeat(24), versionId='11111111-1111-1111-1111-111111111111';
const credentials={STOREFRONT_SESSION_SECRET:'s'.repeat(48),STRIPE_TEST_SECRET_KEY:'sk_test_'+'t'.repeat(32),
  STRIPE_LIVE_SECRET_KEY:'rk_live_'+'l'.repeat(32),STRIPE_LIVE_WEBHOOK_SECRET:'whsec_'+'w'.repeat(32),
  CHECKOUT_RECOVERY_SECRET:'r'.repeat(48)};
const fingerprint=liveSecretFingerprint(credentials);
// Test-only operator evidence; production can sign only a validated create response.
const provisionBody={schema:'commerce.stripe-webhook-operator-provisioning/v1',sourceRevision:sha,
  operationId:'33333333-3333-3333-3333-333333333333',account:LIVE_CHECKOUT_PROFILE.account,endpointId:webhookId,
  url:LIVE_WEBHOOK_URL,apiVersion:LIVE_CHECKOUT_PROFILE.webhookApiVersion,
  events:['checkout.session.async_payment_succeeded','checkout.session.completed'],profileDigest:PROFILE,
  secretDigest:createHash('sha256').update(credentials.STRIPE_LIVE_WEBHOOK_SECRET).digest('hex'),createdAt:'2026-10-05T00:00:00.000Z'};
const provisioning={...provisionBody,authentication:createHmac('sha256',credentials.STRIPE_LIVE_SECRET_KEY)
  .update(provisionBody.schema+'\n'+JSON.stringify(provisionBody)).digest('hex')};
const provisioningDigest=digest(provisioning);
const selector=(checkout='live-reader',reader)=>readCheckoutRelease({LOCAL_FIRST_CHECKOUT:checkout,
  LOCAL_FIRST_LIVE_WEBHOOK_ID:webhookId,LOCAL_FIRST_LIVE_READER_JSON:reader?JSON.stringify(reader):'',
  LOCAL_FIRST_WEBHOOK_PROVISIONING_JSON:JSON.stringify(provisioning)});
function completion(){
  const body={schema:LIVE_COMPLETION_SCHEMA,status:'production-complete',profile:'local-first',checkout:'live-reader',
    sourceRevision:sha,runId:41,worker:'agentic-commerce-edge-production',deployment:{versionId,deploymentId:'reader-deployment'},
    artifactDigest:'b'.repeat(64),browserProofDigest:'c'.repeat(64),livePrerequisites:{checkout:'live-reader',
      profileDigest:PROFILE,webhookId,provisioningDigest,secretSetDigest:fingerprint}};
  return {...body,receiptDigest:digest(body)};
}
function readerFor(receipt=completion()){return {sourceRevision:sha,versionId,runId:41,receiptDigest:receipt.receiptDigest};}
function approvalFixture(selection=selector()){
  const owner={login:'huijoohwee',id:17,type:'User'};
  const environment={name:'production',protection_rules:[{type:'required_reviewers',prevent_self_review:false,
    reviewers:[{type:'User',reviewer:owner}]}]};
  const reviews=[{state:'approved',environments:[{name:'production'}],user:owner}];
  const run={id:42,head_sha:sha,run_attempt:1,head_branch:'main',event:'workflow_dispatch',
    name:'Local-first Production Release',path:'.github/workflows/local-first-release.yml',
    repository:{full_name:'huijoohwee/agentic-commerce-os',owner},actor:owner,triggering_actor:owner};
  const expected={releaseMode:'steady-state',candidateSha:sha,runId:42,runAttempt:1,artifactDigest:'b'.repeat(64),selection};
  return {environment,reviews,run,expected,config:JSON.parse(fs.readFileSync('wrangler.local-first.jsonc'))};
}
const authorize=f=>validateLocalFirstAuthorization(f.reviews,f.environment,f.run,f.config,f.expected);

test('live selection is explicit, closed and distinct from sandbox and requires an exact retained reader for sales',()=>{
  assert.deepEqual(readCheckoutRelease({}),{checkout:'sandbox'});
  for(const env of [{LOCAL_FIRST_CHECKOUT:'auto'},{LOCAL_FIRST_LIVE_WEBHOOK_ID:webhookId},
    {LOCAL_FIRST_CHECKOUT:'live-reader'},{LOCAL_FIRST_CHECKOUT:'live',LOCAL_FIRST_LIVE_WEBHOOK_ID:webhookId},
    {LOCAL_FIRST_CHECKOUT:'live',LOCAL_FIRST_LIVE_WEBHOOK_ID:webhookId,LOCAL_FIRST_LIVE_READER_JSON:JSON.stringify({...readerFor(),extra:true})}])
    assert.throws(()=>readCheckoutRelease(env));
  const live=selector('live',readerFor());assert.equal(liveAuthorizationScope(live).readerDigest,digest(readerFor()));
  assert.equal(selector().profileDigest,PROFILE);
});
test('CLI emits only validated checkout and numeric reader run outputs, refusing injected input',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'commerce-live-cli-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const output=path.join(directory,'output');
  const run=overrides=>spawnSync(process.execPath,['scripts/local-first-release/live-profile.mjs','preflight'],{
    env:{PATH:process.env.PATH,GITHUB_OUTPUT:output,LOCAL_FIRST_CHECKOUT:'live-reader',LOCAL_FIRST_LIVE_WEBHOOK_ID:webhookId,
      LOCAL_FIRST_WEBHOOK_PROVISIONING_JSON:JSON.stringify(provisioning),...overrides},encoding:'utf8'});
  assert.equal(run({}).status,0);assert.equal(fs.readFileSync(output,'utf8'),'checkout=live-reader\nreader_run_id=\n');
  assert.notEqual(run({LOCAL_FIRST_CHECKOUT:'live\ninjected=value'}).status,0);
});
test('live approval cannot inherit sandbox v2 or change mode, profile, webhook, reader, source or run',()=>{
  const f=approvalFixture(),receipt=authorize(f);assert.equal(receipt.schema,'commerce.local-first-live-owner-authorization/v1');
  assert.equal(receipt.checkout,'live-reader');
  assert.throws(()=>parseLocalFirstAuthorization(receipt,{...f.expected,selection:{checkout:'sandbox'}}));
  const sandbox=approvalFixture({checkout:'sandbox'}),old=authorize(sandbox);
  assert.equal(old.schema,'commerce.local-first-owner-authorization/v2');assert(!('live' in old));
  assert.throws(()=>parseLocalFirstAuthorization(old,f.expected));
  for(const selection of [selector('live',readerFor()),{...selector(),webhookId:'we_'+'x'.repeat(24)},
    {...selector(),webhookProvisioning:{...provisioning,authentication:'0'.repeat(64)}},
    {...selector(),profileDigest:'0'.repeat(64)},selector('live-reader',{...readerFor(),runId:49})])
    assert.throws(()=>parseLocalFirstAuthorization(receipt,{...f.expected,selection}));
  for(const expected of [{...f.expected,runId:99},{...f.expected,runAttempt:2},{...f.expected,candidateSha:'c'.repeat(40)}])
    assert.throws(()=>parseLocalFirstAuthorization(receipt,expected));
  f.reviews=[];assert.throws(()=>authorize(f));
});
test('secret fingerprints bind retained recovery, live, webhook, sandbox and optional host secrets without exposing values',()=>{
  assert.match(fingerprint,/^[a-f0-9]{64}$/u);
  for(const name of Object.keys(credentials))assert.notEqual(liveSecretFingerprint({...credentials,[name]:credentials[name]+'a'}),fingerprint);
  assert.notEqual(liveSecretFingerprint({...credentials,LISTING_HOST_BEARER:'h'.repeat(48)}),fingerprint);
  assert.throws(()=>liveSecretFingerprint({...credentials,CHECKOUT_RECOVERY_SECRET:credentials.STOREFRONT_SESSION_SECRET}));
  const receipt=completion(),reader=readerFor();
  validateLiveReaderCompletion(receipt,reader,{secretSetDigest:fingerprint,webhookId,provisioningDigest});
  for(const mutate of [r=>r.checkout='sandbox',r=>r.livePrerequisites.secretSetDigest='0'.repeat(64),
    r=>r.deployment.versionId='different',r=>r.runId=42,r=>r.livePrerequisites.webhookId='foreign',
    r=>r.livePrerequisites.provisioningDigest='0'.repeat(64)]){
    const changed=structuredClone(receipt);mutate(changed);const {receiptDigest:_,...body}=changed;changed.receiptDigest=digest(body);
    assert.throws(()=>validateLiveReaderCompletion(changed,{...reader,receiptDigest:changed.receiptDigest},{secretSetDigest:fingerprint,webhookId,provisioningDigest}));
  }
});
function liveBindings(){return [{name:'ASSETS',type:'assets'},{name:'CF_VERSION_METADATA',type:'version_metadata'},
  {name:'RELEASE_CANDIDATE_SHA',type:'plain_text',text:sha},{name:'CHECKOUT_MODE',type:'plain_text',text:'live-reader'},
  ...Object.keys(credentials).map(name=>({name,type:'secret_text'})),
  {name:'CHECKOUT_LIVE_PROFILE_SHA256',type:'plain_text',text:PROFILE},
  {name:'CHECKOUT_SECRET_SET_SHA256',type:'plain_text',text:fingerprint}];}
test('provider requires all exact live bindings and rejects mixed mode, incomplete, extra or changed secret/profile pins',async t=>{
  let bindings=liveBindings();
  t.mock.method(globalThis,'fetch',async()=>Response.json({success:true,result:{resources:{bindings},annotations:{'workers/tag':sha}}}));
  const provider=createProvider({accountId:'a'.repeat(32),zoneId:'b'.repeat(32),token:'fixture'});
  assert.equal((await provider.version(versionId,sha,'live-reader',null,fingerprint)).checkout,'live-reader');
  await assert.rejects(provider.version(versionId,sha,'live',null,fingerprint));
  await assert.rejects(provider.version(versionId,sha,'sandbox'));
  for(const change of [b=>b.pop(),b=>b.push({name:'OTHER',type:'secret_text'}),b=>b[9].text='0'.repeat(64),
    b=>b[10].text='0'.repeat(64),b=>b[4].type='plain_text']){
    bindings=liveBindings();change(bindings);await assert.rejects(provider.version(versionId,sha,'live-reader',null,fingerprint));
  }
});
function prerequisiteFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'commerce-live-reader-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'retained-live-reader'));fs.writeFileSync(path.join(directory,'retained-live-reader/completion.json'),JSON.stringify(completion()));
  const f=approvalFixture(),stripe=stripeFixture('live'),calls=[];
  const endpoint={id:webhookId,status:'enabled',livemode:true,url:LIVE_WEBHOOK_URL,
    metadata:{owner:'agentic-commerce-os',operation_id:provisioning.operationId,profile_digest:PROFILE,source_revision:sha},
    api_version:LIVE_CHECKOUT_PROFILE.webhookApiVersion,enabled_events:['checkout.session.completed','checkout.session.async_payment_succeeded']};
  const current={checkout:'live-reader',profileDigest:PROFILE,secretSetDigest:fingerprint};
  const run={...f.run,id:41,status:'completed',conclusion:'success'};
  const args={env:{...credentials,GH_TOKEN:'fixture-token',GITHUB_ACTIONS:'true'},evidenceDir:directory,
    routeAuthority:{mode:'steady-state'},provider:{async active(){return {versionId};},async version(id,source,mode,pins,secret){
      if(mode){assert.equal(id,versionId);assert.equal(source,sha);assert.equal(mode,'live-reader');assert.equal(secret,fingerprint);}return current;}},
    async github(url){if(url.endsWith('/jobs'))return {jobs:[{name:'Authorized Local-first Production Release',conclusion:'success',steps:[
      {name:'Verify scoped owner policy and actual run approval',conclusion:'success'},
      {name:'Deploy the reviewed checkout profile and verify the exact public release',conclusion:'success'}]}]};
      if(url.endsWith('/approvals'))return f.reviews;if(url.endsWith('/production'))return f.environment;return run;},
    async transport(request){calls.push(request);assert.equal(request.method,'GET');
      return new URL(request.url).pathname.startsWith('/v1/webhook_endpoints/')?Response.json(endpoint):stripe.transport(request);}};
  return {args,endpoint,current,run,stripe,requests:calls};
}
test('live prerequisites use GET only and require active exact reader, authenticated run, correct webhook and stable secrets',async t=>{
  const f=prerequisiteFixture(t),selection=selector('live',readerFor());
  const proof=await verifyLiveReleasePrerequisites(selection,f.args);
  assert.equal(proof.secretSetDigest,fingerprint);assert.equal(proof.readerProof.reader.runId,41);
  assert(f.requests.length>0 && f.requests.every(request=>request.method==='GET'));
  for(const mutate of [f=>f.endpoint.url='https://foreign.test',f=>f.endpoint.livemode=false,f=>f.endpoint.status='disabled',
    f=>f.endpoint.enabled_events=['*'],f=>f.endpoint.api_version='wrong',f=>f.current.secretSetDigest='0'.repeat(64),
    f=>f.run.conclusion='failure',f=>f.run.run_attempt=2,f=>f.args.env.GITHUB_ACTIONS='false',
    f=>{const get=f.args.github;f.args.github=async url=>{const result=await get(url);
      if(url.endsWith('/jobs'))result.jobs[0].steps[1].conclusion='skipped';return result;};},
    f=>f.args.provider.active=async()=>({versionId:'different'})]){
    const changed=prerequisiteFixture(t);mutate(changed);await assert.rejects(verifyLiveReleasePrerequisites(selection,changed.args));
  }
});
test('a valid-looking but swapped webhook secret or forged pairing is refused before provider access',async t=>{
  for(const change of ['secret','signature','metadata']){
    const f=prerequisiteFixture(t),selection=selector('live',readerFor());
    if(change === 'secret')f.args.env.STRIPE_LIVE_WEBHOOK_SECRET='whsec_'+'x'.repeat(32);
    if(change === 'metadata')f.endpoint.metadata.operation_id='44444444-4444-4444-4444-444444444444';
    const selected=change === 'signature'?{...selection,webhookProvisioning:{...provisioning,authentication:'0'.repeat(64)}}:selection;
    await assert.rejects(verifyLiveReleasePrerequisites(selected,f.args));
    if(change !== 'metadata')assert.equal(f.requests.length,0);
  }
});
test('reader deployment keeps paid access operable after new charges or the price are disabled',async t=>{
  const f=prerequisiteFixture(t);f.stripe.account.charges_enabled=false;f.stripe.price.active=false;
  assert.equal((await verifyLiveReleasePrerequisites(selector(),f.args)).offer.salesCapable,false);
  await assert.rejects(verifyLiveReleasePrerequisites(selector('live',readerFor()),f.args));
});
test('readiness accepts only the explicitly expected live mode and real-money storage identity',async()=>{
  const identity={ok:true,profile:'local-first',sourceRevision:sha,workerVersionId:versionId,checkout:'live-reader',
    storage:'browser-only',paymentStorage:'stripe-live',paymentProvider:'stripe',realMoney:true};
  const options={url:LIVE_WEBHOOK_URL.replace('/checkout/webhook','/readyz'),revision:sha,versionId,
    fetchImpl:async()=>Response.json(identity)};
  assert.equal((await waitForReadiness({...options,checkout:'live-reader'})).checkout,'live-reader');
  await assert.rejects(waitForReadiness({...options,checkout:'live'}),/invalid_profile/);
  await assert.rejects(waitForReadiness(options),/invalid_profile/);
});
test('live convergence tolerates only the explicitly verified predecessor mode/source/version',async()=>{
  const nextVersion='22222222-2222-2222-2222-222222222222';
  const previous={checkout:'live-reader',sourceRevision:sha,workerVersionId:versionId};
  const identity={ok:true,profile:'local-first',storage:'browser-only',paymentStorage:'stripe-live',paymentProvider:'stripe',realMoney:true};
  let polls=0,now=0;
  const options={url:'https://airvio.co/agentic-commerce-os/readyz',revision:sha,versionId:nextVersion,checkout:'live',previous,
    now:()=>now,sleep:async n=>{now+=n;},fetchImpl:async()=>Response.json({...identity,...previous,
      ...(polls++?{checkout:'live',workerVersionId:nextVersion}:{})})};
  assert.equal((await waitForReadiness(options)).workerVersionId,nextVersion);assert.equal(polls,2);
  await assert.rejects(waitForReadiness({...options,previous:{...previous,workerVersionId:nextVersion}}),/invalid_predecessor/);
  await assert.rejects(waitForReadiness({...options,fetchImpl:async()=>Response.json({...identity,...previous,
    workerVersionId:'33333333-3333-3333-3333-333333333333'})}),/invalid_profile/);
});
test('failed live read-only verification restores only its owned exact reader; unknown writes are not replayed',async()=>{
  for(const lost of [false,true]){
    const prior={versionId,deploymentId:'prior'},candidate={versionId:'22222222-2222-2222-2222-222222222222',deploymentId:'next'};
    const route={id:'r'.repeat(32),pattern:'airvio.co/agentic-commerce-os*',script:'agentic-commerce-edge-production',state:'bound'};
    let active=prior;const writes=[],journal={};
    const provider={async active(){return active;},async route(){return route;},async version(){},
      async exposure(){return {enabled:false,previews_enabled:false};}};
    await assert.rejects(deployLocalFirst({provider,routeAuthority:{mode:'steady-state',...route,routeId:route.id},
      before:{active:prior,route},journal,revision:sha,checkout:'live',secretSetDigest:fingerprint,secretsFile:'/fixture/secrets',
      checkMain(){},record(){},wrangler(args){writes.push(args);active=args[0]==='deploy'?candidate:prior;if(lost)throw Error('unknown write');},
      async verifyLive(){throw Error('read-only proof failed');}}));
    assert.equal(writes.filter(args=>args[0]==='deploy').length,1);
    assert(writes[0].includes('CHECKOUT_MODE:live'));assert(writes[0].includes('CHECKOUT_SECRET_SET_SHA256:'+fingerprint));
    assert.equal(writes.filter(args=>args[0]==='versions').length,lost?0:1);
    assert.equal(active.versionId,lost?candidate.versionId:prior.versionId);
  }
});
