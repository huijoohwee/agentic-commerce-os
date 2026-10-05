#!/usr/bin/env node
/** Explicit Stripe hosted-test rehearsal. Never deploys or accepts live credentials. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { TEST_CHECKOUT_OFFER as OFFER, TEST_CHECKOUT_PROFILE as PROFILE,
  TEST_CHECKOUT_PROFILE_SHA256 as PROFILE_DIGEST } from '../../src/local-first/checkout-offer.ts';
import { stripeClient, stripeTestKey } from '../../src/local-first/stripe-checkout.ts';
import { isHttpFailure, readJsonResponse } from '../../src/shared/http.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const prefix = '/agentic-commerce-os', statusPath = '/__hosted-test/status';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function privateDirectory(value) {
  const directory = path.resolve(value), stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077), 'private_directory_required');
  assert.equal(fs.realpathSync(directory), directory, 'private_directory_symlink_refused');
  return directory;
}
function readPrivate(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.size < 1000000, 'private_file_required');
  return fs.readFileSync(file, 'utf8');
}
function writePrivate(file, value, exclusive = false) {
  if (fs.existsSync(file)) readPrivate(file);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
}
function credentials(directory) {
  const key = readPrivate(path.join(directory, 'stripe-test-key')).trim();
  const webhook = readPrivate(path.join(directory, 'stripe-webhook-secret')).trim();
  assert(stripeTestKey(key), 'stripe_test_key_required');
  assert(/^whsec_[A-Za-z0-9]{20,}$/u.test(webhook), 'test_webhook_secret_required');
  return { key, webhook };
}
function sourceSnapshot() {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'public', 'package.json', 'package-lock.json', 'wrangler.local-first.jsonc'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  files.push('scripts/local-first-release/hosted-test.mjs'); files.sort();
  assert(files.length > 0 && files.length < 2000, 'source_inventory_invalid');
  let bytes = 0;
  const entries = files.map(file => {
    const content = fs.readFileSync(path.join(root, file)); bytes += content.length;
    return { path: file, bytes: content.length, sha256: hash(content) };
  });
  assert(bytes < 16 * 1024 * 1024, 'source_inventory_too_large');
  return { baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    actualSourceDigest: hash(JSON.stringify(entries)), files: files.length, bytes };
}
function currentRun(directory) {
  const run = JSON.parse(readPrivate(path.join(directory, 'current-run.json')));
  assert(path.dirname(run.directory) === directory, 'run_directory_invalid'); privateDirectory(run.directory);
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(run.origin), 'loopback_required');
  assert.equal(run.profileDigest, PROFILE_DIGEST, 'test_profile_changed');
  assert.deepEqual(run.source, sourceSnapshot(), 'source_changed_since_serve');
  return run;
}
async function state(run) {
  const response = await fetch(run.origin + statusPath, { signal: AbortSignal.timeout(5000) });
  assert(response.ok, 'test_runtime_unavailable'); const value = await response.json();
  assert.equal(value.runId, run.runId, 'test_runtime_identity_changed');
  assert(value.listenerAlive && value.workerAlive && value.ready, 'test_runtime_not_ready');
  return value;
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function providerGet(key, resource) {
  const response = await fetch('https://api.stripe.com/v1/' + resource, { headers: {
    authorization: 'Bearer ' + key, 'stripe-version': '2026-06-24.dahlia' },
    signal: AbortSignal.timeout(15000), redirect: 'manual' });
  const value = await readJsonResponse(response, 262144);
  assert(response.ok && !isHttpFailure(value) && value && typeof value === 'object', 'test_provider_read_failed');
  return value;
}
async function serve(directory, cli) {
  assert(!fs.existsSync(path.join(directory,'pending-checkout.json')), 'reconcile_pending_checkout_before_new_run');
  assert(cli && path.isAbsolute(cli) && fs.statSync(cli).isFile(), 'stripe_cli_path_required');
  const { key, webhook } = credentials(directory), source = sourceSnapshot();
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + randomBytes(4).toString('hex');
  const runDirectory = path.join(directory, runId); fs.mkdirSync(runDirectory, { mode: 0o700 });
  const workerPort = await freePort(), children = [], requests = [];
  const observed = { runId, ready: false, returnBlocked: 0, requests };
  let worker, listener, proxy;
  const cleanup = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); proxy?.close(); };
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  function child(binary, args, logName, env = process.env) {
    const log = path.join(runDirectory, logName), fd = fs.openSync(log, 'wx', 0o600);
    const result = spawn(binary, args, { cwd: root, env, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
    result.on('error', () => { observed.ready = false; }); children.push(result); return result;
  }
  try {
    const template = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.local-first.jsonc'), 'utf8'));
    const config = { ...template, name: 'commerce-hosted-test-local', main: path.resolve(root, template.main),
      workers_dev: false, preview_urls: false,
      assets: { ...template.assets, directory: path.resolve(root, template.assets.directory) },
      vars: { CHECKOUT_MODE: 'test', CHECKOUT_TEST_PROFILE_SHA256: PROFILE_DIGEST, RELEASE_CANDIDATE_SHA: source.baseRevision } };
    writePrivate(path.join(runDirectory, 'wrangler.json'), config);
    writePrivate(path.join(runDirectory, '.dev.vars'), [
      'STRIPE_TEST_SECRET_KEY=' + key, 'STRIPE_TEST_WEBHOOK_SECRET=' + webhook,
      'STOREFRONT_SESSION_SECRET=' + randomBytes(32).toString('base64url'),
      'CHECKOUT_TEST_RECOVERY_SECRET=' + randomBytes(32).toString('base64url'), '',
    ].join('\n'));
    worker = child(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local',
      '--ip', '127.0.0.1', '--port', String(workerPort), '--inspector-port', '0',
      '-c', path.join(runDirectory, 'wrangler.json'), '--persist-to', path.join(runDirectory, 'runtime')], 'worker.log', {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].includes(name))),
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' });
    const deadline = Date.now() + 60000;
    for (;;) {
      assert(worker.exitCode === null, 'local_worker_exited');
      try { const r = await fetch(`http://127.0.0.1:${workerPort}${prefix}/readyz`, { signal: AbortSignal.timeout(2000) });
        const value = await r.json(); if (r.ok && value.checkout === 'test' && value.realMoney === false) break;
      } catch { /* Bounded startup, no checkout mutation. */ }
      assert(Date.now() < deadline, 'local_worker_startup_deadline'); await pause(200);
    }
    proxy = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://' + request.headers.host);
      if (request.method === 'GET' && url.pathname === statusPath) {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ...observed, workerAlive: worker.exitCode === null, listenerAlive: listener?.exitCode === null })); return;
      }
      if (request.method === 'GET' && url.searchParams.get('checkout') === 'return') {
        observed.returnBlocked++; response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
        response.end('<!doctype html><title>Test return isolated</title><p>Hosted test finished. This isolated page makes no checkout or delivery request. Close it and verify recovery in a fresh browser.</p>'); return;
      }
      if (requests.length < 2000) requests.push({ method: request.method, path: url.pathname, at: new Date().toISOString() });
      const upstream = http.request({ hostname: '127.0.0.1', port: workerPort, path: request.url,
        method: request.method, headers: request.headers }, incoming => { response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response); });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on('aborted', () => upstream.destroy()); request.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const origin = 'http://127.0.0.1:' + proxy.address().port;
    // Verify Host forwarding before allowing provider Session creation.
    const opened = await fetch(origin + prefix + '/checkout'), intent = await opened.json();
    assert.equal(intent.mode, 'test'); assert.equal(intent.realMoney, false);
    const probe = await fetch(origin + prefix + '/checkout/recovery', { method: 'POST', headers: {
      origin, cookie: opened.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json',
      'x-commerce-csrf': intent.csrfToken }, body: JSON.stringify({ confirmed: true, offerId: OFFER.id }) });
    assert.equal((await probe.json()).code, 'checkout_not_started', 'proxy_origin_not_preserved');
    const cliConfig = path.join(runDirectory, 'stripe.toml'); writePrivate(cliConfig, 'color = "off"\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('STRIPE_')));
    env.STRIPE_API_KEY = key;
    listener = child(cli, ['listen', '--skip-update', '--events', 'checkout.session.completed,checkout.session.async_payment_succeeded',
      '--format', 'JSON', '--config', cliConfig, '--forward-to', `http://127.0.0.1:${workerPort}${prefix}/checkout/webhook`], 'stripe-listen.log', env);
    const listenDeadline = Date.now() + 30000;
    for (;;) {
      assert(listener.exitCode === null, 'stripe_listener_exited');
      const log = readPrivate(path.join(runDirectory, 'stripe-listen.log'));
      if (/Ready!/u.test(log)) {
        assert(log.includes(PROFILE.webhookApiVersion), 'stripe_event_api_version_mismatch');
        const returnedSecret = log.match(/whsec_[A-Za-z0-9]{20,}/u)?.[0];
        assert(returnedSecret && same(returnedSecret, webhook), 'stripe_listener_secret_mismatch'); break;
      }
      assert(Date.now() < listenDeadline, 'stripe_listener_ready_deadline'); await pause(200);
    }
    observed.ready = true;
    const run = { runId, directory: runDirectory, origin, workerPort, profileDigest: PROFILE_DIGEST,
      source, startedAt: new Date().toISOString() };
    writePrivate(path.join(directory, 'current-run.json'), run);
    console.log(JSON.stringify({ origin, privateRun: runDirectory, privateRunFile: path.join(directory, 'current-run.json') }));
    await Promise.race(children.map(value => once(value, 'exit'))); throw Error('test_child_exited');
  } finally { cleanup(); }
}
async function download(page, selector, target) {
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  const file = await pending; assert.equal(await file.failure(), null, 'browser_download_failed');
  const bytes = fs.readFileSync(await file.path()); fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' }); return bytes;
}
async function prepare(directory) {
  const run = currentRun(directory); await state(run);
  const marker = path.join(run.directory, 'prepare-started.json');
  writePrivate(path.join(directory,'pending-checkout.json'), {runId:run.runId,directory:run.directory}, true);
  writePrivate(marker, { startedAt: new Date().toISOString() }, true); // Unknown create is preserved; never silently repeat.
  const browser = await chromium.launch({ headless: true }); let context;
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: 'block' });
    const errors = []; await context.route('**/*', route => new URL(route.request().url()).origin === run.origin
      ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(run.origin + prefix + '/#checkout');
    await expect(page.locator('meta[name="commerce-checkout-mode"]')).toHaveAttribute('content', 'test');
    await expect(page.locator('#checkout-status')).toContainText('No real money');
    await page.locator('#checkout-confirm').check(); await page.locator('#checkout-start').click();
    await expect(page.locator('#checkout-save-recovery')).toBeEnabled({ timeout: 60000 });
    const recoveryPath = path.join(run.directory, 'purchase-recovery.json');
    const recovery = JSON.parse(await download(page, '#checkout-save-recovery', recoveryPath));
    assert.equal(recovery.schema, 'commerce.test-checkout-recovery/v1'); assert.equal(recovery.offerProfile, PROFILE_DIGEST);
    const hostedUrl = await page.locator('#checkout-continue').getAttribute('href');
    assert(hostedUrl && new URL(hostedUrl).origin === 'https://checkout.stripe.com', 'test_hosted_url_required');
    const observed = await page.evaluate(async () => (await fetch('./checkout/status')).json());
    assert.equal(observed.mode, 'test'); assert.equal(observed.realMoney, false); assert.equal(observed.order.downloadReady, false);
    const orderId = observed.order.orderId; assert(/^cs_test_[A-Za-z0-9]{16,200}$/u.test(orderId));
    const raw = await providerGet(credentials(directory).key, 'checkout/sessions/' + orderId);
    assert.equal(raw.livemode, false); assert.equal(raw.status, 'open');
    assert.equal(raw.success_url, run.origin + prefix + '/?checkout=return#checkout', 'return_must_use_blocking_proxy');
    await page.screenshot({ path: path.join(run.directory, 'prepared-mobile.png'), fullPage: true });
    fs.chmodSync(path.join(run.directory, 'prepared-mobile.png'), 0o600); assert.deepEqual(errors, []);
    await context.close(); context = null;
    const prepared = { orderId, hostedUrl, nonce: raw.client_reference_id, recoveryPath,
      buyerBrowserClosedAt: new Date().toISOString(), source: run.source, profileDigest: PROFILE_DIGEST };
    const preparedPath = path.join(run.directory, 'prepared.json'); writePrivate(preparedPath, prepared, true);
    await pause(Math.max(0,Math.ceil(Date.parse(prepared.buyerBrowserClosedAt)/1000)*1000-Date.now()+10));
    console.log(JSON.stringify({ origin: run.origin, privatePreparedFile: preparedPath, privateRecoveryFile: recoveryPath }));
  } finally { await context?.close(); await browser.close(); }
}
async function verify(directory) {
  const run = currentRun(directory), before = await state(run);
  assert.equal(JSON.parse(readPrivate(path.join(directory,'pending-checkout.json'))).runId,run.runId,'pending_run_mismatch');
  const prepared = JSON.parse(readPrivate(path.join(run.directory, 'prepared.json'))), { key } = credentials(directory);
  assert.deepEqual(prepared.source, run.source); assert.equal(prepared.profileDigest, PROFILE_DIGEST);
  assert(!before.requests.some(value => value.at >= prepared.buyerBrowserClosedAt
    && value.path.startsWith(prefix + '/checkout')), 'checkout_request_after_buyer_close');
  // This observation precedes opening any recovery browser; reading does not fulfill.
  const payment = await stripeClient(key, fetch, 'test').read(prepared.orderId, prepared.nonce);
  assert(payment.livemode === false && payment.status === 'complete' && payment.payment_status === 'paid'
    && payment.entitlementReady === true, 'test_payment_or_webhook_entitlement_pending');
  const providerVerifiedAt = new Date().toISOString(), closedSecond = Math.floor(Date.parse(prepared.buyerBrowserClosedAt) / 1000);
  let event;
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    const events = await providerGet(key, 'events?' + new URLSearchParams({ type, 'created[gte]': String(closedSecond), limit: '100' }));
    assert(Array.isArray(events.data), 'test_event_inventory_invalid');
    event = events.data.find(value => value.data?.object?.id === prepared.orderId && value.type === type);
    if (event) break;
    assert(events.has_more === false, 'test_event_inventory_incomplete');
  }
  assert(event && /^evt_[A-Za-z0-9]{8,200}$/u.test(event.id) && event.livemode === false
    && event.created * 1000 >= Date.parse(prepared.buyerBrowserClosedAt) && event.api_version === PROFILE.webhookApiVersion
    && event.data.object.livemode === false && event.data.object.metadata?.mode === 'test'
    && event.data.object.metadata?.profile_digest === PROFILE_DIGEST, 'matching_test_completed_event_pending');
  const cliLog = readPrivate(path.join(run.directory, 'stripe-listen.log'));
  const forwardObserved = cliLog.split('\n').some(line => line.includes(event.id) && /\[200\]|"status(?:_code)?"\s*:\s*200/u.test(line));
  assert(forwardObserved, 'signed_test_event_forward_200_pending');
  const browser = await chromium.launch({ headless: true }); let context;
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: 'block' });
    const network = [], blocked = []; await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== run.origin || request.method() !== 'GET' && !(request.method() === 'POST' && url.pathname === prefix + '/checkout/recover')) {
        blocked.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient');
      }
      network.push({ method: request.method(), path: url.pathname }); return route.continue();
    });
    assert.deepEqual(await context.cookies(), [], 'fresh_browser_required');
    const page = await context.newPage(); await page.goto(run.origin + prefix + '/#checkout');
    const recoveryBytes = Buffer.from(readPrivate(prepared.recoveryPath)), recovery = JSON.parse(recoveryBytes);
    await page.locator('#checkout-restore-recovery').setInputFiles({ name: 'invalid.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...recovery, recoveryToken: recovery.recoveryToken + 'x' })) });
    await expect(page.locator('#checkout-status')).toContainText('Recovery could not be verified');
    await expect(page.locator('#checkout-download')).toBeHidden();
    await page.locator('#checkout-restore-recovery').setInputFiles({ name: 'purchase-recovery.json', mimeType: 'application/json', buffer: recoveryBytes });
    await expect(page.locator('#checkout-recovery-status')).toContainText('Recovery file restored', { timeout: 60000 });
    const receipt = JSON.parse(await download(page, '#checkout-receipt', path.join(run.directory, 'receipt.json')));
    assert.equal(receipt.orderId, prepared.orderId); assert.equal(receipt.mode, 'test'); assert.equal(receipt.realMoney, false);
    assert.equal(receipt.chargeMinor, 0); assert.equal(receipt.testAmountMinor, 800); assert.equal(receipt.downloadReady, true);
    const bytes = await download(page, '#checkout-download', path.join(run.directory, 'education-materials.md'));
    assert.equal(hash(bytes), OFFER.assetDigest); assert.deepEqual(blocked, []);
    await page.screenshot({ path: path.join(run.directory, 'recovered-mobile.png'), fullPage: true });
    fs.chmodSync(path.join(run.directory, 'recovered-mobile.png'), 0o600);
    const after = await state(run);
    const proof = { schema: 'commerce.hosted-test-recovery-proof/v1', scope: 'stripe-hosted-test', source: run.source,
      profileDigest: PROFILE_DIGEST, orderId: prepared.orderId, eventId: event.id, eventApiVersion: event.api_version,
      buyerBrowserClosedAt: prepared.buyerBrowserClosedAt, eventCreated: event.created, providerVerifiedAt,
      entitlementVerifiedBeforeRecoveryBrowser: true, signedEventForward200: true, originalContextClosed: true,
      freshBrowserRecovery: true, invalidRecoveryRefused: true, downloadedAssetDigest: hash(bytes),
      returnBlockedBeforeRecovery: before.returnBlocked, returnBlocked: after.returnBlocked,
      hostedPaymentSubmitted: true, providerPaid: true, realMoney: false, customerRevenueVerified: false,
      duplicateEventCoverage: 'separate-contract-fixture-only', network, verifiedAt: new Date().toISOString() };
    const proofPath = path.join(run.directory, 'proof.json'); writePrivate(proofPath, proof, true);
    fs.unlinkSync(path.join(directory,'pending-checkout.json'));
    console.log(JSON.stringify({ proofPath, privateReceiptPath: path.join(run.directory, 'receipt.json'),
      screenshotPath: path.join(run.directory, 'recovered-mobile.png') }));
  } finally { await context?.close(); await browser.close(); }
}

try {
  const [command, directoryArgument, cli, ...extra] = process.argv.slice(2);
  assert(['serve', 'prepare', 'verify'].includes(command) && directoryArgument && !extra.length
    && (command === 'serve' ? !!cli : !cli), 'usage_hosted_test_serve_prepare_verify');
  const directory = privateDirectory(directoryArgument);
  if (command === 'serve') await serve(directory, cli);
  else if (command === 'prepare') await prepare(directory);
  else await verify(directory);
} catch (error) {
  // External diagnostics and assertion values may contain private tokens. Keep them off stdout/stderr.
  const safe = error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/u.test(error.message) ? error.message : 'hosted_test_operation_failed';
  console.error(safe); process.exitCode = 1;
}
