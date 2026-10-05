import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {fetchLocalFirst} from '../../src/local-first/worker.ts';
import {LIVE_CHECKOUT_OFFER as OFFER,LIVE_CHECKOUT_PROFILE,LIVE_CHECKOUT_PROFILE_SHA256 as PROFILE,
  renderStorefrontTemplate} from '../../src/local-first/checkout-offer.ts';
import {stripeFixture} from './stripe-fixture.ts';
import {handleStripeWebhook} from '../../src/local-first/stripe-webhook.ts';

const origin='https://airvio.co',base=origin+'/agentic-commerce-os/checkout';
const asset=readFileSync(new URL('../../public/local-first/education-materials.md',import.meta.url));
const env={RELEASE_CANDIDATE_SHA:'a'.repeat(40),CHECKOUT_MODE:'live',CHECKOUT_LIVE_PROFILE_SHA256:PROFILE,
  STRIPE_LIVE_SECRET_KEY:'rk_live_'+'a'.repeat(32),STRIPE_LIVE_WEBHOOK_SECRET:'whsec_'+'b'.repeat(32),
  CHECKOUT_RECOVERY_SECRET:'r'.repeat(48),STOREFRONT_SESSION_SECRET:'s'.repeat(48),
  ASSETS:{async fetch(request){assert.equal(new URL(request.url).pathname,OFFER.asset);assert.deepEqual([...request.headers],[]);return new Response(asset);}}};
const terms={confirmed:true,offerId:OFFER.id};
function client(overrides={},fixture=stripeFixture('live')){
  let cookie='',csrf;
  return {fixture,get cookie(){return cookie;},set cookie(value){cookie=value;},
    async call(path='',body,headers={}){
      const response=await fetchLocalFirst(new Request(base+path,{method:body?'POST':'GET',
        headers:{cookie,...(body?{origin,'content-type':'application/json','x-commerce-csrf':csrf}:{}),...headers},
        ...(body?{body:JSON.stringify(body)}:{})}),{...env,...overrides},fixture.transport);
      if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
      if(value.csrfToken)csrf=value.csrfToken;
      return {status:response.status,value,headers:response.headers};
    }};
}
async function start(c){await c.call();const response=await c.call('/start',terms);assert.equal(response.status,200);return response.value;}
function eventFor(session){return {id:'evt_'+ 'e'.repeat(24),type:'checkout.session.completed',livemode:true,
  api_version:LIVE_CHECKOUT_PROFILE.webhookApiVersion,data:{object:structuredClone(session)}};}
async function webhook(fixture,event,options={}){
  const timestamp=options.timestamp??Math.floor(Date.now()/1000),body=options.body??JSON.stringify(event);
  const signature=createHmac('sha256',options.secret??env.STRIPE_LIVE_WEBHOOK_SECRET).update(timestamp+'.'+body).digest('hex');
  return fetchLocalFirst(new Request(base+'/webhook',{method:'POST',headers:{'content-type':'application/json',
    'stripe-signature':options.signature??`t=${timestamp},v1=${signature}`,...options.headers},body}),
    {...env,...options.env},fixture.transport);
}

test('live profile and immutable asset match exact reviewed bytes; template selects checkout mode',()=>{
  assert.equal(createHash('sha256').update(asset).digest('hex'),OFFER.assetDigest);
  assert.equal(createHash('sha256').update(JSON.stringify(LIVE_CHECKOUT_PROFILE)).digest('hex'),PROFILE);
  for(const mode of ['sandbox','live-reader','live']){
    const value=renderStorefrontTemplate('__CHECKOUT_MODE__ __OFFER_TITLE__ __OFFER_PRICE__','a'.repeat(40),mode);
    assert(value.startsWith(mode+' '));assert(value.includes('SGD'));assert.equal(value.includes('— sandbox'),mode==='sandbox');
  }
});
test('live requires all distinct credentials and exact profile, sandbox key cannot activate sales',async()=>{
  for(const overrides of [{STRIPE_LIVE_SECRET_KEY:''},{STRIPE_LIVE_SECRET_KEY:'sk_test_'+'a'.repeat(32)},
    {STRIPE_LIVE_WEBHOOK_SECRET:''},{CHECKOUT_RECOVERY_SECRET:''},{CHECKOUT_RECOVERY_SECRET:env.STOREFRONT_SESSION_SECRET},
    {CHECKOUT_LIVE_PROFILE_SHA256:'0'.repeat(64)},{CHECKOUT_MODE:'unrecognized'}]){
    const c=client(overrides);assert.equal((await c.call()).status,503);assert.equal(c.fixture.calls.length,0);
  }
});
test('live fixed offer creates once, isolates cookies, and no browser return is needed for webhook entitlement',async()=>{
  const c=client(),created=await start(c),id=created.order.orderId;
  assert.match(c.cookie,/^__Host-airvio_checkout=/);assert.equal(created.mode,'live');assert.equal(created.realMoney,true);
  assert.equal(created.order.downloadReady,false);assert.equal(created.recovery.schema,'commerce.live-checkout-recovery/v1');
  const duplicate=await c.call('/start',terms);assert.equal(duplicate.value.order.orderId,id);assert.equal(c.fixture.sessions.size,1);
  const create=c.fixture.calls.find(r=>r.method==='POST');const form=new URLSearchParams(await create.clone().text());
  assert.equal(form.get('line_items[0][price]'),OFFER.id);assert.equal(form.get('metadata[asset_digest]'),OFFER.assetDigest);
  assert.equal(form.get('metadata[profile_digest]'),PROFILE);assert.equal(form.get('metadata[mode]'),'live');
  assert.equal((await c.call('/download')).status,409);
  c.fixture.complete(id);
  assert.equal((await c.call('/status')).value.order.downloadReady,false);
  const event=eventFor(c.fixture.sessions.get(id));
  assert.equal((await webhook(c.fixture,event)).status,200);
  const writes=c.fixture.calls.filter(r=>r.method==='POST').length;
  assert.equal((await webhook(c.fixture,event)).status,200);
  assert.equal(c.fixture.calls.filter(r=>r.method==='POST').length,writes);
  const receipt=await c.call('/receipt');assert.equal(receipt.value.schema,'commerce.stripe-live-receipt/v1');
  assert.equal(receipt.value.chargeMinor,800);assert.equal(receipt.value.downloadReady,true);
  const download=await c.call('/download');assert.equal(download.status,200);assert.equal(download.value,asset.toString());
  assert(!JSON.stringify(receipt.value).includes('private@example'));
});
test('saved recovery grants the same paid download on a new device after cookie expiry, without another charge',async t=>{
  const c=client(),created=await start(c),id=created.order.orderId,token=created.recovery.recoveryToken;
  const peer=client({},c.fixture);
  assert.equal((await peer.call('/recover',{recoveryToken:token})).status,409);
  c.fixture.complete(id);await webhook(c.fixture,eventFor(c.fixture.sessions.get(id)));
  const now=Date.now();t.mock.method(Date,'now',()=>now+8*86400000);
  assert.equal((await c.call('/download')).status,401);
  const recovered=await peer.call('/recover',{recoveryToken:token});assert.equal(recovered.status,200);
  assert.equal(recovered.value.order.orderId,id);assert.equal(recovered.value.order.downloadReady,true);
  assert.equal((await peer.call('/download')).value,asset.toString());assert.equal(c.fixture.sessions.size,1);
  for(const invalid of [token+'x','forged',token.split('.')[0]])assert.equal((await peer.call('/recover',{recoveryToken:invalid})).status,403);
  assert.equal((await peer.call('/recover?token='+encodeURIComponent(token),{recoveryToken:token})).status,400);
  assert.equal((await peer.call('/recover',{recoveryToken:token},{origin:'https://foreign.test'})).status,403);
  const changed=client({CHECKOUT_RECOVERY_SECRET:'z'.repeat(48)},c.fixture);
  assert.equal((await changed.call('/recover',{recoveryToken:token})).status,403);
  t.mock.method(Date,'now',()=>now+366*86400000);
  assert.equal((await peer.call('/recover',{recoveryToken:token})).status,403);
});
test('sales-disabled reader preserves paid downloads, recovery and webhook handling without creating a session',async()=>{
  const c=client(),created=await start(c),id=created.order.orderId;c.fixture.complete(id);
  const reader=client({CHECKOUT_MODE:'live-reader'},c.fixture);reader.cookie=c.cookie;
  const opened=await reader.call();assert.equal(opened.value.mode,'live');assert.equal(opened.value.salesEnabled,false);
  const before=c.fixture.sessions.size;assert.equal((await reader.call('/start',terms)).status,409);
  assert.equal(c.fixture.sessions.size,before);
  assert.equal((await webhook(c.fixture,eventFor(c.fixture.sessions.get(id)),{env:{CHECKOUT_MODE:'live-reader'}})).status,200);
  assert.equal((await reader.call('/download')).status,200);
  assert.equal((await reader.call('/recovery',terms)).value.recoveryToken.split('.').length,2);
  const fresh=client({CHECKOUT_MODE:'live-reader'},c.fixture);
  assert.equal((await fresh.call('/recover',{recoveryToken:created.recovery.recoveryToken})).status,200);
  const open=client({},c.fixture),pending=await start(open);
  reader.cookie=open.cookie;await reader.call();
  assert.equal((await reader.call('/cancel',terms)).value.order.status,'expired');
  assert.equal((await reader.call('/reset',terms)).value.order,null);
  assert.equal(c.fixture.sessions.get(pending.order.orderId).status,'expired');
  await reader.call();
  assert.equal((await reader.call('/start',terms)).status,409);
});
test('webhook body cancellation and a noncooperative stream finish within the read deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const abort of [false,true]){
    let cancelled=false,calls=0;
    const controller=new AbortController(),timestamp=Math.floor(Date.now()/1000);
    const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}});
    const pending=handleStripeWebhook(new Request(base+'/webhook',{method:'POST',duplex:'half',body,signal:controller.signal,
      headers:{'content-type':'application/json','stripe-signature':`t=${timestamp},v1=${'a'.repeat(64)}`}}),
      env.STRIPE_LIVE_WEBHOOK_SECRET,async()=>{calls++;});
    if(abort)controller.abort();else t.mock.timers.tick(5000);
    const response=await pending;assert.equal(response.status,400);assert.equal(calls,0);assert.equal(cancelled,true);
  }
});
test('webhook signatures, mode, timestamp, namespace and body bounds fail before any Stripe call',async()=>{
  const fixture=stripeFixture('live'),foreign={id:'evt_'+'e'.repeat(24),type:'checkout.session.completed',livemode:true,
    api_version:LIVE_CHECKOUT_PROFILE.webhookApiVersion,data:{object:{id:'cs_live_'+'a'.repeat(24),object:'checkout.session',livemode:true,
      metadata:{owner:'another-app',mode:'live'}}}};
  assert.equal((await webhook(fixture,foreign)).status,200);assert.equal(fixture.calls.length,0);
  for(const options of [{secret:'whsec_'+'z'.repeat(32)},{timestamp:Math.floor(Date.now()/1000)-301},
    {signature:'t=1,v1=bad'},{headers:{cookie:'foreign'}},{headers:{origin}},{body:'x'.repeat(65537)}]){
    assert([400,413].includes((await webhook(fixture,foreign,options)).status));assert.equal(fixture.calls.length,0);
  }
  for(const mutation of [e=>e.livemode=false,e=>e.api_version='wrong',e=>e.id='bad']){
    const event=structuredClone(foreign);mutation(event);assert.equal((await webhook(fixture,event)).status,400);
  }
});
test('signed event cannot substitute wrong account, amount, currency, line item, owner, mode or asset',async()=>{
  for(const mutate of [(f,s)=>f.account.id='acct_foreign',(f,s)=>s.amount_total=1,(f,s)=>s.currency='usd',
    (f,s)=>s.metadata.owner='foreign',(f,s)=>s.metadata.asset_digest='0'.repeat(64),(f,s)=>s.metadata.profile_digest='0'.repeat(64),
    (f,s)=>s.livemode=false,(f,s)=>f.lineItems.get(s.id).data[0].price.id='price_foreign',
    (f,s)=>f.lineItems.get(s.id).has_more=true,(f,s)=>f.lineItems.get(s.id).data[0].quantity=2]){
    const c=client(),created=await start(c),id=created.order.orderId;c.fixture.complete(id);
    const event=eventFor(c.fixture.sessions.get(id));mutate(c.fixture,c.fixture.sessions.get(id));
    assert.equal((await webhook(c.fixture,event)).status,503);
    assert.equal(c.fixture.calls.filter(r=>r.method==='POST').length,1);
    assert.equal((await c.call('/download')).status,503);
  }
});
test('changed asset or account not enabled refuses sales before provider mutation; live rejects listing orders',async()=>{
  for(const setup of [c=>c.fixture.account.charges_enabled=false,c=>c.fixture.price.product='prod_wrong']){
    const c=client();setup(c);await c.call();assert.equal((await c.call('/start',terms)).status,503);
    assert.equal(c.fixture.calls.filter(r=>r.method==='POST').length,0);
  }
  const changed=client({ASSETS:{async fetch(){return new Response('changed');}}});await changed.call();
  assert.equal((await changed.call('/start',terms)).status,503);assert.equal(changed.fixture.calls.length,0);
  const c=client();await c.call();assert.equal((await c.call('/start',{...terms,reviewed:true,
    fulfillment:{runId:'listing-'+'a'.repeat(64),outputDigest:'b'.repeat(64)}})).status,400);
});
test('unknown live create and entitlement responses reuse stable provider identities',async()=>{
  const fixture=stripeFixture('live'),original=fixture.transport;let loseCreate=true,loseEntitlement=true;
  fixture.transport=async request=>{
    const response=await original(request);
    if(request.method==='POST'&&new URL(request.url).pathname==='/v1/checkout/sessions'&&loseCreate){loseCreate=false;throw Error('lost create');}
    if(request.method==='POST'&&new URL(request.url).pathname!=='/v1/checkout/sessions'&&loseEntitlement){loseEntitlement=false;throw Error('lost entitlement');}
    return response;
  };
  const c=client({},fixture);await c.call();assert.equal((await c.call('/start',terms)).status,503);
  const created=await c.call('/start',terms);assert.equal(created.status,200);assert.equal(fixture.sessions.size,1);
  const id=created.value.order.orderId;fixture.complete(id);const event=eventFor(fixture.sessions.get(id));
  assert.equal((await webhook(fixture,event)).status,503);assert.equal((await webhook(fixture,event)).status,200);
  assert.equal((await c.call('/download')).status,200);
  const creates=fixture.calls.filter(r=>r.method==='POST'&&new URL(r.url).pathname==='/v1/checkout/sessions');
  assert.equal(creates[0].headers.get('idempotency-key'),creates[1].headers.get('idempotency-key'));
});
test('concurrent live events retain one logical provider entitlement with a stable payload',{timeout:5000},async()=>{
  const c=client(),created=await start(c),id=created.order.orderId;c.fixture.complete(id);
  const original=c.fixture.transport,effects=new Map(),attempts=[];let reads=0,release;
  const together=new Promise(resolve=>{release=resolve;});
  c.fixture.transport=async request=>{
    const exactSession=new URL(request.url).pathname==='/v1/checkout/sessions/'+id;
    if(exactSession&&request.method==='GET'&&reads<2){
      // Capture both pre-entitlement responses before either handler may write.
      const response=await original(request);reads++;if(reads===2)release();await together;return response;
    }
    if(!exactSession||request.method!=='POST')return original(request);
    const key=request.headers.get('idempotency-key'),body=await request.clone().text();
    assert(key);attempts.push({key,body});let effect=effects.get(key);
    if(effect)assert.equal(effect.body,body,'Provider idempotency forbids changed parameters');
    else {effect={body,result:original(request).then(response=>response.text())};effects.set(key,effect);}
    return new Response(await effect.result,{headers:{'content-type':'application/json'}});
  };
  const first=eventFor(c.fixture.sessions.get(id));
  const second={...structuredClone(first),id:'evt_'+'f'.repeat(24),type:'checkout.session.async_payment_succeeded'};
  const responses=await Promise.all([webhook(c.fixture,first),webhook(c.fixture,second)]);
  assert.deepEqual(responses.map(response=>response.status),[200,200]);assert(attempts.length>=2);
  assert.equal(effects.size,1);assert.equal(new Set(attempts.map(item=>item.key)).size,1);
  assert.equal(new Set(attempts.map(item=>item.body)).size,1);
  assert.match(attempts[0].key,/^commerce-live-entitlement:/);
  assert.deepEqual([...new URLSearchParams(attempts[0].body)],[['metadata[entitlement_digest]',OFFER.assetDigest]]);
  assert.equal((await webhook(c.fixture,first)).status,200);assert.equal(effects.size,1);
  assert.equal(c.fixture.sessions.get(id).metadata.entitlement_digest,OFFER.assetDigest);
  assert.equal((await c.call('/download')).value,asset.toString());
});
