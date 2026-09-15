import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { waitForReadiness, waitForBrowserDocument } from './readiness.mjs';

const base = 'https://airvio.co/agentic-commerce-os/';
const sha = value => createHash('sha256').update(value).digest('hex');

/** Actual public browser observation: no request interception or fixture runtime. */
export async function createRollbackBrowserObservation({ output }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    serviceWorkers: 'block', acceptDownloads: true });
  let page, retained, requestedRevision;
  const pages = [], documents = [];
  function observePage(value, expectedRevision) {
    const observation = { expectedRevision, accepted: false, errors: [], assets: [] };
    pages.push(observation);
    value.on('pageerror', error => observation.errors.push(error.message));
    value.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === new URL(base).origin && url.pathname.includes('/assets/'))
        observation.assets.push({ url: url.pathname, status: response.status(),
          sourceRevision: response.headers()['x-commerce-source'], expectedRevision });
    });
    return observation;
  }
  async function backup() {
    return page.evaluate(async () => {
      const source = document.querySelector('script[type="module"]').src;
      return JSON.parse(await (await import(new URL('drafts.js', source).href)).exportDrafts());
    });
  }
  async function open(identity) {
    const expectedRevision = identity.revision ?? identity.sourceRevision;
    const previousRevision = requestedRevision ?? null;
    requestedRevision = expectedRevision;
    await waitForReadiness({ url: base + 'readyz', revision: expectedRevision, versionId: identity.versionId });
    let observation;
    await waitForBrowserDocument({ url: base + '#vendor-editor', revision: expectedRevision, previousRevision,
      navigate: async (url, options) => {
        await page?.close();
        page = await context.newPage();
        page.setDefaultTimeout(15000);
        observation = observePage(page, expectedRevision);
        return page.goto(url, { ...options, waitUntil: 'domcontentloaded' });
      }, observe: value => {
        if (observation) observation.accepted = value.matched === true;
        documents.push(value);
      } });
    const module = await page.locator('script[type="module"]').getAttribute('src');
    assert(module.includes('/assets/' + expectedRevision + '/'));
  }
  async function selectRetained() {
    await page.locator('#draft-list button').first().click();
    await page.locator('#prepare-listing').click();
    await expect(page.locator('#listing-output')).toHaveText(retained.text.replaceAll('\n', ''));
  }
  async function complete() {
    const deadline = Date.now() + 120000;
    for (;;) {
      await expect(page.locator('#listing-resume')).toBeEnabled();
      const state = await backup(), flow = state.drafts[0]?.workflow;
      if (flow?.status === 'completed') {
        assert.equal(typeof flow.text, 'string'); assert(flow.text.length > 0);
        assert.equal(sha(flow.text), flow.outputDigest);
        return { state, flow };
      }
      assert(!['blocked', 'canceled'].includes(flow?.status), 'The actual retained job did not complete');
      assert(Date.now() < deadline, 'Actual listing completion deadline');
      await page.waitForTimeout(5000);
      await page.locator('#listing-resume').click();
    }
  }
  function assertAssets() {
    const accepted = pages.filter(value => value.accepted);
    assert(accepted.length > 0);
    for (const value of accepted) {
      assert(value.assets.length > 0);
      for (const asset of value.assets) {
        assert.equal(asset.status, 200); assert.equal(asset.sourceRevision, value.expectedRevision);
      }
      assert.deepEqual(value.errors, []);
    }
  }
  return {
    async prepare(identity) {
      await open(identity);
      await page.locator('#title').fill('Ceramic mug');
      await page.locator('#description').fill('Blue ceramic mug, 300 ml. Describe only these supplied facts.');
      await page.locator('#save').click();
      await expect(page.locator('#save-state')).toHaveText('Saved on this device');
      await page.locator('#prepare-listing').click();
      const { state, flow } = await complete();
      assert.equal(state.schema, 'commerce.local-drafts/v3');
      retained = { state, text: flow.text, runId: flow.runId, outputDigest: flow.outputDigest };
      assertAssets();
      return { runId: retained.runId, outputDigest: retained.outputDigest,
        draftDigest: sha(JSON.stringify(retained.state)), transport: 'actual-public-browser',
        executor: 'pinned-device-host', width: 390, actualHumanReview: false, paymentSubmitted: false };
    },
    async reader(identity) {
      await open(identity); assert.deepEqual(await backup(), retained.state);
      await selectRetained();
      await expect(page.locator('#listing-status')).toContainText('unavailable');
      assert.deepEqual(await backup(), retained.state, 'Reader refusal must preserve the exact v3 draft');
      assertAssets();
      await page.screenshot({ path: path.join(output, 'rollback-retained-reader.png'), fullPage: true });
    },
    async restored(identity) {
      await open(identity); assert.deepEqual(await backup(), retained.state);
      await selectRetained();
      await expect(page.locator('#listing-status')).toContainText('Your listing is ready');
      const { flow } = await complete();
      assert.equal(flow.runId, retained.runId); assert.equal(flow.outputDigest, retained.outputDigest);
      assert.equal(flow.text, retained.text);
      assertAssets();
      await page.screenshot({ path: path.join(output, 'rollback-retained-job-restored.png'), fullPage: true });
    },
    async close() {
      fs.writeFileSync(path.join(output, 'rollback-browser-assets.json'), JSON.stringify({
        pages, documents, requestInterception: false, observedAt: new Date().toISOString(),
      }, null, 2) + '\n');
      await context.close(); await browser.close();
    },
  };
}
