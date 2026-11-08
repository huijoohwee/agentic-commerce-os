import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../src/local-first/worker.ts';
const url='https://store.example/agentic-commerce-os/dashboard-layout', revision='a'.repeat(40);
const send=(method,headers,env={},path='')=>worker.fetch(new Request(url+path,{method,headers}), {RELEASE_CANDIDATE_SHA:revision,...env});

test('selecting Admin never grants write authority, missing bindings stay read only',async()=>{
  assert.deepEqual(await (await send('GET',{})).json(),{revision:0,columns:{},authoring:false});
  const env={DASHBOARD_LAYOUT_SERVICE:{fetch(){throw Error('unexpected upstream request')}}};
  assert.equal((await send('PUT',{referer:url+'#admin'},env)).status,403);
  assert.equal((await send('POST',{origin:'https://other.invalid'},env,'/session')).status,403);
  assert.equal((await send('POST',{authorization:'Bearer '+'b'.repeat(64)}, {},'/session')).status,403);
});
test('public layout reads omit credentials, and bound service rejects stale saves without a redirect',async()=>{
  const env={DASHBOARD_LAYOUT_SERVICE:{async fetch(r){
    assert.equal(r.redirect,'manual');assert.equal(r.headers.get('cookie'),null);
    if(r.method==='GET'){assert.equal(r.headers.get('authorization'),null);return Response.json({revision:2,columns:{shop:2}})}
    return Response.json({error:'stale_revision'},{status:409})
  }}};
  assert.deepEqual((await (await send('GET',{authorization:'Bearer ignored',cookie:'unrelated=private'},env)).json()).columns,{shop:2});
  assert.equal((await send('PUT',{authorization:'Bearer '+'a'.repeat(64),'content-type':'application/json'},env)).status,409);
});
