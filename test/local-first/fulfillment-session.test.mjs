import test from 'node:test';import assert from 'node:assert/strict';
import {sealRunContext,readRunContext} from '../../src/local-first/session.ts';
import {handleFulfillment} from '../../src/local-first/fulfillment.ts';
const secret='a'.repeat(64),context={principalId:'commerce-'+'b'.repeat(64),principalExpiresAt:Date.now()+60000};

test('a signed principal resumes under its original session key until expiry',async()=>{
  const sealed=await sealRunContext(context,secret);
  assert.deepEqual(await readRunContext(sealed.principalId,secret),sealed);
  assert.equal(await readRunContext(sealed.principalId,'c'.repeat(64)),null);
  assert.equal(await readRunContext(sealed.principalId.replace('commerce-b','commerce-d'),secret),null);
  assert.equal(await readRunContext(sealed.principalId.replace(String(context.principalExpiresAt),'1000000000000'),secret),null);
  assert(!sealed.principalId.includes(secret));
  await assert.rejects(()=>sealRunContext({...context,principalExpiresAt:Date.now()-1},secret));
});

test('fulfillment obtains its existing signed browser session without configuring checkout',async()=>{
  const url='http://127.0.0.1:5192/agentic-commerce-os/fulfillment/session';
  const runtime={invoke(){throw Error('session endpoint must not start work');}};
  const first=await handleFulfillment(new Request(url),secret,runtime);
  assert.equal(first.status,200);const body=await first.json();assert.equal(body.ok,true);assert.equal(typeof body.csrfToken,'string');
  const cookie=first.headers.get('set-cookie').split(';')[0];
  const again=await handleFulfillment(new Request(url,{headers:{cookie}}),secret,runtime);
  assert.equal((await again.json()).csrfToken,body.csrfToken);
  assert.equal((await handleFulfillment(new Request(url,{headers:{origin:'https://foreign.example'}}),secret,runtime)).status,403);
  assert.equal((await handleFulfillment(new Request(url),secret)).status,503);
});
