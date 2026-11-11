import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { OUTPUT, CONFIG, PUBLIC_PREFIX, WORKER, ROUTES, prepareCandidate, verifyCandidate } from '../../scripts/storage-management-release/verify.mjs';

const revision = 'c'.repeat(40);
const run = process.cwd();

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function ready(base, child, logs) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`wrangler_dev_exited:${logs.join('').slice(-3000)}`);
    try {
      const response = await fetch(`${base}${PUBLIC_PREFIX}/`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) { await response.arrayBuffer(); return response; }
    } catch { /* wait for the local preview */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error(`wrangler_dev_timeout:${logs.join('').slice(-3000)}`);
}

test('storage route serves five pinned files offline without the Commerce app Worker', { timeout: 90000 }, async t => {
  const candidate = prepareCandidate(revision, OUTPUT, { requireClean: false });
  assert.equal(candidate.files.length, 5);
  assert.equal(candidate.worker, WORKER);
  assert.deepEqual(candidate.routes, ROUTES);
  assert.equal(verifyCandidate({ candidateSha: revision }).assetDigest, candidate.assetDigest);

  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', CONFIG,
    '--local', '--ip', '127.0.0.1', '--port', String(port)], {
    cwd: run, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    if (logs.join('').length < 20000) logs.push(chunk.toString());
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const url = `${base}${PUBLIC_PREFIX}/`;
  const first = await ready(base, child, logs);
  assert.match(first.headers.get('content-type') ?? '', /text\/html/u);
  assert.match(first.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
  assert.match(first.headers.get('cache-control') ?? '', /no-transform/u);
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);

  const slashless = await fetch(url.slice(0, -1), { redirect: 'manual' });
  assert.equal(slashless.status, 308);
  assert.equal(new URL(slashless.headers.get('location'), base).pathname, `${PUBLIC_PREFIX}/`);
  assert.equal((await fetch(`${url}missing.txt`)).status, 404);

  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('heading', { name: 'E2E storage management' }).waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
  assert.equal(await page.locator('article').count(), 6);
  assert.equal(await page.locator('a[href^="https://github.com/"]').count(), 9);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(async () => (await fetch('sources.json')).json()).then(value => value.sources.length), 6);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'E2E storage management' }).waitFor();
  assert.equal(await page.evaluate(async () => (await fetch('sources.json')).json()).then(value => value.sources.length), 6);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await context.setOffline(false);
});
