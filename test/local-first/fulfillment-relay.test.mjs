import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createFulfillmentRelay,parseListingHostPins,listingHostHeaders,listingHostIdentity,LISTING_HOST_READY_PATH} from '../../src/local-first/fulfillment-relay.ts';
import {createListingHostRelay} from '../../scripts/durable-fulfillment/relay.mjs';
import {readRunContext} from '../../src/local-first/session.ts';
import {LISTING_DEFINITION} from '../../src/local-first/fulfillment-definition.ts';
import worker from '../../src/local-first/worker.ts';
import {fetchLocalFirst} from '../../src/local-first/worker.ts';
import {startListingHost} from '../../scripts/durable-fulfillment/host.mjs';

const source='a'.repeat(40),secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
const pins={origin:'https://commerce-executor.airvio.co',bundleSha256:'b'.repeat(64),
  imageId:LISTING_DEFINITION.imageDigest.slice(7),sourceRevision:source};
const env={RELEASE_CANDIDATE_SHA:source,STOREFRONT_SESSION_SECRET:secret,
  LISTING_HOST_PINS_JSON:JSON.stringify(pins),LISTING_HOST_BEARER:token,
  ASSETS:{async fetch(){return new Response('Readable draft application');}}};
const context=()=>({principalId:'commerce-'+randomBytes(32).toString('hex'),principalExpiresAt:Date.now()+60000});
const signal=()=>AbortSignal.timeout(5000);

test('relay configuration is closed, bound to the product image and disabled when absent',()=>{
  assert.equal(createFulfillmentRelay({}),undefined);
  for(const bad of [{LISTING_HOST_BEARER:token},{LISTING_HOST_PINS_JSON:JSON.stringify(pins)},
    {...env,LISTING_HOST_BEARER:'0'.repeat(64)},{...env,LISTING_HOST_PINS_JSON:'x'.repeat(2049)}])
    assert.throws(()=>createFulfillmentRelay(bad));
  for(const bad of [{...pins,origin:'http://localhost:5192'},{...pins,origin:'https://example.test'},
    {...pins,origin:pins.origin+'/path'},{...pins,imageId:'1'.repeat(64)},
    {...pins,sourceRevision:'0'.repeat(40)},{...pins,extra:true}])assert.throws(()=>parseListingHostPins(bad));
});

test('edge readiness verifies exact host pins and bounds failures before issuing browser sessions',async()=>{
  const identity=listingHostIdentity(pins);
  const relay=createFulfillmentRelay(env,async request=>{
    assert.equal(request.url,pins.origin+LISTING_HOST_READY_PATH);assert.equal(request.redirect,'manual');
    assert.equal(request.headers.get('authorization'),'Bearer '+token);
    assert.equal(request.headers.has('cookie'),false);assert.equal(request.headers.has('x-commerce-principal-id'),false);
    return Response.json(identity,{headers:{'cache-control':'no-store'}});
  });
  assert.deepEqual(await relay.ready(signal()),identity);
  for(const response of [Response.json({...identity,bundleSha256:'c'.repeat(64)},{headers:{'cache-control':'no-store'}}),
    Response.json({...identity,extra:true},{headers:{'cache-control':'no-store'}}),Response.json(identity),
    new Response('offline',{status:503}),new Response(null,{status:302,headers:{location:'https://different.example'}}),
    Response.json({value:'x'.repeat(5000)},{headers:{'cache-control':'no-store'}})])
    await assert.rejects(createFulfillmentRelay(env,async()=>response).ready(signal()));
  const partial={...env,LISTING_HOST_PINS_JSON:undefined};
  const response=await worker.fetch(new Request('https://airvio.co/agentic-commerce-os/fulfillment/session'),partial);
  assert.equal(response.status,503);assert.equal(response.headers.has('set-cookie'),false);
  assert.equal((await worker.fetch(new Request('https://airvio.co/agentic-commerce-os/app.js'),partial)).status,200);
});

test('host requires service credentials and exact pins, seals principal ownership, and rechecks model readiness',async()=>{
  let available=true,checks=0;
  const config={sourceRevision:source,sessionSecret:secret,modelAuthorization:'Bearer '+randomBytes(32).toString('hex'),
    async verifyArtifacts(){checks++;if(!available)throw Error('model offline');}};
  const host=createListingHostRelay({pins,token},config),owner=context();
  const headers=listingHostHeaders(pins,token,owner);
  const sealed=await host.authenticate(Object.fromEntries(headers));
  assert.deepEqual(await readRunContext(sealed.principalId,secret),sealed);
  assert.notEqual(sealed.principalId,owner.principalId);
  for(const change of [h=>h.set('authorization','Bearer '+randomBytes(32).toString('hex')),
    h=>h.set('x-commerce-host-bundle-sha256','c'.repeat(64)),h=>h.set('x-commerce-host-source','d'.repeat(40)),
    h=>h.set('x-commerce-host-image-id','d'.repeat(64)),h=>h.set('x-commerce-host-definition','d'.repeat(64)),
    h=>h.set('x-commerce-principal-id','forged'),h=>h.set('x-commerce-principal-expires',String(Date.now()-1)),
    h=>h.set('x-commerce-principal-expires',String(Date.now()+8*86400000)),h=>h.set('origin','https://airvio.co'),
    h=>h.set('cookie','unexpected')]){
    const changed=new Headers(headers);change(changed);assert.equal(await host.authenticate(Object.fromEntries(changed)),null);
  }
  const probe=()=>new Request(pins.origin+LISTING_HOST_READY_PATH,{headers:listingHostHeaders(pins,token)});
  assert.equal((await host.ready(probe())).status,200);assert.equal(checks,1);
  available=false;assert.equal((await host.ready(probe())).status,503);assert.equal(checks,2);
  assert.equal((await host.ready(new Request(probe(),{headers}))).status,403);
  assert.equal((await host.ready(new Request(probe(),{method:'POST'}))).status,400);
  assert.throws(()=>createListingHostRelay({pins,token:secret},config));
  assert.throws(()=>createListingHostRelay({pins,token},{...config,sourceRevision:'e'.repeat(40)}));
});

test('concurrent relay calls retain separate server principals and reject principal injection in JSON',async()=>{
  const owners=[context(),context()],seen=[];
  const relay=createFulfillmentRelay(env,async(input,init)=>{
    const request=new Request(input,init),body=await request.json();
    await new Promise(resolve=>setTimeout(resolve,body.runId.endsWith('1')?15:1));
    seen.push({runId:body.runId,principalId:request.headers.get('x-commerce-principal-id')});
    assert.equal(request.headers.get('authorization'),'Bearer '+token);
    assert.equal(request.headers.get('origin'),null);assert.equal(request.headers.get('cookie'),null);
    return Response.json({runId:body.runId,status:'planning'});
  });
  await Promise.all(owners.map((owner,index)=>relay.invoke('status',{runId:'listing-'+String(index+1).repeat(64)},owner,signal())));
  for(const [index,owner]of owners.entries())assert.equal(seen.find(row=>row.runId==='listing-'+String(index+1).repeat(64)).principalId,owner.principalId);
  await assert.rejects(relay.invoke('status',{runId:'listing-'+ '1'.repeat(64),principalId:owners[1].principalId},owners[0],signal()));
  assert.equal(seen.length,2);
  const failed=createFulfillmentRelay(env,async()=>{throw Error('connection lost');});
  await assert.rejects(failed.invoke('cancel',{runId:'listing-'+ '1'.repeat(64),operationId:'cancel-one'},owners[0],signal()),
    error=>error.writeResultUnknown===true&&error.reasonCode==='run_transport_failed');
  for(const status of [400,404,429,500,502]){
    const refused=createFulfillmentRelay(env,async()=>Response.json({code:'run_host_failed'},{status}));
    await assert.rejects(refused.invoke('cancel',{runId:'listing-'+ '1'.repeat(64),operationId:'cancel-one'},owners[0],signal()),
      error=>error.status===503&&error.code==='fulfillment_transport_unavailable'&&error.writeResultUnknown===(status>=500));
  }
});

test('real HTTP relay resumes one SQLite job after host restart and denies another browser',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'listing-relay-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let executions=0,host;
  const modelAuthorization='Bearer '+randomBytes(32).toString('hex');
  const model=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    assert.equal(req.headers.authorization,modelAuthorization);assert.equal(JSON.parse(body).max_tokens,256);executions++;
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'sha256:'+LISTING_DEFINITION.modelSha256,
      choices:[{message:{content:'Ceramic mug\n- Blue\n- 300 ml'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8}}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await host?.close();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));});
  const config={directory,sessionSecret:randomBytes(32).toString('hex'),port:0,sourceRevision:source,relay:{pins,token},
    model:{endpoint:'http://127.0.0.1:'+model.address().port+'/v1/chat/completions'},
    modelVerifier:{async verifyArtifacts(){return {verified:true,modelSha256:LISTING_DEFINITION.modelSha256,imageDigest:LISTING_DEFINITION.imageDigest};},
      async getHeaders(){return {authorization:modelAuthorization};}}};
  host=await startListingHost(config);
  const observations=[];
  const relay=createFulfillmentRelay(env,async(input,init)=>{
    const request=new Request(input,init),url=new URL(request.url);
    assert.equal(url.origin,pins.origin);
    // This test transport reaches the real loopback host while preserving the service protocol.
    const response=await fetch(new Request(host.origin+url.pathname,request)),value=await response.clone().json();
    observations.push({httpStatus:response.status,status:value.status,reasonCode:value.reasonCode,code:value.code,
      tasks:value.tasks?.map(task=>({status:task.status,reasonCode:task.reasonCode}))});
    return response;
  });
  const origin='https://airvio.co',base=origin+'/agentic-commerce-os/fulfillment/';
  async function browser(){
    const response=await fetchLocalFirst(new Request(base+'session'),env,undefined,relay);
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie').split(';')[0],session=await response.json();
    return (operation,body)=>fetchLocalFirst(new Request(base+operation,{method:'POST',
      headers:{cookie,origin,'content-type':'application/json','x-commerce-csrf':session.csrfToken},body:JSON.stringify(body)}),env,undefined,relay);
  }
  const owner=await browser(),peer=await browser();
  const draft={draftId:'12345678-1234-1234-1234-123456789012',revision:1,title:'Ceramic mug',description:'Blue, 300 ml'};
  const accepted=await (await owner('start',draft)).json();assert.match(accepted.runId,/^listing-[a-f0-9]{64}$/);
  let completed;const deadline=Date.now()+10000;
  do{
    completed=await (await owner('status',{runId:accepted.runId})).json();
    if(['completed','blocked'].includes(completed.status))break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }while(Date.now()<deadline);
  assert.equal(completed.status,'completed',JSON.stringify(observations.slice(-3)));assert.equal(executions,1);
  await host.close();host=null;host=await startListingHost(config);
  assert.deepEqual(await (await owner('status',{runId:accepted.runId})).json(),completed);
  assert.equal((await peer('status',{runId:accepted.runId})).status,403);
  assert.equal((await (await owner('start',draft)).json()).runId,accepted.runId);assert.equal(executions,1);
  await host.close();host=null;
  const unavailable=await fetchLocalFirst(new Request(base+'session'),env,undefined,relay);
  assert.equal(unavailable.status,503);assert.equal(unavailable.headers.has('set-cookie'),false);
});
