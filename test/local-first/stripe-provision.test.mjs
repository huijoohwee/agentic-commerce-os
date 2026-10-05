import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { provisionStripeWebhook, verifyWebhookProvisioning, parseWebhookProvisioning,
  LIVE_WEBHOOK_URL } from '../../scripts/local-first-release/stripe-provision.mjs';
import { LIVE_CHECKOUT_PROFILE, LIVE_CHECKOUT_PROFILE_SHA256 } from '../../src/local-first/checkout-offer.ts';
const key='rk_live_'+'l'.repeat(40),secret='whsec_'+'w'.repeat(40);
function fixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'commerce-provision-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const configPath=path.join(directory,'config.json'),outputDirectory=path.join(directory,'operation');
  fs.writeFileSync(configPath,JSON.stringify({stripeLiveKey:key}),{mode:0o600});
  const calls=[];let created,notifyPosted=()=>{};
  const posted=new Promise(resolve=>{notifyPosted=resolve;});
  t.mock.method(globalThis,'fetch',async request=>{
    calls.push(request);assert.equal(new URL(request.url).origin,'https://api.stripe.com');assert.equal(request.redirect,'error');
    let value;
    if(request.method === 'POST') {
      const form=new URLSearchParams(await request.text());
      assert.equal(form.get('url'),LIVE_WEBHOOK_URL);assert.equal(form.get('connect'),'false');
      assert.equal(form.get('api_version'),LIVE_CHECKOUT_PROFILE.webhookApiVersion);
      assert.deepEqual([form.get('enabled_events[0]'),form.get('enabled_events[1]')],
        ['checkout.session.async_payment_succeeded','checkout.session.completed']);
      const journal=JSON.parse(fs.readFileSync(path.join(outputDirectory,'operation.json'),'utf8'));
      assert.equal(journal.status,'posting');assert.equal(request.headers.get('idempotency-key'),journal.idempotencyKey);
      created={id:'we_'+'e'.repeat(24),object:'webhook_endpoint',livemode:true,status:'enabled',url:LIVE_WEBHOOK_URL,
        api_version:LIVE_CHECKOUT_PROFILE.webhookApiVersion,enabled_events:['checkout.session.completed','checkout.session.async_payment_succeeded'],
        metadata:{owner:'agentic-commerce-os',operation_id:form.get('metadata[operation_id]'),profile_digest:LIVE_CHECKOUT_PROFILE_SHA256,
          source_revision:form.get('metadata[source_revision]')},secret};
      notifyPosted();
      if(options.hang)return new Promise(()=>{});
      if(options.lose)throw Error('opaque transport '+secret);
      value=created;if(options.mutate)options.mutate(value);
    } else if(new URL(request.url).pathname === '/v1/account')value={id:LIVE_CHECKOUT_PROFILE.account,charges_enabled:true};
    else if(new URL(request.url).pathname.startsWith('/v1/prices/'))value={id:LIVE_CHECKOUT_PROFILE.price,
      product:LIVE_CHECKOUT_PROFILE.product,active:true,livemode:true,type:'one_time',unit_amount:800,currency:'sgd'};
    else value={data:options.existing?[{url:LIVE_WEBHOOK_URL}]:[],has_more:options.more??false};
    const response=Response.json(value);Object.defineProperty(response,'url',{value:request.url});
    if(options.redirect)Object.defineProperty(response,'redirected',{value:true});
    return response;
  });
  return {configPath,outputDirectory,calls,posted,get created(){return created;}};
}
test('controlled provisioner reads identity first, creates one exact endpoint, and privately retains its returned secret',async t=>{
  const f=fixture(t),result=await provisionStripeWebhook(f);
  assert.equal(f.calls.filter(request=>request.method === 'POST').length,1);
  assert.equal(f.calls.at(-1).method,'POST');
  const receipt=JSON.parse(fs.readFileSync(result.receiptPath,'utf8'));
  const privateSecret=JSON.parse(fs.readFileSync(result.secretPath,'utf8'));
  assert.equal(privateSecret.STRIPE_LIVE_WEBHOOK_SECRET,secret);
  assert.equal(fs.statSync(result.secretPath).mode&0o077,0);assert.equal(fs.statSync(f.outputDirectory).mode&0o077,0);
  assert.equal(verifyWebhookProvisioning(receipt,{stripeLiveKey:key,webhookSecret:secret}).endpointId,f.created.id);
  assert(!JSON.stringify(receipt).includes(secret));assert(!JSON.stringify(result).includes(secret));
  assert(!fs.readFileSync(path.join(f.outputDirectory,'operation.json'),'utf8').includes(key));
  const before=f.calls.length;await assert.rejects(provisionStripeWebhook(f));assert.equal(f.calls.length,before);
  for(const changed of [{...receipt,secretDigest:'0'.repeat(64)},{...receipt,endpointId:'we_'+'x'.repeat(24)},
    {...receipt,authentication:'0'.repeat(64)}])assert.throws(()=>verifyWebhookProvisioning(changed,{stripeLiveKey:key,webhookSecret:secret}));
  assert.throws(()=>verifyWebhookProvisioning(receipt,{stripeLiveKey:key,webhookSecret:'whsec_'+'x'.repeat(40)}));
  assert.throws(()=>verifyWebhookProvisioning(receipt,{stripeLiveKey:'rk_live_'+'x'.repeat(40),webhookSecret:secret}));
  assert.throws(()=>parseWebhookProvisioning({...receipt,secret}));
});
test('lost create response is journaled uncertain and cannot trigger a blind duplicate',async t=>{
  const f=fixture(t,{lose:true});await assert.rejects(provisionStripeWebhook(f),error=>!error.message.includes(secret)&&/uncertain/.test(error.message));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDirectory,'operation.json'),'utf8')).status,'uncertain');
  assert(!fs.existsSync(path.join(f.outputDirectory,'provisioning.json')));
  const count=f.calls.length;await assert.rejects(provisionStripeWebhook(f));assert.equal(f.calls.length,count);
});
test('parallel empty inventories in different directories permit at most one provider create',async t=>{
  const f=fixture(t),other={configPath:f.configPath,outputDirectory:f.outputDirectory+'-other'};
  const readFetch=globalThis.fetch,posts=[],seen=new Map();let inventories=0,releaseInventory=()=>{},created=0;
  const barrier=new Promise(resolve=>{releaseInventory=resolve;});
  t.mock.method(globalThis,'fetch',async request=>{
    const url=new URL(request.url);let value,status=200;
    if(request.method === 'POST'){
      const body=await request.text(),form=new URLSearchParams(body),idempotencyKey=request.headers.get('idempotency-key');
      posts.push({idempotencyKey,body});
      if(seen.has(idempotencyKey)){
        assert.notEqual(seen.get(idempotencyKey),body,'Independent operation metadata must differ');
        status=409;value={error:{type:'idempotency_error'}};
      } else {
        seen.set(idempotencyKey,body);created++;
        value={id:'we_'+'e'.repeat(24),object:'webhook_endpoint',livemode:true,status:'enabled',url:LIVE_WEBHOOK_URL,
          api_version:LIVE_CHECKOUT_PROFILE.webhookApiVersion,enabled_events:['checkout.session.completed','checkout.session.async_payment_succeeded'],
          metadata:{owner:'agentic-commerce-os',operation_id:form.get('metadata[operation_id]'),profile_digest:LIVE_CHECKOUT_PROFILE_SHA256,
            source_revision:form.get('metadata[source_revision]')},secret};
      }
    } else if(url.pathname === '/v1/webhook_endpoints'){
      if(++inventories === 2)releaseInventory();await barrier;value={data:[],has_more:false};
    } else return readFetch(request);
    const response=Response.json(value,{status});Object.defineProperty(response,'url',{value:request.url});return response;
  });
  const results=await Promise.allSettled([provisionStripeWebhook(f),provisionStripeWebhook(other)]);
  assert.equal(inventories,2);assert.equal(posts.length,2);assert.equal(created,1);
  assert.equal(posts[0].idempotencyKey,posts[1].idempotencyKey);
  assert.equal(results.filter(result=>result.status === 'fulfilled').length,1);
  assert.equal(results.filter(result=>result.status === 'rejected').length,1);
  const loser=[f,other][results.findIndex(result=>result.status === 'rejected')];
  assert.equal(JSON.parse(fs.readFileSync(path.join(loser.outputDirectory,'operation.json'),'utf8')).status,'uncertain');
  assert(!fs.existsSync(path.join(loser.outputDirectory,'provisioning.json')));
  await assert.rejects(provisionStripeWebhook(loser));assert.equal(posts.length,2);
});
test('noncooperative POST transport has a hard deadline and preserves an uncertain journal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{hang:true});
  const running=provisionStripeWebhook(f);const refused=assert.rejects(running,/uncertain/);
  await f.posted;t.mock.timers.tick(15000);await refused;
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.outputDirectory,'operation.json'),'utf8')).status,'uncertain');
});
test('existing endpoint, incomplete inventory and redirects refuse creation before a POST',async t=>{
  for(const options of [{existing:true},{more:true},{redirect:true}]){
    const f=fixture(t,options);await assert.rejects(provisionStripeWebhook(f),/preflight/);
    assert.equal(f.calls.filter(request=>request.method === 'POST').length,0);
  }
});
test('wrong profile, malformed returned secret and oversized response cannot produce a pairing receipt',async t=>{
  for(const mutate of [value=>value.livemode=false,value=>value.url='https://foreign.test',value=>value.api_version='wrong',
    value=>value.enabled_events=['*'],value=>value.secret='',value=>value.metadata.operation_id='foreign',value=>value.padding='x'.repeat(65537)]){
    const f=fixture(t,{mutate});await assert.rejects(provisionStripeWebhook(f),/uncertain/);
    assert(!fs.existsSync(path.join(f.outputDirectory,'provisioning.json')));
  }
});
test('private configuration rejects symlinks, shared permissions and supplied whsec before network access',async t=>{
  for(const choice of ['permissions','secret','symlink']){
    const f=fixture(t);
    if(choice === 'permissions')fs.chmodSync(f.configPath,0o644);
    else if(choice === 'secret')fs.writeFileSync(f.configPath,JSON.stringify({stripeLiveKey:key,webhookSecret:secret}));
    else {const link=f.configPath+'.link';fs.symlinkSync(f.configPath,link);f.configPath=link;}
    await assert.rejects(provisionStripeWebhook(f));assert.equal(f.calls.length,0);
  }
  const f=fixture(t);fs.chmodSync(f.configPath,0o644);
  const result=spawnSync(process.execPath,['scripts/local-first-release/stripe-provision.mjs','provision',f.configPath,f.outputDirectory],{encoding:'utf8'});
  assert.equal(result.status,1);assert(!result.stdout.includes(key)&&!result.stderr.includes(key)&&!result.stderr.includes(secret));
});
