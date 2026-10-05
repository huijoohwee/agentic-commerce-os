import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {fetchLocalFirst} from '../../src/local-first/worker.ts';
import {TEST_CHECKOUT_OFFER as OFFER,TEST_CHECKOUT_PROFILE,TEST_CHECKOUT_PROFILE_SHA256 as PROFILE,
  LIVE_CHECKOUT_PROFILE_SHA256,checkoutProfile,checkoutProfileDigest} from '../../src/local-first/checkout-offer.ts';
import {createCheckoutRecovery,readCheckoutRecovery} from '../../src/local-first/checkout-recovery.ts';
import {cookie,csrf,newSession,readSession} from '../../src/local-first/session.ts';
import {stripeClient} from '../../src/local-first/stripe-checkout.ts';
import fixtureEntry,{stripeFixture} from './stripe-fixture.ts';

const origin='https://airvio.co',base=origin+'/agentic-commerce-os/checkout';
const asset=readFileSync(new URL('../../public/local-first/education-materials.md',import.meta.url));
const env={RELEASE_CANDIDATE_SHA:'a'.repeat(40),CHECKOUT_MODE:'test',CHECKOUT_TEST_PROFILE_SHA256:PROFILE,
  STRIPE_TEST_SECRET_KEY:'sk_test_'+'t'.repeat(32),STRIPE_TEST_WEBHOOK_SECRET:'whsec_'+'h'.repeat(32),
  CHECKOUT_TEST_RECOVERY_SECRET:'r'.repeat(48),STOREFRONT_SESSION_SECRET:'s'.repeat(48),
  ASSETS:{async fetch(request){assert.equal(new URL(request.url).pathname,OFFER.asset);
    assert.deepEqual([...request.headers],[]);return new Response(asset);}}};
const terms={confirmed:true,offerId:OFFER.id};
function client(overrides={},fixture=stripeFixture('test')){
  let storedCookie='',token;
  return {fixture,get cookie(){return storedCookie;},set cookie(value){storedCookie=value;},
    async call(suffix='',body,headers={}){
      const response=await fetchLocalFirst(new Request(base+suffix,{method:body?'POST':'GET',
        headers:{cookie:storedCookie,...(body?{origin,'content-type':'application/json','x-commerce-csrf':token}:{}),...headers},
        ...(body?{body:JSON.stringify(body)}:{})}),{...env,...overrides},fixture.transport);
      if(response.headers.has('set-cookie'))storedCookie=response.headers.get('set-cookie').split(';')[0];
      const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
      if(value.csrfToken)token=value.csrfToken;
      return {status:response.status,value,headers:response.headers};
    }};
}
async function start(c){await c.call();const response=await c.call('/start',terms);assert.equal(response.status,200);return response.value;}
const eventFor=session=>({id:'evt_'+'e'.repeat(24),type:'checkout.session.completed',livemode:false,
  api_version:TEST_CHECKOUT_PROFILE.webhookApiVersion,data:{object:structuredClone(session)}});
async function webhook(fixture,event,options={}){
  const timestamp=options.timestamp??Math.floor(Date.now()/1000),body=options.body??JSON.stringify(event);
  const signature=createHmac('sha256',options.secret??env.STRIPE_TEST_WEBHOOK_SECRET).update(timestamp+'.'+body).digest('hex');
  return fetchLocalFirst(new Request(base+'/webhook',{method:'POST',headers:{'content-type':'application/json',
    'stripe-signature':`t=${timestamp},v1=${signature}`,...options.headers},body}),{...env,...options.env},fixture.transport);
}

// Model the provider's idempotency contract independently of HTTP attempt count.
// A barrier makes both concurrent reads observe the same pre-entitlement state.
function replayingProvider(fixture,id,{parallelReads=0,loseFirstReply=false}={}){
  const original=fixture.transport,effects=new Map(),attempts=[];
  let reads=0,release,staleRead=false,lost=false;
  const together=new Promise(resolve=>{release=resolve;});
  fixture.transport=async request=>{
    const url=new URL(request.url),sessionPath='/v1/checkout/sessions/'+id;
    if(request.method==='GET'&&url.pathname===sessionPath){
      const response=await original(request);
      if(staleRead){staleRead=false;const value=await response.json();delete value.metadata.entitlement_digest;return Response.json(value);}
      if(parallelReads&&reads<parallelReads){reads++;if(reads===parallelReads)release();await together;}
      return response;
    }
    if(request.method!=='POST'||url.pathname!==sessionPath)return original(request);
    const key=request.headers.get('idempotency-key'),body=await request.clone().text();
    assert(key,'Provider requires an idempotency key');attempts.push({key,body});
    let effect=effects.get(key);
    if(effect)assert.equal(effect.body,body,'The same provider operation cannot change parameters');
    else {effect={body,result:original(request).then(async response=>({status:response.status,body:await response.text()}))};effects.set(key,effect);}
    const result=await effect.result;
    if(loseFirstReply&&!lost){lost=true;staleRead=true;throw Error('Accepted write response lost');}
    return new Response(result.body,{status:result.status,headers:{'content-type':'application/json'}});
  };
  return {effects,attempts};
}
function assertEntitlementEffect(provider){
  assert.equal(provider.effects.size,1,'Retries must resolve to one logical provider operation');
  assert.equal(new Set(provider.attempts.map(item=>item.key)).size,1);
  assert.equal(new Set(provider.attempts.map(item=>item.body)).size,1);
  assert.match(provider.attempts[0].key,/^commerce-hosted-test-entitlement:/);
  assert.deepEqual([...new URLSearchParams(provider.attempts[0].body)],[['metadata[entitlement_digest]',OFFER.assetDigest]]);
}

test('hosted test profile pins the existing test offer and immutable asset independently of live',()=>{
  assert.equal(TEST_CHECKOUT_PROFILE.product,'prod_VF75VTaUhifetp');
  assert.equal(TEST_CHECKOUT_PROFILE.price,'price_1UEcrJGzH0w0k4VU6HbApj39');
  assert.equal(TEST_CHECKOUT_PROFILE.amountMinor,800);assert.equal(TEST_CHECKOUT_PROFILE.currency,'sgd');
  assert.equal(createHash('sha256').update(asset).digest('hex'),OFFER.assetDigest);
  assert.equal(createHash('sha256').update(JSON.stringify(TEST_CHECKOUT_PROFILE)).digest('hex'),PROFILE);
  assert.deepEqual(checkoutProfile('test'),TEST_CHECKOUT_PROFILE);assert.equal(checkoutProfileDigest('test'),PROFILE);
  assert.notEqual(PROFILE,LIVE_CHECKOUT_PROFILE_SHA256);
});
test('hosted test requires its complete distinct credentials and exact profile before provider I/O',async()=>{
  for(const overrides of [{STRIPE_TEST_SECRET_KEY:''},{STRIPE_TEST_SECRET_KEY:'rk_live_'+'l'.repeat(32)},
    {STRIPE_TEST_WEBHOOK_SECRET:''},{CHECKOUT_TEST_RECOVERY_SECRET:''},
    {CHECKOUT_TEST_RECOVERY_SECRET:env.STOREFRONT_SESSION_SECRET},{CHECKOUT_TEST_PROFILE_SHA256:LIVE_CHECKOUT_PROFILE_SHA256}]){
    const c=client(overrides);assert.equal((await c.call()).status,503);assert.equal(c.fixture.calls.length,0);
  }
  assert.throws(()=>stripeClient('sk_live_'+'l'.repeat(32),()=>{throw Error('transport');},'test'),/mode_key/);
  assert.throws(()=>stripeClient(env.STRIPE_TEST_SECRET_KEY,()=>{throw Error('transport');},'live'),/mode_key/);
});
test('signed test webhook establishes entitlement without browser return; receipt never represents a real charge',async()=>{
  const c=client();c.fixture.account.charges_enabled=false;
  const created=await start(c),id=created.order.orderId;
  assert.match(id,/^cs_test_/);assert.match(c.cookie,/^__Host-airvio_test_checkout=/);
  assert.equal(created.mode,'test');assert.equal(created.realMoney,false);
  assert.equal(created.recovery.schema,'commerce.test-checkout-recovery/v1');
  assert.equal(created.recovery.offerProfile,PROFILE);assert.equal(created.order.downloadReady,false);
  assert.equal((await c.call('/start',terms)).value.order.orderId,id);assert.equal(c.fixture.sessions.size,1);
  const form=new URLSearchParams(await c.fixture.calls.find(request=>request.method==='POST').clone().text());
  assert.equal(form.get('line_items[0][price]'),OFFER.id);assert.equal(form.get('metadata[mode]'),'test');
  assert.equal(form.get('metadata[profile_digest]'),PROFILE);assert.equal(form.get('metadata[product_id]'),OFFER.productId);
  assert.equal(form.get('metadata[asset_digest]'),OFFER.assetDigest);
  assert.equal((await c.call('/download')).status,409);
  c.fixture.complete(id);
  const pending=await c.call('/status');assert.equal(pending.value.order.downloadReady,false);
  assert.equal((await c.call('/download')).status,409);
  const event=eventFor(c.fixture.sessions.get(id));
  assert.equal((await webhook(c.fixture,event)).status,200);
  assert.equal((await webhook(c.fixture,event)).status,200);
  const receipt=await c.call('/receipt');
  assert.deepEqual({schema:receipt.value.schema,mode:receipt.value.mode,realMoney:receipt.value.realMoney,
    chargeMinor:receipt.value.chargeMinor,testAmountMinor:receipt.value.testAmountMinor,profileDigest:receipt.value.profileDigest,
    entitlementReady:receipt.value.entitlementReady,downloadReady:receipt.value.downloadReady},
  {schema:'commerce.stripe-test-receipt/v1',mode:'test',realMoney:false,chargeMinor:0,testAmountMinor:800,
    profileDigest:PROFILE,entitlementReady:true,downloadReady:true});
  assert(!JSON.stringify(receipt.value).includes('private@example'));
  assert.equal((await c.call('/download')).value,asset.toString());
});
test('sandbox, test and live cookies, CSRF and recovery have separate authentication domains',async()=>{
  const modes=['sandbox','test','live'],session=newSession(),cookies=new Map(),tokens=[];
  for(const mode of modes){cookies.set(mode,(await cookie(session,env.STOREFRONT_SESSION_SECRET,mode)).split(';')[0]);
    tokens.push(await csrf(session,env.STOREFRONT_SESSION_SECRET,mode));}
  assert.equal(new Set(tokens).size,3);
  for(const from of modes)for(const to of modes){
    const raw=cookies.get(from),request=new Request(base,{headers:{cookie:raw}});
    assert.deepEqual(await readSession(request,env.STOREFRONT_SESSION_SECRET,to),from===to?session:null);
    if(from!==to){const renamed=cookies.get(to).split('=')[0]+'='+raw.slice(raw.indexOf('=')+1);
      assert.equal(await readSession(new Request(base,{headers:{cookie:renamed}}),env.STOREFRONT_SESSION_SECRET,to),null);}
  }
  const testSession={...session,paymentId:'cs_test_'+'a'.repeat(24)};
  const recovery=await createCheckoutRecovery(testSession,env.CHECKOUT_TEST_RECOVERY_SECRET,'test');
  assert.equal((await readCheckoutRecovery(recovery.recoveryToken,env.CHECKOUT_TEST_RECOVERY_SECRET,'test')).paymentId,testSession.paymentId);
  assert.equal(await readCheckoutRecovery(recovery.recoveryToken,env.CHECKOUT_TEST_RECOVERY_SECRET,'live'),null);
  const liveRecovery=await createCheckoutRecovery({...session,paymentId:'cs_live_'+'a'.repeat(24)},env.CHECKOUT_TEST_RECOVERY_SECRET);
  assert.equal(await readCheckoutRecovery(liveRecovery.recoveryToken,env.CHECKOUT_TEST_RECOVERY_SECRET,'test'),null);
  for(const [mode,id] of [['test','cs_live_'],['live','cs_test_']]){
    const raw=await cookie({...session,paymentId:id+'a'.repeat(24)},env.STOREFRONT_SESSION_SECRET,mode);
    assert.equal(await readSession(new Request(base,{headers:{cookie:raw}}),env.STOREFRONT_SESSION_SECRET,mode),null);
  }
});
test('test recovery rejects unpaid, tampered and expired authority; a paid order survives cookie expiry without another session',async t=>{
  const c=client(),created=await start(c),id=created.order.orderId,token=created.recovery.recoveryToken,peer=client({},c.fixture);
  assert.equal((await peer.call('/recover',{recoveryToken:token})).status,409);
  assert.equal((await webhook(c.fixture,eventFor(c.fixture.sessions.get(id)))).status,503);
  c.fixture.complete(id);await webhook(c.fixture,eventFor(c.fixture.sessions.get(id)));
  const now=Date.now();t.mock.method(Date,'now',()=>now+8*86400000);
  assert.equal((await c.call('/download')).status,401);
  const recovered=await peer.call('/recover',{recoveryToken:token});assert.equal(recovered.status,200);
  assert.equal(recovered.value.order.orderId,id);assert.equal(recovered.value.order.entitlementReady,true);
  assert.equal((await peer.call('/download')).value,asset.toString());assert.equal(c.fixture.sessions.size,1);
  for(const invalid of [token+'x','forged',token.split('.')[0]])assert.equal((await peer.call('/recover',{recoveryToken:invalid})).status,403);
  assert.equal((await peer.call('/recover?token='+encodeURIComponent(token),{recoveryToken:token})).status,400);
  assert.equal((await peer.call('/recover',{recoveryToken:token},{origin:'https://foreign.test'})).status,403);
  const changed=client({CHECKOUT_TEST_RECOVERY_SECRET:'z'.repeat(48)},c.fixture);
  assert.equal((await changed.call('/recover',{recoveryToken:token})).status,403);
  t.mock.method(Date,'now',()=>now+366*86400000);
  assert.equal((await peer.call('/recover',{recoveryToken:token})).status,403);
});
test('test webhook rejects live/session/API/signature crossover before provider I/O',async()=>{
  const c=client(),created=await start(c),id=created.order.orderId;c.fixture.complete(id);
  const event=eventFor(c.fixture.sessions.get(id)),before=c.fixture.calls.length;
  for(const mutate of [value=>value.livemode=true,value=>value.api_version='wrong',
    value=>value.data.object.livemode=true,value=>value.data.object.id='cs_live_'+'a'.repeat(24)]){
    const wrong=structuredClone(event);mutate(wrong);assert.equal((await webhook(c.fixture,wrong)).status,400);
  }
  for(const options of [{secret:'whsec_'+'x'.repeat(32)},{timestamp:Math.floor(Date.now()/1000)-301},
    {headers:{origin}},{headers:{cookie:'foreign'}}])assert.equal((await webhook(c.fixture,event,options)).status,400);
  for(const mode of ['sandbox','live']){const wrong=structuredClone(event);wrong.data.object.metadata.mode=mode;
    assert.equal((await webhook(c.fixture,wrong)).status,200);}
  assert.equal(c.fixture.calls.length,before);assert.equal((await c.call('/download')).status,409);
});
test('test signed event revalidates provider identity and immutable offer before granting a download',async()=>{
  for(const mutate of [(f,s)=>f.account.id='acct_foreign',(f,s)=>s.amount_total=1,(f,s)=>s.currency='usd',
    (f,s)=>s.metadata.owner='foreign',(f,s)=>s.metadata.mode='sandbox',(f,s)=>s.metadata.asset_digest='0'.repeat(64),
    (f,s)=>s.metadata.profile_digest=LIVE_CHECKOUT_PROFILE_SHA256,(f,s)=>s.livemode=true,
    (f,s)=>f.lineItems.get(s.id).data[0].price.product='prod_foreign',
    (f,s)=>f.lineItems.get(s.id).data[0].price.id='price_foreign',
    (f,s)=>f.lineItems.get(s.id).data[0].price.livemode=true,(f,s)=>f.lineItems.get(s.id).has_more=true]){
    const c=client(),created=await start(c),id=created.order.orderId;c.fixture.complete(id);
    const event=eventFor(c.fixture.sessions.get(id));mutate(c.fixture,c.fixture.sessions.get(id));
    assert.equal((await webhook(c.fixture,event)).status,503);
    assert.equal(c.fixture.sessions.get(id).metadata.entitlement_digest,undefined);
    assert.equal((await c.call('/download')).status,503);
  }
});
test('concurrent test events resolve to one stable entitlement operation and identical asset',{timeout:5000},async()=>{
  const c=client(),created=await start(c),id=created.order.orderId;c.fixture.complete(id);
  const provider=replayingProvider(c.fixture,id,{parallelReads:2}),first=eventFor(c.fixture.sessions.get(id));
  const second={...structuredClone(first),id:'evt_'+'f'.repeat(24),type:'checkout.session.async_payment_succeeded'};
  const responses=await Promise.all([webhook(c.fixture,first),webhook(c.fixture,second)]);
  assert.deepEqual(responses.map(response=>response.status),[200,200]);assert(provider.attempts.length>=2);
  assertEntitlementEffect(provider);
  const before=c.fixture.sessions.get(id).metadata.entitlement_digest;
  assert.equal((await webhook(c.fixture,first)).status,200);assertEntitlementEffect(provider);
  assert.equal(c.fixture.sessions.get(id).metadata.entitlement_digest,before);
  assert.equal(before,OFFER.assetDigest);assert.equal((await c.call('/download')).value,asset.toString());
});
test('unknown create and entitlement responses retain provider identities across retry',async()=>{
  const fixture=stripeFixture('test'),original=fixture.transport,creates=[];let lost=false;
  fixture.transport=async request=>{
    const response=await original(request);
    if(request.method==='POST'&&new URL(request.url).pathname==='/v1/checkout/sessions'){
      creates.push({key:request.headers.get('idempotency-key'),body:await request.clone().text()});
      if(!lost){lost=true;throw Error('Accepted create response lost');}
    }
    return response;
  };
  const c=client({},fixture);await c.call();assert.equal((await c.call('/start',terms)).status,503);
  const created=await c.call('/start',terms);assert.equal(created.status,200);assert.equal(fixture.sessions.size,1);
  assert.equal(new Set(creates.map(item=>item.key)).size,1);assert.equal(new Set(creates.map(item=>item.body)).size,1);
  assert.match(creates[0].key,/^commerce-hosted-test:/);
  const id=created.value.order.orderId;fixture.complete(id);
  const provider=replayingProvider(fixture,id,{loseFirstReply:true}),event=eventFor(fixture.sessions.get(id));
  assert.equal((await webhook(fixture,event)).status,503);assert.equal((await webhook(fixture,event)).status,200);
  assert.equal(provider.attempts.length,2);assertEntitlementEffect(provider);
  assert.equal((await c.call('/download')).value,asset.toString());
});
test('fixture control routes refuse public hosts and cross-origin callers',async()=>{
  for(const path of ['/__stripe-fixture/complete','/__stripe-fixture/seed-paid']){
    for(const [url,headers] of [[origin+path,{}],['http://127.0.0.1:8787'+path,{origin}],
      ['http://localhost:8787'+path,{'sec-fetch-site':'cross-site'}]]){
      const response=await fixtureEntry.fetch(new Request(url,{method:'POST',headers,body:'{}'}),env);
      assert.equal(response.status,403);
    }
  }
});
