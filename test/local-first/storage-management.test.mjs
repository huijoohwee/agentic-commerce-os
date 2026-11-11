import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import worker from '../../src/local-first/worker.ts';
import { verifyStorageManagementSourceIndex } from '../../scripts/local-first-release/artifact.mjs';

const revision = 'c'.repeat(40);
const root = process.cwd();
const contentType = file => ({ html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8' }[path.extname(file).slice(1)] || 'application/octet-stream');

test('storage management source index is pinned and works offline on mobile', { timeout: 45000 }, async t => {
  const index = verifyStorageManagementSourceIndex();
  assert.equal(index.sourceCount, 6);
  assert.equal(index.sourceFileCount, 9);
  const evidenceRoot = path.resolve(root, 'node_modules/.cache/storage-management-browser');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const env = {
    RELEASE_CANDIDATE_SHA: revision,
    ASSETS: { async fetch(request) {
      const relative = new URL(request.url).pathname.replace(/^\/+/, '') || 'index.html';
      const filename = path.resolve(root, 'public/local-first', relative);
      if (!filename.startsWith(path.resolve(root, 'public/local-first') + path.sep)) return new Response('Not found', { status: 404 });
      try { return new Response(fs.readFileSync(filename), { headers: { 'content-type': contentType(filename) } }); }
      catch { return new Response('Not found', { status: 404 }); }
    } },
  };
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
        method: incoming.method, headers: incoming.headers,
      });
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/agentic-commerce-os/storage-management/`;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
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
  const sourceManifest = await page.evaluate(async () => (await fetch('sources.json')).json());
  assert.equal(sourceManifest.sources.length, 6);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'E2E storage management' }).waitFor();
  const offlineManifest = await page.evaluate(async () => (await fetch('sources.json')).json());
  assert.equal(offlineManifest.sources.length, 6);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await context.setOffline(false);
});
