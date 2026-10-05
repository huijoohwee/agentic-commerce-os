import {timingSafeEqual} from 'node:crypto';
import {parseListingHostPins,listingHostHeaders,listingHostIdentity,LISTING_HOST_READY_PATH} from '../../src/local-first/fulfillment-relay.ts';
import {sealRunContext} from '../../src/local-first/session.ts';

const equal=(left,right)=>typeof left==='string'&&Buffer.byteLength(left)===Buffer.byteLength(right)
  &&timingSafeEqual(Buffer.from(left),Buffer.from(right));
/** The service credential and transport pins are operator configuration, never browser fields. */
export function createListingHostRelay(config,{sourceRevision,sessionSecret,modelAuthorization,verifyArtifacts}){
  if(config===undefined)return null;
  if(!config||Object.keys(config).sort().join()!=='pins,token')throw Error('listing_relay_config_invalid');
  const pins=parseListingHostPins(config.pins),expected=listingHostHeaders(pins,config.token);
  if(pins.sourceRevision!==sourceRevision||config.token===sessionSecret
    ||modelAuthorization==='Bearer '+config.token)throw Error('listing_relay_identity_invalid');
  const authenticated=headers=>!headers.has('origin')&&!headers.has('cookie')
    &&[...expected].every(([key,value])=>key==='content-type'||equal(headers.get(key),value));
  let probe=null;
  function startProbe(){
    const current={controller:new AbortController(),waiters:new Set(),settled:false};
    probe=current;
    const timer=setTimeout(()=>current.controller.abort(),15000);
    current.controller.signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
    const settle=ok=>{
      current.settled=true;clearTimeout(timer);
      if(probe===current)probe=null;
      for(const finish of [...current.waiters])finish(ok&&!current.controller.signal.aborted?200:503);
    };
    // Retain an aborted flight until its verifier settles: an uncooperative verifier
    // must not allow retries to create concurrent unbounded artifact reads.
    void Promise.resolve().then(()=>{
      current.controller.signal.throwIfAborted();
      return verifyArtifacts({signal:current.controller.signal});
    }).then(()=>settle(true),()=>settle(false));
    return current;
  }
  function observe(signal){
    if(signal.aborted||probe?.controller.signal.aborted)return Promise.resolve(503);
    if(probe?.waiters.size>=4)return Promise.resolve(429);
    const current=probe??startProbe();
    return new Promise(resolve=>{
      const cancel=()=>finish(503);
      const finish=status=>{
        if(!current.waiters.delete(finish))return;
        signal.removeEventListener('abort',cancel);
        current.controller.signal.removeEventListener('abort',cancel);
        resolve(status);
        if(!current.settled&&!current.waiters.size)current.controller.abort();
      };
      current.waiters.add(finish);
      signal.addEventListener('abort',cancel,{once:true});
      current.controller.signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted||current.controller.signal.aborted)cancel();
    });
  }
  return Object.freeze({
    applies(headers){return Object.keys(headers).some(key=>key.startsWith('x-commerce-host-')||key.startsWith('x-commerce-principal-'))
      ||headers.authorization==='Bearer '+config.token;},
    async authenticate(raw){
      const headers=new Headers(raw);if(!authenticated(headers))return null;
      const principalId=headers.get('x-commerce-principal-id'),expiry=headers.get('x-commerce-principal-expires');
      if(!/^commerce-[a-f0-9]{64}$/u.test(principalId??'')||!/^\d{13,16}$/u.test(expiry??''))return null;
      const context={principalId,principalExpiresAt:Number(expiry)};
      try{listingHostHeaders(pins,config.token,context);return sealRunContext(context,sessionSecret);}catch{return null;}
    },
    async ready(request){
      const url=new URL(request.url);if(url.pathname!==LISTING_HOST_READY_PATH)return null;
      const failure=(status,code)=>Response.json({ok:false,code},{status,headers:{'cache-control':'no-store'}});
      if(request.method!=='GET'||url.search)return failure(400,'listing_host_probe_invalid');
      if(!authenticated(request.headers)||request.headers.has('x-commerce-principal-id')
        ||request.headers.has('x-commerce-principal-expires'))return failure(403,'listing_host_probe_forbidden');
      const status=await observe(request.signal);
      if(status!==200)return failure(status,status===429?'listing_host_probe_capacity':'listing_host_unavailable');
      return Response.json(listingHostIdentity(pins),{headers:{'cache-control':'no-store'}});
    },
  });
}
