import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { authoredAssets, waitForAssets } from '../../scripts/local-first-release/availability.mjs';
import { renderStorefrontTemplate } from '../../src/local-first/checkout-offer.ts';
import { BROWSER_CHECKS, BROWSER_PROOF_SCHEMA, assertBrowserProof, LIVE_BROWSER_CHECKS,
  LIVE_BROWSER_PROOF_SCHEMA, assertLiveBrowserProof, completeLiveBrowserChecks } from '../../scripts/local-first-release/browser-proof.mjs';
const revision = 'a'.repeat(40), profileDigest = 'b'.repeat(64);
function fixture(checkout = 'live', scope = 'live-read-only') {
  return {schema:LIVE_BROWSER_PROOF_SCHEMA,ok:true,sourceRevision:revision,profileDigest,checkout,scope,
    hostedPaymentSubmitted:false,liveSessionCreated:false,customerRevenueVerified:false,
    provider:scope === 'local-fixture' ? 'local-stripe-contract-fixture' : 'read-only-live',
    checks:[LIVE_BROWSER_CHECKS.identity,LIVE_BROWSER_CHECKS.layout,...(scope === 'local-fixture'
      ? [LIVE_BROWSER_CHECKS.fixture,LIVE_BROWSER_CHECKS.recovery,LIVE_BROWSER_CHECKS.safety] : [LIVE_BROWSER_CHECKS.readOnly])]};
}
test('live proofs bind exact candidate, profile, mode and independent verification scope', () => {
  for (const checkout of ['live','live-reader']) for (const scope of ['live-read-only','local-fixture']) {
    const proof = fixture(checkout,scope), expected = {checkout,scope,profileDigest};
    assert.equal(assertLiveBrowserProof(proof,revision,expected),proof);
    assert.doesNotThrow(() => assertLiveBrowserProof({...proof,checks:[...proof.checks].reverse()},revision,expected));
    assert.throws(() => assertLiveBrowserProof(proof,revision,{...expected,scope:scope === 'local-fixture' ? 'live-read-only' : 'local-fixture'}),/live browser proof/);
    assert.throws(() => assertLiveBrowserProof(proof,revision,{...expected,checkout:checkout === 'live' ? 'live-reader' : 'live'}),/live browser proof/);
    assert.throws(() => assertLiveBrowserProof(proof,revision,{...expected,profileDigest:'c'.repeat(64)}),/live browser proof/);
  }
});
test('live proof refuses omitted expectations, partial or substituted groups and money claims', () => {
  const proof=fixture(), expected={checkout:'live',scope:'live-read-only',profileDigest};
  for (const value of [null,{}, {...proof,schema:BROWSER_PROOF_SCHEMA},{...proof,ok:false},
    {...proof,sourceRevision:'c'.repeat(40)},{...proof,provider:'stripe-live'},
    ...['hostedPaymentSubmitted','liveSessionCreated','customerRevenueVerified'].flatMap(key => [{...proof,[key]:true},{...proof,[key]:undefined}]),
    ...[undefined,[],proof.checks.slice(1),[...proof.checks,'unknown'],[...proof.checks.slice(1),proof.checks[1]],
      [...proof.checks.slice(1),'unknown']].map(checks => ({...proof,checks}))]) {
    assert.throws(() => assertLiveBrowserProof(value,revision,expected),/live browser proof/);
  }
  assert.throws(() => assertLiveBrowserProof(proof,revision),/live browser proof/);
  assert.throws(() => assertLiveBrowserProof(proof,'',expected),/live browser proof/);
  assert.equal(completeLiveBrowserChecks(proof.checks,'unknown'),false);
});
test('live and sandbox proof schemas cannot satisfy one another', () => {
  const sandbox={schema:BROWSER_PROOF_SCHEMA,ok:true,sourceRevision:revision,checkout:'sandbox',checks:Object.values(BROWSER_CHECKS)};
  assert.equal(assertBrowserProof(sandbox,revision),sandbox);
  assert.throws(() => assertBrowserProof(fixture(),revision),/browser proof/);
  assert.throws(() => assertLiveBrowserProof(sandbox,revision,{checkout:'live',scope:'live-read-only',profileDigest}),/live browser proof/);
});

function modePropagation(handler, overrides = {}) {
  const template=fs.readFileSync('public/local-first/index.html','utf8'),observations=[];
  const reader=renderStorefrontTemplate(template,revision,'live-reader'),live=renderStorefrontTemplate(template,revision,'live');
  let clock=0;
  return {observations,elapsed:()=>clock,run:()=>waitForAssets({baseUrl:'https://airvio.co/agentic-commerce-os/',revision,checkout:'live',
    assets:authoredAssets(revision,'live').filter(asset => asset.path === ''),
    previous:{sourceRevision:revision,workerVersionId:'11111111-1111-1111-1111-111111111111',checkout:'live-reader'},
    timeoutMs:3000,intervalMs:1000,stableMs:1000,now:()=>clock,sleep:async delay=>{clock+=delay;},
    observe:value=>observations.push(value),fetchImpl:async()=>new Response(handler({clock,reader,live}),{headers:{
      'content-type':'text/html; charset=utf-8','cache-control':'no-store, no-transform','x-commerce-source':revision}}),...overrides})};
}
test('same-source reader bytes retry until exact live bytes meet the full stability window', async () => {
  const value=modePropagation(({clock,reader,live})=>clock===0 ? reader : live),result=await value.run();
  assert.equal(value.elapsed(),2000);assert.equal(result.stableForMs,1000);
  assert.equal(value.observations[0].assets[0].error,'asset_checkout_not_converged');
  assert.equal(value.observations[0].assets[0].matched,false);
  assert.equal(result.assets[0].matched,true);
});
test('known predecessor identity cannot authorize unknown document bytes or absent predecessor proof', async () => {
  const corrupt=modePropagation(({reader})=>reader+'changed');
  await assert.rejects(corrupt.run(),/asset_integrity_mismatch/);assert.equal(corrupt.elapsed(),0);
  const unbound=modePropagation(({reader})=>reader,{previous:null});
  await assert.rejects(unbound.run(),/asset_integrity_mismatch/);assert.equal(unbound.elapsed(),0);
});
test('persistent predecessor bytes never satisfy live asset readiness', async () => {
  const value=modePropagation(({reader})=>reader);
  await assert.rejects(value.run(),/asset_convergence_deadline/);assert.equal(value.elapsed(),3000);
  assert(value.observations.every(row=>row.assets[0].matched===false && row.assets[0].error==='asset_checkout_not_converged'));
});
