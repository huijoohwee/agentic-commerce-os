import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

/** Reuse the native listing browser drill, storage reader and network guard. */
export async function checkListingGeoPreview(page, readRecords) {
  const before = JSON.stringify(await readRecords(page));
  const loaded = () => page.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => new URL(entry.name).pathname).filter(name => /\/(?:listing-geo\.js|agentic-geo-core\.mjs)$/u.test(name)));
  assert.deepEqual(await loaded(), [], 'geo must be lazy before explicit preview');
  await page.locator('#listing-geo-preview > summary').click();
  const input = page.locator('#listing-longitudes'), output = page.locator('#listing-geo-result');
  const preview = () => page.getByRole('button', { name: 'Preview longitude span', exact: true }).click();
  await input.fill('179, -179'); await preview();
  await expect(output).toContainText('Center -180° · width 2°');
  assert.equal((await loaded()).length, 2);
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  for (const [value, message] of [['', 'at least one'], ['NaN', 'finite decimal'],
    [Array(1025).fill('0').join(' '), '1,024']]) {
    await input.fill(value); await preview();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(output).toContainText(message);
  }
  await input.fill('540'); await preview();
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await expect(output).toContainText('Center -180° · width 0°');
  assert.equal(JSON.stringify(await readRecords(page)), before, 'preview must not mutate saved facts or revisions');
  console.log('PASS lazy longitude preview, native wrapping, accessible errors, bounds and unchanged saved draft');
}

export async function checkListingGeo({ browser, url, output, revision }) {
  const target = new URL(url);
  assert.equal(target.pathname, '/agentic-commerce-os/');
  assert(!target.username && !target.password && !target.search && !target.hash);
  assert(target.protocol === 'https:' || target.protocol === 'http:' && target.hostname === '127.0.0.1');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [], requests = [];
  await context.route('**/*', route => route.request().method() === 'GET'
    && new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort());
  try {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    const response = await page.goto(url + '#vendor-editor');
    assert.equal(response.headers()['x-commerce-source'], revision);
    await expect(page.locator('#title')).toBeEnabled();
    await page.locator('#title').fill('Fictional geo rehearsal');
    await page.locator('#description').fill('Private fictional region bounds.');
    await page.locator('#listing-fields > summary').click();
    await page.locator('#listing-enabled').check();
    await page.locator('#listing-currency').fill('SGD');
    await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
    await expect(page.locator('#save-state')).toHaveText('Saved on this device');
    const records = page => page.evaluate(async () => {
      const source = document.querySelector('script[type=module]').src;
      return (await import(new URL('drafts.js', source).href)).listDrafts();
    });
    await checkListingGeoPreview(page, records);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'geo-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await context.setOffline(true);
    await page.locator('#listing-longitudes').fill('178, -178');
    await page.locator('#preview-listing-geo').click();
    await expect(page.locator('#listing-geo-result')).toContainText('width 4°');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, 'geo-mobile-offline.png'), fullPage: true });
    await page.locator('#new-draft').click();
    await expect(page.locator('#listing-longitudes')).toHaveValue('');
    assert.deepEqual(errors, []);
    assert(requests.every(request => request.method === 'GET' && new URL(request.url).origin === target.origin));
    const result = { sourceRevision: revision, scope: 'loaded-page local longitude preview; offline reload not asserted',
      viewports: [1280, 360], errors, networkWrites: 0, savedRecords: (await records(page)).length };
    fs.writeFileSync(path.join(output, 'geo-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { await context.close(); }
}
