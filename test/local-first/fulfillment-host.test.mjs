import { listingPlanFixture } from './fulfillment-fixture.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createAgentSwarmWorker} from 'agentic-os/agents/worker';
import {startListingHost} from '../../scripts/durable-fulfillment/host.mjs';
import {LISTING_DEFINITION} from '../../src/local-first/fulfillment-definition.ts';

async function listen(handler){const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};}

test('product host signs durable ownership, reauthorizes after restart and replays one listing',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'listing-host-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let executions=0;const modelAuthorization='Bearer '+randomBytes(32).toString('hex');
  const modelServer=await listen(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
    assert.equal(req.headers.authorization,modelAuthorization);assert.equal(JSON.parse(raw).max_tokens,LISTING_DEFINITION.maxTokens);
    executions++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'sha256:'+LISTING_DEFINITION.modelSha256,
      choices:[{message:{content:'Ceramic mug\n- Blue\n- 300 ml'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8}}));});
  t.after(()=>modelServer.close());
  let worker,authentication;
  // The OS owns ingress/queue tests. This fixture exposes the product seam and its actual runtime.
  const hostAdapter=async options=>{
    worker=createAgentSwarmWorker(options);authentication=options.authenticate;
    const transport=await listen(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;
      const result=await options.application.fetch(new Request(transport.origin+req.url,{method:req.method,headers:req.headers,
        ...(['GET','HEAD'].includes(req.method)?{}:{body})}));
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
    }catch{res.writeHead(500);res.end();}});
    return {endpoint:transport.origin+'/api/agent-swarm/',stats:()=>({fixture:true}),close:transport.close};
  };
  const config={directory,sourceRevision:listingPlanFixture().revision,plan:listingPlanFixture(),sessionSecret:randomBytes(32).toString('hex'),port:0,model:{endpoint:modelServer.origin+'/v1/chat/completions'},hostAdapter,
    modelVerifier:{verifyArtifacts:async()=>({verified:true,modelSha256:LISTING_DEFINITION.modelSha256,imageDigest:LISTING_DEFINITION.imageDigest}),
      getHeaders:async()=>({authorization:modelAuthorization})}};
  await assert.rejects(startListingHost({...config,sourceRevision:'b'.repeat(40)}),/listing_host_config_invalid/);
  let host=await startListingHost(config);t.after(async()=>{if(host)await host.close();});
  const sessionResponse=await fetch(host.origin+'/agentic-commerce-os/fulfillment/session');
  const cookie=sessionResponse.headers.get('set-cookie').split(';')[0],session=await sessionResponse.json();
  const draft={draftId:'12345678-1234-1234-1234-123456789012',revision:1,title:'Ceramic mug',description:'Blue, 300 ml'};
  const send=async(operation,body,credentials=cookie)=>fetch(host.origin+'/agentic-commerce-os/fulfillment/'+operation,{method:'POST',
    headers:{cookie:credentials,origin:host.origin,'content-type':'application/json','x-commerce-csrf':session.csrfToken},body:JSON.stringify(body)});
  const first=await send('start',draft),accepted=await first.json();assert.equal(first.status,202);assert.equal(executions,0);
  const context=await authentication({headers:{cookie,origin:host.origin,'x-commerce-csrf':session.csrfToken}});
  assert.match(context.principalId,/^job:commerce-/);assert.equal(await authentication({headers:{cookie,origin:host.origin}}),null);
  assert.deepEqual(await authentication({headers:{authorization:'Bearer '+cookie.slice(cookie.indexOf('=')+1)}}),context);
  await host.close();host=null;host=await startListingHost(config);
  await worker.tick();await worker.tick();assert.equal(executions,1);
  const completed=await (await send('status',{runId:accepted.runId})).json();
  assert.equal(completed.status,'completed');assert.match(completed.text,/Ceramic mug/);
  assert.equal((await (await send('start',draft)).json()).runId,accepted.runId);assert.equal(executions,1);
  assert.equal((await send('status',{runId:accepted.runId},'__Host-airvio_sandbox=forged')).status,401);
  const query=await (await send('query',{})).json();assert.equal(query.schema,'agent-toolkit-query/v1');
  assert.equal(query.items[0].runId,accepted.runId);
  const trace=await (await send('trace',{runId:accepted.runId})).json();
  assert.equal(trace.context.taskId,accepted.runId);assert.equal(trace.profileSummary.tokenUsage.promptTokens,10);
  assert.equal(trace.resources.used.inputTokens,10);assert.equal(trace.resources.status,'known');
  const evaluated=await (await send('evaluate',{runId:accepted.runId,operationId:'host-contract',
    evidence:{id:'actual-listing',digest:trace.subjectDigest},subjectDigest:trace.subjectDigest})).json();
  assert.equal(evaluated.evaluation.status,'reported');assert.equal(evaluated.evaluation.score,1);
  assert.equal((await fetch(host.origin+'/agentic-commerce-os/checkout')).status,503);
});
