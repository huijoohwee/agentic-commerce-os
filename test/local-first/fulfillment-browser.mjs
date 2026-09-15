import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createAgentSwarmSqliteStore } from 'agentic-os/agents/sqlite-store';
import { createAgentSwarmWorker } from 'agentic-os/agents/worker';
import { createListingRuntime } from '../../scripts/durable-fulfillment/runtime.mjs';
import { fetchLocalFirst } from '../../src/local-first/worker.ts';
import { stripeFixture } from './stripe-fixture.ts';

/** Local browser contract proof. The browser talks to the actual product handler
 * through a test transport; SQLite owns jobs. This is not a deployed Worker proof. */
export async function checkDurableFulfillment({ browser, url, output, revision }) {
  const directory = fs.mkdtempSync(path.join(output, 'durable-browser-'));
  const store = await createAgentSwarmSqliteStore({ directory });
  const contexts = new Map(), stripe = stripeFixture(), errors = [];
  let executions = 0, networkOffline = false, runtimeAvailable = false;
  const { runtime, product } = createListingRuntime({ stateStore: store,
    authorize: async call => ({ allowed: (contexts.get(call.principalId)?.principalExpiresAt ?? 0) > Date.now(),
      approvalId: 'browser-contract-fixture-only' }),
    executeListing: async () => { executions++;
      return { status: 'completed', effect: 'read-only', output: { text: 'Ceramic mug\n- Blue\n- 300 ml',
        costUsd: null, executor: { type: 'deterministic-fixture' } } };
    },
  });
  const worker = createAgentSwarmWorker({ runtime, stateStore: store, resolveContext: principalId => contexts.get(principalId) });
  const env = { RELEASE_CANDIDATE_SHA: revision, CHECKOUT_MODE: 'sandbox',
    STRIPE_TEST_SECRET_KEY: 'sk_test_' + 'f'.repeat(32), STOREFRONT_SESSION_SECRET: 'browser-durable-contract-fixture-secret-only',
    ASSETS: { fetch: async () => new Response('# Education materials\n\nBuyer interview worksheet') } };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const origin = new URL(url).origin;
  await context.route(target => target.origin === origin && ['/checkout', '/fulfillment/'].some(prefix =>
    target.pathname.startsWith('/agentic-commerce-os' + prefix)), async route => {
    // Intercepted requests otherwise bypass Playwright's offline network emulation.
    if (networkOffline) { await route.abort('internetdisconnected'); return; }
    const incoming = route.request(), method = incoming.method();
    const response = await fetchLocalFirst(new Request(incoming.url(), { method, headers: await incoming.allHeaders(),
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: incoming.postData() }) }), env, stripe.transport, runtimeAvailable ? {
      invoke(operation, input, principal, signal) {
        contexts.set(principal.principalId, principal); return product.invoke(operation, input, principal, signal);
      },
    } : undefined);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  try {
    let page = await context.newPage();
    await page.goto(url + '#vendor-editor'); await expect(page.locator('#offline-ready')).toContainText('Offline access is ready');
    await page.locator('#title').fill('Ceramic mug'); await page.locator('#description').fill('Blue, 300 ml.');
    await page.locator('#save').click(); await expect(page.locator('#save-state')).toHaveText('Saved on this device');
    const backup = () => page.evaluate(async () => {
      const source = document.querySelector('script[type="module"]').src;
      const drafts = await import(new URL('drafts.js', source).href);
      return JSON.parse(await drafts.exportDrafts());
    });
    const baseline = await backup();
    assert.equal(baseline.schema, 'commerce.local-drafts/v2');
    await page.locator('#prepare-listing').click();
    await expect(page.locator('#listing-status')).toContainText('unavailable');
    assert.deepEqual(await backup(), baseline, 'unavailable preparation cannot create v3 or change a draft revision');
    await page.locator('#listing-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    const incoming = { ...baseline.drafts[0], id: '12345678-1234-1234-1234-123456789abc',
      workflow: { runId: null, inputRevision: baseline.drafts[0].revision,
        title: baseline.drafts[0].title, description: baseline.drafts[0].description,
        status: 'queued', text: null, outputDigest: null, reviewedDigest: null } };
    await page.locator('#import').setInputFiles({ name: 'workflow-backup.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schema: 'commerce.local-drafts/v3', drafts: [incoming] })) });
    await expect(page.locator('#status')).toContainText('unavailable');
    assert.deepEqual(await backup(), baseline, 'reader-only import refusal preserves v2 rollback compatibility');
    runtimeAvailable = true;
    await page.locator('#prepare-listing').click(); await expect(page.locator('#listing-status')).toContainText('Job accepted');
    const handle = await page.evaluate(async () => {
      const { listDrafts } = await import('./assets/' + document.querySelector('script[type="module"]').src.split('/assets/')[1].split('/')[0] + '/drafts.js');
      return (await listDrafts())[0].workflow.runId;
    });
    assert.match(handle, /^listing-[a-f0-9]{64}$/u); assert.equal(executions, 0);
    networkOffline = true; await context.setOffline(true); await page.close();
    const executed = await worker.tick(); await worker.tick(); assert.equal(executions, 1, JSON.stringify(executed));
    // Reapply offline emulation after creating the new target and verify the actual browser state.
    await context.setOffline(false); page = await context.newPage(); await context.setOffline(true);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    await page.goto(url + '#vendor-editor');
    await page.locator('#draft-list button').first().click(); await page.locator('#prepare-listing').click();
    await expect(page.locator('#listing-status')).toContainText('Reconnect');
    await expect(page.locator('#listing-checkout')).toBeDisabled();
    networkOffline = false; await context.setOffline(false); await page.locator('#listing-resume').click();
    await expect(page.locator('#listing-output')).toContainText('Ceramic mug');
    await expect(page.locator('#listing-checkout')).toBeDisabled();
    await page.locator('#listing-review').check(); await expect(page.locator('#listing-checkout')).toBeEnabled();
    await page.screenshot({ path: path.join(output, 'durable-listing-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#listing-checkout').click(); await expect(page.locator('#checkout-description')).toContainText('Includes your reviewed listing');
    await expect(page.locator('#checkout-start')).toBeDisabled(); await page.locator('#checkout-confirm').check();
    await page.locator('#checkout-start').click(); await expect(page.locator('#checkout-status')).toContainText('Continue to Stripe');
    assert.equal(stripe.sessions.size, 1); const [orderId] = stripe.sessions.keys(); stripe.complete(orderId);
    await page.locator('#checkout-refresh').click(); await expect(page.locator('#checkout-status')).toContainText('test payment verified');
    // The shared checkout group verifies native downloads over the real local server.
    // Read attachment bodies here: Chromium cancels synthetic route-fulfilled navigation downloads.
    await expect(page.locator('#checkout-receipt')).toBeVisible();
    const receipt = await page.evaluate(async () => {
      const response = await fetch('./checkout/receipt');
      if (!response.ok || !response.headers.get('content-disposition')?.startsWith('attachment;')) throw Error('receipt unavailable');
      return response.json();
    });
    assert.equal(receipt.fulfillment.runId, handle); assert.equal(receipt.realMoney, false);
    await expect(page.locator('#checkout-download')).toBeVisible();
    const delivered = await page.evaluate(async () => {
      const response = await fetch('./checkout/download');
      if (!response.ok || !response.headers.get('content-disposition')?.startsWith('attachment;')) throw Error('listing unavailable');
      return response.text();
    });
    assert.match(delivered, /Your reviewed listing[\s\S]*Ceramic mug/);
    await page.reload(); await expect(page.locator('#checkout-status')).toContainText('test payment verified');
    await page.locator('#checkout-refresh').click();
    assert.equal(stripe.sessions.size, 1); assert.equal(executions, 1); assert.deepEqual(errors, []);
    // A returning seller must not mistake an earlier receipt for a new listing.
    await page.goto(url + '#vendor-editor');
    await page.locator('#draft-list button').first().click();
    await page.locator('#description').fill('Blue, 300 ml. New listing revision.');
    await page.locator('#save').click(); await expect(page.locator('#save-state')).toHaveText('Saved on this device');
    await page.locator('#prepare-listing').click();
    await page.locator('#listing-new').click(); await expect(page.locator('#listing-status')).toContainText('Job accepted');
    await worker.tick(); await worker.tick();
    await page.locator('#listing-resume').click(); await expect(page.locator('#listing-output')).toContainText('Ceramic mug');
    await page.locator('#listing-review').check(); await page.locator('#listing-checkout').click();
    await expect(page.locator('#checkout-status')).toContainText('previous test receipt belongs to a different order');
    await expect(page.locator('#checkout-download')).toBeHidden();
    await expect(page.locator('#checkout-receipt')).toHaveText('Download previous Stripe test receipt ↓');
    await expect(page.locator('#checkout-start')).toBeDisabled();
    await page.locator('#checkout-confirm').check(); await expect(page.locator('#checkout-start')).toBeEnabled();
    await page.locator('#checkout-start').click(); await expect(page.locator('#checkout-status')).toContainText('Continue to Stripe');
    assert.equal(stripe.sessions.size, 2);
    const nextOrderId = [...stripe.sessions.keys()].find(id => id !== orderId); stripe.complete(nextOrderId);
    await page.locator('#checkout-refresh').click(); await expect(page.locator('#checkout-status')).toContainText('test payment verified');
    const nextReceipt = await page.evaluate(async () => (await fetch('./checkout/receipt')).json());
    assert.notEqual(nextReceipt.fulfillment.runId, handle);
    assert.equal(nextReceipt.orderId, nextOrderId); assert.equal(executions, 2);
    const completedBackup = await backup();
    assert.equal(completedBackup.schema, 'commerce.local-drafts/v3');
    runtimeAvailable = false;
    await page.goto(url + '#vendor-editor');
    await page.locator('#draft-list button').first().click(); await page.locator('#prepare-listing').click();
    await expect(page.locator('#listing-status')).toContainText('unavailable');
    await expect(page.locator('#listing-output')).toContainText('Ceramic mug');
    assert.deepEqual(await backup(), completedBackup, 'disabled execution retains readable and exportable v3 results');
    const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
      (await (await caches.open(key)).keys()).map(request => request.url)))).flat());
    assert(cached.every(value => !/\/(?:checkout|fulfillment)\//u.test(new URL(value).pathname)));
    fs.writeFileSync(path.join(output, 'durable-browser-proof.json'), JSON.stringify({ schema: 'commerce.durable-browser-observation/v1',
      productionProof: false, providerAuthority: false, sourceRevision: revision, sourceState: 'candidate-override',
      transport: 'Playwright route to actual product handler', executor: 'deterministic-fixture', payment: 'local-stripe-contract-fixture',
      width: 390, offlineReopen: true, closedBeforeExecution: true, executions, paymentSessions: stripe.sessions.size,
      readerBaseline: { unavailablePreparationPreservesV2: true, unavailableImportPreservesV2: true,
        existingV3ReadableAndExportable: true },
      runId: handle, outputDigest: receipt.fulfillment.outputDigest, realMoney: false, humanReview: 'automated-checkbox-contract-test',
      actualHumanReview: false, hostedPaymentSubmitted: false, observedAt: new Date().toISOString() }, null, 2) + '\n');
    console.log('PASS local durable listing offline/review/receipt contract');
  } catch (error) {
    for (const page of context.pages()) {
      await page.screenshot({ path: path.join(output, 'durable-browser-failure.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(output, 'durable-browser-failure.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
    }
    throw error;
  } finally { await context.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
