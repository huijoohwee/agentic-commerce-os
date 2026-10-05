import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { LIVE_CHECKOUT_OFFER, LIVE_CHECKOUT_PROFILE_SHA256 } from '../../src/local-first/checkout-offer.ts';
import { LIVE_BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs';

/** The remote branch cannot create a Session or navigate to a payment provider. */
export async function checkLiveCheckout({browser, url, output, record, remote, checkout, revision, profileDigest, readiness}) {
  assert(['live','live-reader'].includes(checkout));
  assert.equal(profileDigest,LIVE_CHECKOUT_PROFILE_SHA256);
  assert.equal(readiness.checkout,checkout);assert.equal(readiness.sourceRevision,revision);
  const origin=new URL(url).origin, contexts=[], network=[], errors=[], blocked=[];
  if (!remote) assert(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname),'Fixture effects require a loopback runtime');
  async function context() {
    const value=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true,
      serviceWorkers:remote ? 'block' : 'allow'});contexts.push(value);
    // Enforce read-only before an unexpected UI request can reach the network.
    await value.route('**/*',async route => {
      const request=route.request();
      if (new URL(request.url()).origin !== origin || remote && request.method() !== 'GET') {
        blocked.push({url:request.url(),method:request.method()});return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    value.on('request',request => network.push({url:request.url(),method:request.method()}));
    value.on('page',page => page.on('pageerror',error => errors.push(error.message)));
    return value;
  }
  async function open(value) {
    const page=await value.newPage(), response=await page.goto(url+'#checkout');
    assert.equal(response.status(),200);assert.equal(response.headers()['x-commerce-source'],revision);
    assert.equal(response.headers()['x-commerce-profile'],'local-first');
    assert.match(response.headers()['cache-control'],/(?:^|,\s*)no-transform(?:,|$)/);
    await expect(page.locator('meta[name="commerce-checkout-mode"]')).toHaveAttribute('content',checkout);
    await expect(page.locator('#checkout-status')).toContainText(checkout === 'live' ? 'Review the education materials' : 'New purchases are paused');
    await expect(page.locator('#checkout-recovery')).toBeVisible();
    await expect(page.locator('#checkout-continue')).toBeHidden();
    return page;
  }
  async function downloaded(page,selector) {
    const pending=page.waitForEvent('download');await page.locator(selector).click();
    const file=await pending;assert.equal(await file.failure(),null);return fs.readFileSync(await file.path());
  }
  async function restore(page,bytes) {
    await page.locator('#checkout-restore-recovery').setInputFiles({name:'purchase-recovery.json',mimeType:'application/json',buffer:bytes});
  }
  try {
    const primary=await context(),page=await open(primary);
    const intent=await page.evaluate(async () => (await fetch('./checkout',{cache:'no-store'})).json());
    assert.equal(intent.ok,true);assert.equal(intent.mode,'live');assert.equal(intent.realMoney,true);
    assert.equal(intent.salesEnabled,checkout === 'live');assert.equal(intent.order,null);
    for (const field of ['id','productId','amountMinor','currency','assetDigest']) assert.equal(intent.offer[field],LIVE_CHECKOUT_OFFER[field]);
    record(LIVE_BROWSER_CHECKS.identity);
    await expect(page.locator('#checkout-price')).toContainText('SGD');
    await expect(page.locator('#checkout-terms')).toContainText('One-time SGD 8');
    await expect(page.locator('#checkout-recovery')).toContainText('private');
    await expect(page.locator('#checkout-download')).toBeHidden();
    if (checkout === 'live') {
      await expect(page.locator('#checkout-confirm')).not.toBeChecked();
      await expect(page.locator('#checkout-start')).toBeDisabled();
      await expect(page.locator('#checkout-confirm-copy')).toContainText('real payment');
    } else await expect(page.locator('#checkout-start')).toBeHidden();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    const cards=page.locator('#checkout .editor-layout > .panel');
    const mobileOffer=await cards.nth(0).boundingBox(),mobilePayment=await cards.nth(1).boundingBox();
    assert(mobilePayment.y >= mobileOffer.y+mobileOffer.height,'Mobile checkout cards must stack');
    await page.screenshot({path:path.join(output,'live-checkout-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    const desktopOffer=await cards.nth(0).boundingBox(),desktopPayment=await cards.nth(1).boundingBox();
    assert(desktopOffer.width >= 360 && desktopPayment.width >= 360 && Math.abs(desktopOffer.y-desktopPayment.y) < 2,
      'Desktop purchase details require readable, balanced columns');
    await page.screenshot({path:path.join(output,'live-checkout-desktop.png'),fullPage:true});
    await page.locator('#checkout-restore-recovery').focus();
    await expect(page.locator('label[for="checkout-restore-recovery"]')).toHaveCSS('outline-style','solid');
    await page.setViewportSize({width:390,height:844});
    record(LIVE_BROWSER_CHECKS.layout);
    if (remote) {
      assert(network.every(request => request.method === 'GET' && new URL(request.url).origin === origin));
      assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
      record(LIVE_BROWSER_CHECKS.readOnly);return;
    }
    let recoveryBytes,orderId;
    if (checkout === 'live') {
      await page.locator('#checkout-confirm').check();await page.locator('#checkout-start').click();
      await expect(page.locator('#checkout-status')).toContainText('Save your private recovery file');
      await expect(page.locator('#checkout-continue')).toBeHidden();
      const pending=await page.evaluate(async () => (await fetch('./checkout/status')).json());
      orderId=pending.order.orderId;assert.equal(pending.order.downloadReady,false);assert.equal(pending.order.chargeMinor,0);
      assert.equal(await page.evaluate(async () => (await fetch('./checkout/download')).status),409);
      recoveryBytes=await downloaded(page,'#checkout-save-recovery');
      await expect(page.locator('#checkout-continue')).toHaveAttribute('href',new RegExp('^https://checkout\\.stripe\\.com/(?:c|g)/pay/'+orderId+'(?:#|$)'));
      const complete=await primary.request.post(new URL('/__stripe-fixture/complete',url).href,{data:orderId});
      assert.equal(complete.status(),200);
      await page.locator('#checkout-refresh').click();await expect(page.locator('#checkout-download')).toBeVisible();
    } else {
      // Seed an existing fixture purchase; the reader itself cannot start sales.
      const seeded=await primary.request.post(new URL('/__stripe-fixture/seed-paid',url).href,{data:{}});
      assert.equal(seeded.status(),200);const body=await seeded.json();orderId=body.orderId;
      recoveryBytes=Buffer.from(JSON.stringify(body.recovery));
      await restore(page,recoveryBytes);await expect(page.locator('#checkout-recovery-status')).toContainText('Recovery file restored');
      await expect(page.locator('#checkout-start')).toBeHidden();
    }
    const recovery=JSON.parse(recoveryBytes);assert.equal(recovery.schema,'commerce.live-checkout-recovery/v1');
    assert.equal(recovery.offerProfile,profileDigest);assert.equal(typeof recovery.recoveryToken,'string');
    assert(recovery.expiresAt > Date.now());
    const receipt=JSON.parse(await downloaded(page,'#checkout-receipt'));
    assert.equal(receipt.schema,'commerce.stripe-live-receipt/v1');assert.equal(receipt.orderId,orderId);
    assert.equal(receipt.mode,'live');assert.equal(receipt.chargeMinor,800);assert.equal(receipt.status,'succeeded');
    assert.equal(receipt.downloadReady,true);assert.equal(receipt.profileDigest,profileDigest);
    assert(!JSON.stringify(receipt).includes(recovery.recoveryToken));
    const asset=await downloaded(page,'#checkout-download');
    assert.equal(createHash('sha256').update(asset).digest('hex'),LIVE_CHECKOUT_OFFER.assetDigest);
    record(LIVE_BROWSER_CHECKS.fixture);
    const peer=await context(),restored=await open(peer);
    await restore(restored,Buffer.from(JSON.stringify({...recovery,recoveryToken:recovery.recoveryToken+'x'})));
    await expect(restored.locator('#checkout-status')).toContainText('Recovery could not be verified');
    await expect(restored.locator('#checkout-download')).toBeHidden();
    await restore(restored,recoveryBytes);
    await expect(restored.locator('#checkout-recovery-status')).toContainText('Recovery file restored');
    assert.equal(createHash('sha256').update(await downloaded(restored,'#checkout-download')).digest('hex'),LIVE_CHECKOUT_OFFER.assetDigest);
    const recovered=await restored.evaluate(async () => (await fetch('./checkout/status')).json());
    assert.equal(recovered.order.orderId,orderId);assert.equal(recovered.order.downloadReady,true);
    assert(!network.some(request => request.url.includes(recovery.recoveryToken)));
    for (const document of [page,restored]) assert(!(await document.evaluate(() =>
      JSON.stringify({...localStorage,...sessionStorage}))).includes(recovery.recoveryToken));
    record(LIVE_BROWSER_CHECKS.recovery);
    await restored.evaluate(() => navigator.serviceWorker.ready);
    await peer.setOffline(true);await restored.reload();
    await expect(restored.locator('#checkout-status')).toContainText('Connect');
    await expect(restored.locator('#checkout-download')).toBeHidden();
    await expect(restored.locator('#checkout-continue')).toBeHidden();
    const cached=await restored.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
      (await (await caches.open(key)).keys()).map(request => request.url)))).flat());
    assert(cached.every(value => !/\/checkout(?:\/|$)/.test(new URL(value).pathname) && !value.endsWith('education-materials.md')));
    assert(network.every(request => new URL(request.url).origin === origin));
    assert(network.filter(request => request.method !== 'GET').every(request => request.method === 'POST'
      && ['start','recover','recovery'].some(action => request.url === url+'checkout/'+action)));
    assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);record(LIVE_BROWSER_CHECKS.safety);
  } finally {
    fs.writeFileSync(path.join(output,'live-checkout-network.json'),JSON.stringify({checkout,
      scope:remote ? 'live-read-only' : 'local-fixture',provider:remote ? 'read-only-live' : 'local-stripe-contract-fixture',
      hostedPaymentSubmitted:false,liveSessionCreated:false,customerRevenueVerified:false,network,blocked,errors},null,2)+'\n');
    for (const value of contexts) await value.close();
  }
}
