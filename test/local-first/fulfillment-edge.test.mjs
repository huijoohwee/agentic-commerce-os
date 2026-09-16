import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {listingHostIdentity} from '../../src/local-first/fulfillment-relay.ts';
import {LISTING_DEFINITION} from '../../src/local-first/fulfillment-definition.ts';

const require=createRequire(import.meta.url),toolRequire=createRequire(require.resolve('wrangler/package.json'));
const {build}=toolRequire('esbuild'),{Miniflare,convertV4MiniflareOptions}=toolRequire('miniflare');
const root=fileURLToPath(new URL('../../',import.meta.url));
const pins={origin:'https://executor.example.com',bundleSha256:'b'.repeat(64),
  imageId:LISTING_DEFINITION.imageDigest.slice(7),sourceRevision:'a'.repeat(40)};
const token='c'.repeat(64);

test('actual Worker runtime admits exact host identity, invokes with sealed context, and refuses redirects',async()=>{
  const source=`import {createFulfillmentRelay} from './src/local-first/fulfillment-relay.ts';
export default {async fetch(request,env){try{
const relay=createFulfillmentRelay(env);
const value=new URL(request.url).pathname==='/ready'?await relay.ready(AbortSignal.timeout(5000)):
await relay.invoke('status',{runId:'edge-contract'},{principalId:'commerce-'+ 'd'.repeat(64),principalExpiresAt:Date.now()+60000},AbortSignal.timeout(5000));
return Response.json({ok:true,value});}catch{return Response.json({ok:false},{status:503})}}};`;
  const built=await build({stdin:{contents:source,resolveDir:root,loader:'ts'},bundle:true,
    format:'esm',write:false,platform:'browser',target:'es2022'});
  const seen=[];let redirect=false;
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,
    compatibilityDate:'2026-08-26',bindings:{LISTING_HOST_PINS_JSON:JSON.stringify(pins),LISTING_HOST_BEARER:token},
    outboundService:async request=>{
      seen.push({url:request.url,method:request.method,
        principal:request.headers.get('x-commerce-principal-id')});
      assert.equal(new URL(request.url).origin,pins.origin);
      assert.equal(request.headers.get('authorization'),'Bearer '+token);
      assert.equal(request.headers.has('cookie'),false);assert.equal(request.headers.has('origin'),false);
      if(redirect)return Response.redirect('https://untrusted.example.com/receive',307);
      return Response.json(request.method==='GET'?listingHostIdentity(pins):{runId:'edge-contract',status:'idle'},
        {headers:{'cache-control':'no-store'}});
    }}));
  try{
    const ready=await mf.dispatchFetch('https://app.example.com/ready');
    assert.equal(ready.status,200);assert.deepEqual((await ready.json()).value,listingHostIdentity(pins));
    const status=await mf.dispatchFetch('https://app.example.com/status');
    assert.equal(status.status,200);assert.deepEqual((await status.json()).value,{runId:'edge-contract',status:'idle'});
    assert.equal(seen[0].principal,null);assert.equal(seen[1].principal,'commerce-'+'d'.repeat(64));
    redirect=true;
    assert.equal((await mf.dispatchFetch('https://app.example.com/ready')).status,503);
    assert.equal((await mf.dispatchFetch('https://app.example.com/status')).status,503);
    assert.equal(seen.length,4);assert(seen.every(request=>new URL(request.url).origin===pins.origin));
  }finally{await mf.dispose();}
});

test('actual Worker fulfillment boundary streams one bounded native observation with session and CSRF', async () => {
  const source=`import {handleFulfillment} from './src/local-first/fulfillment.ts';
export default {fetch(request){return handleFulfillment(request,'worker-observation-secret-longer-than-32-characters',{
 async invoke(operation,input){return operation==='query'?{schema:'agent-toolkit-query/v1',status:'completed',items:[]}:
 {schema:'agent-toolkit-run/v1',status:'completed',runId:input.runId,spans:[]};}})}};`;
  const built=await build({stdin:{contents:source,resolveDir:root,loader:'ts'},bundle:true,
    format:'esm',write:false,platform:'browser',target:'es2022'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,
    compatibilityDate:'2026-08-26'}));
  try{
    const origin='https://app.example.com',base=origin+'/agentic-commerce-os/fulfillment/';
    const session=await mf.dispatchFetch(base+'session'),cookie=session.headers.get('set-cookie').split(';')[0];
    const token=(await session.json()).csrfToken;
    const send=(operation,body,extra={})=>mf.dispatchFetch(base+operation,{method:'POST',headers:{cookie,origin,
      'content-type':'application/json','x-commerce-csrf':token,accept:'text/event-stream',...extra},body:JSON.stringify(body)});
    const response=await send('query',{});assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    const frames=(await response.text()).trim().split('\n\n');assert.equal(frames.length,2);
    assert.deepEqual(JSON.parse(frames[0].slice(6)),{schema:'agent-toolkit-query/v1',status:'completed',items:[]});
    assert.equal(frames[1],'data: [DONE]');
    const json=await send('trace',{runId:'listing-'+'1'.repeat(64)},{accept:'application/json'});
    assert.match(json.headers.get('content-type'),/^application\/json/);
    assert.equal((await json.json()).runId,'listing-'+'1'.repeat(64));
    assert.equal((await send('query',{principalId:'peer'})).status,400);
    assert.equal((await send('trace',{runId:'listing-'+'1'.repeat(64)},{'x-commerce-csrf':'forged'})).status,403);
    assert.equal((await send('query',{}, {cookie:''})).status,401);
    assert.equal((await send('query',{cursor:'x'.repeat(17000)})).status,413);
  }finally{await mf.dispose();}
});
