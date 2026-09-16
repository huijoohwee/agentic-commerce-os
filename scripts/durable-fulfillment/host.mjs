import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgentSwarmSqliteStore,createAgentToolkitSqliteStore} from 'agentic-os/agents/sqlite-store';
import {startLocalAgentHost} from 'agentic-os/agents/local-host';
import {fetchLocalFirst} from '../../src/local-first/worker.ts';
import {readSession,csrf,sealRunContext,readRunContext} from '../../src/local-first/session.ts';
import {fulfillmentContext} from '../../src/local-first/fulfillment.ts';
import {createListingRuntime} from './runtime.mjs';
import {createListingExecutor} from './executor.mjs';
import {createListingHostRelay} from './relay.mjs';

const defaultAssets=fileURLToPath(new URL('../../public/local-first/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.md':'text/markdown; charset=utf-8'};

function assets(directory){return {async fetch(request){
  const name=new URL(request.url).pathname, path=resolve(directory,'.'+name);
  if(!path.startsWith(directory+'/')||!mime[extname(path)])return new Response(null,{status:404});
  let file;
  try{
    if(await realpath(path)!==path)return new Response(null,{status:404});
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await file.stat();if(!before.isFile()||before.size>=500000)throw Error('asset_bounds');
    const body=await file.readFile(),after=await file.stat();
    if(body.length!==before.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('asset_changed');
    return new Response(body,{headers:{'content-type':mime[extname(path)]}});
  }catch{return new Response(null,{status:503});}finally{await file?.close();}
}};}

/** Explicit device-session composition. Dependency injection is for embedding and
 * tests; the CLI always uses the installed OS host and actual pinned model verifier. */
export async function startListingHost({directory,sessionSecret,model,port=5192,
  sourceRevision,plan,assetDirectory=defaultAssets,stripeTestKey,
  paymentFetch,modelVerifier,hostAdapter=startLocalAgentHost,onEvent=()=>{},relay:relayConfig}={}){
  if(typeof directory!=='string'||typeof sessionSecret!=='string'||sessionSecret.length<32
    ||!Number.isSafeInteger(port)||port<0||port>65535
    ||!/^[a-f0-9]{40}$/u.test(sourceRevision)||plan?.revision!==sourceRevision
    ||stripeTestKey!==undefined&&!/^sk_test_[A-Za-z0-9]{16,}$/u.test(stripeTestKey))throw Error('listing_host_config_invalid');
  const verifier=modelVerifier??(await import('agentic-os/agents/podman-model')).createPodmanModelVerifier(model);
  if(typeof verifier.verifyArtifacts!=='function'||typeof verifier.getHeaders!=='function')throw Error('listing_host_verifier_invalid');
  await verifier.verifyArtifacts({signal:AbortSignal.timeout(15000)});
  const headers=await verifier.getHeaders();
  if(headers.authorization==='Bearer '+sessionSecret||sessionSecret===stripeTestKey)throw Error('listing_host_credentials_reused');
  if(relayConfig&&relayConfig.token===stripeTestKey)throw Error('listing_host_credentials_reused');
  const relay=createListingHostRelay(relayConfig,{sourceRevision,sessionSecret,
    modelAuthorization:headers.authorization,verifyArtifacts:verifier.verifyArtifacts});
  const assetRoot=await realpath(assetDirectory),stateStore=await createAgentSwarmSqliteStore({directory});
  let host,toolkitStore;
  const close=async()=>{try{await host?.close();}finally{toolkitStore?.close();stateStore.close();}};
  try{
    toolkitStore=await createAgentToolkitSqliteStore({directory});
    const {runtime,product}=createListingRuntime({stateStore,mission:{toolkitStore,plan},
      authorize:async call=>({allowed:await readRunContext(call.principalId,sessionSecret)!==null,
        approvalId:'signed-session-local-listing-v1'}),
      executeListing:createListingExecutor({endpoint:model.endpoint,getHeaders:verifier.getHeaders,
        verifyArtifacts:verifier.verifyArtifacts}),
    });
    const boundProduct={async invoke(operation,input,context,signal){
      return product.invoke(operation,input,await sealRunContext(context,sessionSecret),signal);
    }};
    const env={RELEASE_CANDIDATE_SHA:sourceRevision,STOREFRONT_SESSION_SECRET:sessionSecret,
      ...(stripeTestKey?{CHECKOUT_MODE:'sandbox',STRIPE_TEST_SECRET_KEY:stripeTestKey}:{}),ASSETS:assets(assetRoot)};
    host=await hostAdapter({runtime,stateStore,port,concurrency:1,maxRequests:4,
      resolveContext:principalId=>readRunContext(principalId,sessionSecret),onEvent,
      authenticate:async({headers})=>{
        if(relay?.applies(headers))return relay.authenticate(headers);
        const bearer=headers.authorization?.startsWith('Bearer ')&&!headers.origin?headers.authorization.slice(7):null;
        const request=new Request('http://127.0.0.1/',{headers:{cookie:bearer?'__Host-airvio_sandbox='+bearer:headers.cookie??''}});
        const session=await readSession(request,sessionSecret);
        if(!session||!bearer&&headers['x-commerce-csrf']!==await csrf(session,sessionSecret))return null;
        return sealRunContext(await fulfillmentContext(session),sessionSecret);
      },
      application:{prefix:'/agentic-commerce-os',maxInputBytes:16384,maxOutputBytes:499999,
        fetch:async request=>(await relay?.ready(request))??fetchLocalFirst(request,env,paymentFetch,boundProduct)},
    });
    const origin=new URL(host.endpoint).origin;
    // An older OS package must fail startup rather than silently discard the application seam.
    const probe=await fetch(origin+'/agentic-commerce-os/fulfillment/session',{signal:AbortSignal.timeout(5000)});
    if(probe.status!==200||(await probe.json()).ok!==true)throw Error('listing_host_application_unavailable');
    return Object.freeze({origin,endpoint:host.endpoint,availability:'device-session',
      stats:host.stats,close});
  }catch(error){await close();throw error;}
}
