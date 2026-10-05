import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { checkoutOffer, checkoutProfileDigest } from '../../src/local-first/checkout-offer.ts';
import { LIVE_BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs';

/** The remote branch cannot create a Session or navigate to a payment provider. */
export async function checkLiveCheckout({browser, url, output, record, remote, checkout, revision, profileDigest, readiness}) {
  assert(['test','live','live-reader'].includes(checkout));
  assert(!remote || checkout !== 'test','Hosted test effects need their separate provider harness');
  const mode=checkout === 'test' ? 'test' : 'live', live=mode === 'live', sales=checkout !== 'live-reader';
  const offer=checkoutOffer(mode);
  assert.equal(profileDigest,checkoutProfileDigest(mode));
  assert.equal(readiness.checkout,checkout);assert.equal(readiness.sourceRevision,revision);
  const origin=new URL(url).origin, contexts=[], network=[], errors=[], blocked=[];
  let buyerContextClosedBeforeEvent=false, signedWebhookVerified=false;
  const recordCheck=key => record(checkout === 'test' ? LIVE_BROWSER_CHECKS[key].replace('live offer profile','test offer profile') : LIVE_BROWSER_CHECKS[key]);
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
    await expect(page.locator('#checkout-status')).toContainText(sales ? 'Review the education materials' : 'New purchases are paused');
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
    assert.equal(intent.ok,true);assert.equal(intent.mode,mode);assert.equal(intent.realMoney,live);
    assert.equal(intent.salesEnabled,sales);assert.equal(intent.order,null);
    for (const field of ['id','productId','amountMinor','currency','assetDigest']) assert.equal(intent.offer[field],offer[field]);
    recordCheck('identity');
    await expect(page.locator('#checkout-price')).toContainText('SGD');
    await expect(page.locator('#checkout-terms')).toContainText(live ? 'One-time SGD 8' : 'no real charge');
    await expect(page.locator('#checkout-recovery')).toContainText('private');
    await expect(page.locator('#checkout-download')).toBeHidden();
    if (sales) {
      await expect(page.locator('#checkout-confirm')).not.toBeChecked();
      await expect(page.locator('#checkout-start')).toBeDisabled();
      await expect(page.locator('#checkout-confirm-copy')).toContainText(live ? 'real payment' : 'No real money');
    } else await expect(page.locator('#checkout-start')).toBeHidden();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    const cards=page.locator('#checkout .editor-layout > .panel');
    const mobileOffer=await cards.nth(0).boundingBox(),mobilePayment=await cards.nth(1).boundingBox();
    assert(mobilePayment.y >= mobileOffer.y+mobileOffer.height,'Mobile checkout cards must stack');
    await page.screenshot({path:path.join(output,(live ? 'live' : 'test')+'-checkout-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    const desktopOffer=await cards.nth(0).boundingBox(),desktopPayment=await cards.nth(1).boundingBox();
    assert(desktopOffer.width >= 360 && desktopPayment.width >= 360 && Math.abs(desktopOffer.y-desktopPayment.y) < 2,
      'Desktop purchase details require readable, balanced columns');
    await page.screenshot({path:path.join(output,(live ? 'live' : 'test')+'-checkout-desktop.png'),fullPage:true});
    await page.locator('#checkout-restore-recovery').focus();
    await expect(page.locator('label[for="checkout-restore-recovery"]')).toHaveCSS('outline-style','solid');
    await page.setViewportSize({width:390,height:844});
    recordCheck('layout');
    if (remote) {
      assert(network.every(request => request.method === 'GET' && new URL(request.url).origin === origin));
      assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
      recordCheck('readOnly');return;
    }
    let recoveryBytes,orderId;
    if (sales) {
      await page.locator('#checkout-confirm').check();await page.locator('#checkout-start').click();
      await expect(page.locator('#checkout-status')).toContainText('Save your private recovery file');
      await expect(page.locator('#checkout-continue')).toBeHidden();
      const pending=await page.evaluate(async () => (await fetch('./checkout/status')).json());
      orderId=pending.order.orderId;assert.equal(pending.order.downloadReady,false);assert.equal(pending.order.chargeMinor,0);
      assert.equal(await page.evaluate(async () => (await fetch('./checkout/download')).status),409);
      recoveryBytes=await downloaded(page,'#checkout-save-recovery');
      await expect(page.locator('#checkout-continue')).toHaveAttribute('href',new RegExp('^https://checkout\\.stripe\\.com/(?:c|g)/pay/'+orderId+'(?:#|$)'));
      const token=JSON.parse(recoveryBytes).recoveryToken;
      assert(!(await page.evaluate(() => JSON.stringify({...localStorage,...sessionStorage}))).includes(token));
      await primary.close();buyerContextClosedBeforeEvent=true;
      const complete=await fetch(new URL('/__stripe-fixture/complete',url),{method:'POST',body:orderId,redirect:'error'});
      assert.equal(complete.status,200);signedWebhookVerified=(await complete.json()).webhookVerified === true;
    } else {
      // Seed a simulated existing purchase with no buyer context; the reader cannot start sales.
      await primary.close();buyerContextClosedBeforeEvent=true;
      const seeded=await fetch(new URL('/__stripe-fixture/seed-paid',url),{method:'POST',body:'{}',redirect:'error'});
      assert.equal(seeded.status,200);const body=await seeded.json();orderId=body.orderId;
      signedWebhookVerified=body.webhookVerified === true;recoveryBytes=Buffer.from(JSON.stringify(body.recovery));
    }
    assert.equal(signedWebhookVerified,true);assert.equal(buyerContextClosedBeforeEvent,true);
    const recovery=JSON.parse(recoveryBytes);assert.equal(recovery.schema,`commerce.${mode}-checkout-recovery/v1`);
    assert.equal(recovery.offerProfile,profileDigest);assert.equal(typeof recovery.recoveryToken,'string');
    assert(recovery.expiresAt > Date.now());
    const peer=await context(),restored=await open(peer);
    await restore(restored,Buffer.from(JSON.stringify({...recovery,recoveryToken:recovery.recoveryToken+'x'})));
    await expect(restored.locator('#checkout-status')).toContainText('Recovery could not be verified');
    await expect(restored.locator('#checkout-download')).toBeHidden();
    await restore(restored,recoveryBytes);
    await expect(restored.locator('#checkout-recovery-status')).toContainText('Recovery file restored');
    const receipt=JSON.parse(await downloaded(restored,'#checkout-receipt'));
    assert.equal(receipt.schema,`commerce.stripe-${mode}-receipt/v1`);assert.equal(receipt.orderId,orderId);
    assert.equal(receipt.mode,mode);assert.equal(receipt.realMoney,live);assert.equal(receipt.chargeMinor,live ? 800 : 0);
    if (!live) assert.equal(receipt.testAmountMinor,800);
    assert.equal(receipt.status,'succeeded');
    assert.equal(receipt.downloadReady,true);assert.equal(receipt.profileDigest,profileDigest);
    assert(!JSON.stringify(receipt).includes(recovery.recoveryToken));
    const asset=await downloaded(restored,'#checkout-download');
    assert.equal(createHash('sha256').update(asset).digest('hex'),offer.assetDigest);
    recordCheck('fixture');
    const recovered=await restored.evaluate(async () => (await fetch('./checkout/status')).json());
    assert.equal(recovered.order.orderId,orderId);assert.equal(recovered.order.downloadReady,true);
    assert(!network.some(request => request.url.includes(recovery.recoveryToken)));
    assert(!(await restored.evaluate(() => JSON.stringify({...localStorage,...sessionStorage}))).includes(recovery.recoveryToken));
    recordCheck('recovery');
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
    assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);recordCheck('safety');
  } finally {
    fs.writeFileSync(path.join(output,'live-checkout-network.json'),JSON.stringify({checkout,buyerContextClosedBeforeEvent,signedWebhookVerified,
      scope:remote ? 'live-read-only' : 'local-fixture',provider:remote ? 'read-only-live' : 'local-stripe-contract-fixture',
      hostedPaymentSubmitted:false,liveSessionCreated:false,customerRevenueVerified:false,network,blocked,errors},null,2)+'\n');
    for (const value of contexts) await value.close();
  }
}
