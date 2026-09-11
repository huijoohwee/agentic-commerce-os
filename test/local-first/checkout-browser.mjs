import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs';
export async function checkSandboxCheckout({ browser, url, output, record, remote }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const network = [], errors = [];
  context.on('request', request => network.push({ url: request.url(), method: request.method() }));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url + '#shop'); await page.getByRole('link', { name: 'Try sandbox checkout' }).click();
    await expect(page.locator('#checkout-status')).toContainText('No real money will move');
    await expect(page.locator('#checkout-start')).toBeDisabled();
    assert(!network.some(request => request.method !== 'GET'));
    await page.locator('#checkout-confirm').check(); await page.locator('#checkout-start').click();
    await expect(page.locator('#checkout-status')).toContainText('Continue to Stripe');
    const hosted = await page.locator('#checkout-continue').getAttribute('href');
    assert.match(hosted, /^https:\/\/checkout\.stripe\.com\/(?:c|g)\/pay\/cs_test_/);
    const identity = (await page.evaluate(async () => (await fetch('./checkout/status')).json())).order;
    assert.equal(identity.realMoney, false); assert.equal(identity.provider, 'stripe');
    assert.equal(await page.evaluate(async () => (await fetch('./checkout/download')).status), 409);
    await page.reload(); await expect(page.locator('#checkout-continue')).toHaveAttribute('href', hosted);
    await page.screenshot({ path: path.join(output, 'sandbox-checkout-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(output, 'sandbox-checkout-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    if (!remote) {
      const control = await context.request.post(new URL('/__stripe-fixture/complete', url).href, { data: identity.orderId });
      assert.equal(control.status(), 200);
      await page.locator('#checkout-refresh').click(); await expect(page.locator('#checkout-status')).toContainText('test payment verified');
      const receiptWait = page.waitForEvent('download'); await page.locator('#checkout-receipt').click();
      const receipt = JSON.parse(fs.readFileSync(await (await receiptWait).path(), 'utf8'));
      assert.equal(receipt.mode, 'sandbox'); assert.equal(receipt.realMoney, false); assert.equal(receipt.chargeMinor, 0);
      assert.equal(receipt.status, 'succeeded');
      const fileWait = page.waitForEvent('download'); await page.locator('#checkout-download').click();
      assert.match(fs.readFileSync(await (await fileWait).path(), 'utf8'), /Buyer interview worksheet/);
      // A separate browser session exercises cancellation without discarding the successful receipt.
      await context.clearCookies(); await page.reload(); await page.locator('#checkout-confirm').check();
      await page.locator('#checkout-start').click(); await expect(page.locator('#checkout-cancel')).toBeVisible();
    }
    await page.locator('#checkout-cancel').click(); await expect(page.locator('#checkout-status')).toContainText('expired or was cancelled');
    await expect(page.locator('#checkout-download')).toBeHidden();
    assert.equal(await page.evaluate(async () => (await fetch('./checkout/download')).status), 409);
    await page.locator('#checkout-reset').click(); await expect(page.locator('#checkout-status')).toContainText('No real money will move');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await context.setOffline(true); await page.reload();
    await expect(page.locator('#checkout-status')).toContainText('Connect');
    await expect(page.locator('#checkout-start')).toBeDisabled(); await expect(page.locator('#checkout-download')).toBeHidden();
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat());
    assert(cached.every(value => !new URL(value).pathname.includes('/checkout/') && !value.endsWith('education-materials.md')));
    assert.deepEqual(errors, []);
    const origin = new URL(url).origin;
    assert(network.every(request => new URL(request.url).origin === origin));
    assert(network.filter(request => request.method !== 'GET').every(request => request.method === 'POST'
      && ['start', 'cancel', 'reset'].some(action => request.url === url + 'checkout/' + action)));
    fs.writeFileSync(path.join(output, 'sandbox-network.json'), JSON.stringify({ realMoney: false,
      provider: remote ? 'stripe-test' : 'local-stripe-contract-fixture', fixtureDeliveryVerified: !remote,
      hostedPaymentSubmitted: false, testSessionId: identity.orderId, testSessionExpired: remote, network }, null, 2) + '\n');
    record(BROWSER_CHECKS.checkout);
  } finally { await context.close(); }
}
