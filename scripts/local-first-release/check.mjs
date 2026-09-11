import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { waitForReadiness } from './readiness.mjs';
import { waitForAssets } from './availability.mjs';
import { checkMerchantLaunch } from '../../test/local-first/merchant-browser.mjs';

const root = process.cwd();
const output = path.resolve(process.env.LOCAL_FIRST_EVIDENCE_DIR || 'node_modules/.cache/local-first-verification');
fs.mkdirSync(output, { recursive: true });
const remote = process.argv.find(arg => arg.startsWith('--base-url='))?.slice(11);
const revision = process.env.CANDIDATE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let runtime, browser;
const checks = [], requests = [], readinessObservations = [], assetObservations = [], responses = [], failures = [];
const pages = [];
function observeContext(context) {
  context.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  context.on('response', response => responses.push({ url: response.url(), status: response.status(),
    contentType: response.headers()['content-type'] }));
  context.on('requestfailed', request => failures.push({ type: 'request', url: request.url(), error: request.failure()?.errorText }));
  context.on('page', page => {
    pages.push(page);
    page.on('pageerror', error => failures.push({ type: 'page', url: page.url(), error: error.message }));
  });
}
const record = name => { checks.push(name); console.log(`PASS ${name}`); };
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
try {
  let base = remote;
  if (!base) {
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    const log = fs.openSync(path.join(output, 'runtime.log'), 'w');
    runtime = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '-c', 'wrangler.local-first.jsonc',
      '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0',
      '--var', `RELEASE_CANDIDATE_SHA:${revision}`, '--persist-to', path.join(output, 'runtime')],
    { cwd: root, stdio: ['ignore', log, log], detached: true });
    fs.closeSync(log);
    const deadline = Date.now() + 60000;
    for (;;) {
      if (runtime.exitCode !== null) throw Error('Local runtime exited; see runtime.log');
      try { if ((await fetch(base + '/agentic-commerce-os/readyz')).ok) break; } catch { /* bounded startup */ }
      if (Date.now() >= deadline) throw Error('Local runtime startup deadline');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const origin = new URL(base).origin, url = origin + '/agentic-commerce-os/';
  assert(['http:', 'https:'].includes(new URL(origin).protocol));
  const readiness = await waitForReadiness({ url: url + 'readyz', revision,
    versionId: process.env.LOCAL_FIRST_EXPECTED_VERSION,
    observe: observation => readinessObservations.push(observation) });
  assert.equal(readiness.profile, 'local-first');
  assert.equal(readiness.sourceRevision, revision); assert.equal(readiness.checkout, 'deferred');
  await waitForAssets({ baseUrl: url, revision, stableMs: remote ? 15000 : 0,
    observe: observation => assetObservations.push(observation) });
  assert.equal((await fetch(origin + '/agentic-commerce-os')).url, url);
  for (const route of ['v1/checkouts/confirm', 'mcp', 'mcp/operator', 'v1/session', 'v1/sync/merge']) {
    const result = await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(result.status, 501); assert.equal((await result.json()).code, 'checkout_deferred');
  }
  record('exact production scope and server mutation refusal');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  observeContext(context);
  const page = await context.newPage();
  const documentResponse = await page.goto(url);
  assert.match(documentResponse.headers()['cache-control'], /(?:^|,\s*)no-transform(?:,|$)/);
  await page.getByText('Offline access is ready.', { exact: false }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByLabel('What are you creating?').fill('My first offer');
  await page.getByLabel('The idea').fill('A useful idea, kept only on this device.');
  await page.getByLabel('Price notes').fill('Decide after feedback');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByText('Saved privately on this device.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('a[href*="agentic-graph"]').getAttribute('rel'), 'noopener noreferrer');
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  record('mobile draft creation, safe canvas link and responsive layout');
  await context.setOffline(true); await page.reload();
  await page.locator('#draft-list button').first().click();
  await expect(page.getByLabel('The idea')).toHaveValue('A useful idea, kept only on this device.');
  await page.getByLabel('The idea').fill('Updated without a connection');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByText('Saved privately on this device.', { exact: true }).waitFor();
  await page.reload(); await page.locator('#draft-list button').first().click();
  await expect(page.getByLabel('The idea')).toHaveValue('Updated without a connection');
  record('offline navigation, editing and durable reload');
  await context.setOffline(false);
  const peer = await context.newPage(); await peer.goto(url); await peer.locator('#draft-list button').first().click();
  await peer.getByLabel('The idea').fill('A stale editor must not overwrite');
  await page.getByLabel('The idea').fill('The first writer wins');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByText('Saved privately on this device.', { exact: true }).waitFor();
  await peer.getByRole('button', { name: 'Save on this device' }).click();
  await peer.getByText('This draft changed in another tab.', { exact: false }).waitFor();
  assert.equal(await peer.getByLabel('The idea').inputValue(), 'A stale editor must not overwrite');
  record('concurrent tabs reject stale overwrites and retain editor text');
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export drafts' }).click();
  const download = await downloadPromise, exported = fs.readFileSync(await download.path());
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
  observeContext(fresh);
  const imported = await fresh.newPage();
  await imported.goto(url); await imported.locator('#import').setInputFiles({ name: 'drafts.json', mimeType: 'application/json', buffer: exported });
  await imported.getByText('Imported 1 draft.', { exact: false }).waitFor();
  await imported.locator('#draft-list button').first().click();
  await expect(imported.getByLabel('The idea')).toHaveValue('The first writer wins');
  const conflict = JSON.parse(exported); conflict.drafts[0].title = 'Conflicting import';
  await imported.locator('#import').setInputFiles({ name: 'conflict.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(conflict)) });
  await imported.getByText('An imported draft conflicts', { exact: false }).waitFor();
  assert.equal(await imported.locator('#draft-count').textContent(), '1');
  record('portable JSON roundtrip and atomic import conflict preservation');
  const payload = JSON.parse(exported); payload.drafts[0].id = '12345678-1234-1234-1234-123456789abc';
  payload.drafts[0].title = '<img src=x onerror="window.injected=true">';
  await imported.locator('#import').setInputFiles({ name: 'plain-text.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await imported.getByText('Imported 1 draft.', { exact: false }).waitFor();
  assert.equal(await imported.locator('#draft-list img').count(), 0);
  assert.equal(await imported.evaluate(() => window.injected), undefined);
  await checkMerchantLaunch({ browser, url, output, observeContext, record });
  assert.deepEqual(failures.filter(failure => failure.type === 'page'), []);
  assert(requests.every(request => request.method === 'GET' && new URL(request.url).origin === origin));
  record('imported text cannot inject markup; no draft or checkout network writes');
  const proof = { schema: 'commerce.local-first-browser-proof/v1', ok: true, sourceRevision: revision,
    origin, checkout: 'deferred', checks, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(output, 'browser-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  fs.writeFileSync(path.join(output, 'asset-observation.json'), JSON.stringify({ sourceRevision: revision, observations: assetObservations }, null, 2) + '\n');
  if (checks.length !== 9) {
    const state = await Promise.all(pages.filter(page => !page.isClosed()).map(async (page, index) => {
      try { await page.screenshot({ path: path.join(output, 'failure-page-' + index + '.png'), fullPage: true, timeout: 5000 });
        return { url: page.url(), text: await page.locator('body').innerText({ timeout: 5000 }) }; }
      catch (error) { return { url: page.url(), error: error.message }; }
    }));
    fs.writeFileSync(path.join(output, 'browser-failure.json'), JSON.stringify({ failures, responses, pages: state }, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(output, 'readiness-observation.json'), JSON.stringify({ sourceRevision: revision, observations: readinessObservations }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'network-observation.json'), JSON.stringify({ sourceRevision: revision, requests, responses, failures }, null, 2) + '\n');
  await browser?.close();
  if (runtime && runtime.exitCode === null) {
    try { process.kill(-runtime.pid, 'SIGTERM'); } catch { /* already exited */ }
    await Promise.race([once(runtime, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (runtime.exitCode === null) { try { process.kill(-runtime.pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
}
