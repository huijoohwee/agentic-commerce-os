import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {CHECKOUT_OFFER,LIVE_CHECKOUT_PROFILE_SHA256} from '../../src/local-first/checkout-offer.ts';
import {stripeFixture} from './stripe-fixture.ts';
import {optimizeListingBundle} from '../../scripts/local-host/build.ts';

const require=createRequire(import.meta.url),esbuild=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const root=fileURLToPath(new URL('../../',import.meta.url));
async function compile(device){
  const result=await esbuild.build({stdin:{contents:
    "export {fetchLocalFirst} from './src/local-first/worker.ts';export {stripeClient} from './src/local-first/stripe-checkout.ts';",
    resolveDir:root,sourcefile:'checkout-profile.mjs'},write:false,bundle:true,platform:'node',format:'esm',
    target:'node22',minify:true,legalComments:'none',...(device?{define:{'import.meta.commerceLiveCheckout':'false'}}:{})});
  const optimized=await optimizeListingBundle(result.outputFiles[0].text,new AbortController().signal);
  return import('data:text/javascript;base64,'+Buffer.from(optimized).toString('base64'));
}
const device=await compile(true),worker=await compile(false);
const origin='https://airvio.co',base=origin+'/agentic-commerce-os/checkout';
const env={RELEASE_CANDIDATE_SHA:'a'.repeat(40),CHECKOUT_MODE:'sandbox',
  STOREFRONT_SESSION_SECRET:'device-sandbox-session-secret-longer-than-32-characters',
  STRIPE_TEST_SECRET_KEY:'sk_test_'+'f'.repeat(32),ASSETS:{async fetch(){return new Response('# Retained sandbox download');}}};
function client(owner=device,overrides={}){
  const fixture=stripeFixture();let cookie='',csrf;
  return {fixture,async call(suffix='',body,headers={}){
    const response=await owner.fetchLocalFirst(new Request(base+suffix,{method:body?'POST':'GET',
      headers:{cookie,...(body?{origin,'content-type':'application/json','x-commerce-csrf':csrf}:{}),...headers},
      ...(body?{body:JSON.stringify(body)}:{})}),{...env,...overrides},fixture.transport);
    if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
    if(value.csrfToken)csrf=value.csrfToken;
    return {status:response.status,value,headers:response.headers};
  }};
}
const terms={offerId:CHECKOUT_OFFER.id,confirmed:true};
test('compiled device profile retains sandbox confirmation, idempotency, receipt and verified download',async()=>{
  const c=client(),opened=await c.call();assert.equal(opened.status,200);assert.equal(opened.value.realMoney,false);
  assert.match(opened.headers.get('set-cookie'),/^__Host-airvio_sandbox=/);
  assert.equal((await c.call('/start',terms,{'x-commerce-csrf':'forged'})).status,403);
  const start=await c.call('/start',terms);assert.equal(start.status,200);
  assert.deepEqual((await c.call('/start',terms)).value,start.value);
  assert.equal(c.fixture.calls.filter(request=>request.method==='POST').length,1);
  const form=new URLSearchParams(await c.fixture.calls.find(request=>request.method==='POST').clone().text());
  assert.equal(form.get('line_items[0][price]'),CHECKOUT_OFFER.id);
  assert.equal((await c.call('/download')).status,409);
  c.fixture.complete(start.value.order.orderId);
  const receipt=await c.call('/receipt');assert.equal(receipt.value.schema,'commerce.stripe-test-receipt/v1');
  assert.equal(receipt.value.chargeMinor,0);assert.equal(receipt.value.status,'succeeded');
  assert.match((await c.call('/download')).value,/Retained sandbox download/);
  c.fixture.sessions.get(start.value.order.orderId).livemode=true;
  assert.equal((await c.call('/download')).status,503);
  const cancelled=client();await cancelled.call();await cancelled.call('/start',terms);
  assert.equal((await cancelled.call('/reset',terms)).status,409);
  assert.equal((await cancelled.call('/cancel',terms)).value.order.status,'expired');
  assert.equal((await cancelled.call('/reset',terms)).status,200);
});
test('compiled device profile refuses complete live configuration and live adapter calls before transport',async()=>{
  const live={STRIPE_LIVE_SECRET_KEY:'rk_live_'+'l'.repeat(40),STRIPE_LIVE_WEBHOOK_SECRET:'whsec_'+'w'.repeat(40),
    CHECKOUT_RECOVERY_SECRET:'device-profile-recovery-secret-longer-than-32-characters',
    CHECKOUT_LIVE_PROFILE_SHA256:LIVE_CHECKOUT_PROFILE_SHA256};
  for(const CHECKOUT_MODE of ['live','live-reader']){
    const c=client(device,{...live,CHECKOUT_MODE});
    for(const suffix of ['', '/start','/webhook','/recover'])assert.equal((await c.call(suffix,suffix?terms:undefined)).status,503);
    assert.equal(c.fixture.calls.length,0);
  }
  assert.throws(()=>device.stripeClient(live.STRIPE_LIVE_SECRET_KEY,()=>{throw Error('unexpected transport');},'live'),/unavailable/);
  const c=client(device,{STRIPE_TEST_SECRET_KEY:live.STRIPE_LIVE_SECRET_KEY});
  assert.equal((await c.call()).status,503);assert.equal(c.fixture.calls.length,0);
});
test('ordinary compiled Worker retains the explicitly configured live capability',async()=>{
  const c=client(worker,{CHECKOUT_MODE:'live',STRIPE_LIVE_SECRET_KEY:'rk_live_'+'l'.repeat(40),
    STRIPE_LIVE_WEBHOOK_SECRET:'whsec_'+'w'.repeat(40),
    CHECKOUT_RECOVERY_SECRET:'worker-profile-recovery-secret-longer-than-32-characters',
    CHECKOUT_LIVE_PROFILE_SHA256:LIVE_CHECKOUT_PROFILE_SHA256});
  const opened=await c.call();assert.equal(opened.status,200);assert.equal(opened.value.mode,'live');
  assert.equal(opened.value.realMoney,true);assert.match(opened.headers.get('set-cookie'),/^__Host-airvio_checkout=/);
  assert.equal(c.fixture.calls.length,0);
});
test('abort during the actual final compiler pass disposes its context and returns no artifact',async()=>{
  const controller=new AbortController();let started,release,context;
  const entered=new Promise(resolve=>{started=resolve;}),paused=new Promise(resolve=>{release=resolve;});
  const running=optimizeListingBundle('export const answer=42;',controller.signal,async options=>{
    context=await esbuild.context({...options,plugins:[{name:'pause-final-pass',setup(build){
      build.onStart(async()=>{started();await paused;});
    }}]});return context;
  });
  const refused=assert.rejects(running,/cancel/i);
  await entered;controller.abort();release();await refused;
  await assert.rejects(context.rebuild(),/Cannot rebuild/);
});
