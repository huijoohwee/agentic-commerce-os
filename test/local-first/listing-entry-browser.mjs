import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { chooseDropdown } from './dropdown-menu-browser.mjs';

const base = process.argv.find(arg => arg.startsWith('--base-url='))?.slice(11);
if (!base || !/^http:\/\/127\.0\.0\.1:\d+\/agentic-commerce-os\/$/u.test(base)) throw Error('Use an explicitly selected local Commerce URL.');
const output = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) || 'node_modules/.cache/listing-entry-verification');
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true }), errors = [];
const records = page => page.evaluate(async () => {
  const source = document.querySelector('script[type=module]').src;
  return (await import(new URL('drafts.js', source).href)).listDrafts();
});
const save = page => page.getByRole('button', { name: 'Save on this device', exact: true }).click();
const open = async (page, title) => { await page.locator('#draft-list button').filter({ hasText: title }).click(); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage(); await page.goto(base + '#vendor-editor');
  await expect(page.locator('#title')).toBeEnabled();
  await page.locator('#title').fill('Fictional design studio');
  await page.locator('#description').fill('Invented acquisition notes for a private operator drill.');
  await page.locator('#listing-fields > summary').click(); await page.locator('#listing-enabled').check();
  for (const [field, value] of Object.entries({ currency: 'SGD', category: 'Design services', country: 'SG', region: 'East',
    askingPriceMinor: '85000', monthlyRentMinor: '-1', monthlyProfitMinor: '-500', establishedYear: '2020',
    leaseEndsOn: '2028-03-31', areaSqFt: '650', employees: '0', sourceUrl: 'https://example.invalid/business/studio', asOf: '2026-11-13' })) {
    await page.locator('#listing-' + field).fill(value);
  }
  await save(page); await expect(page.locator('#listing-monthlyRentMinor')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#listing-monthlyRentMinor')).toBeFocused(); assert.deepEqual(await records(page), []);
  await page.locator('#listing-monthlyRentMinor').fill('1250'); await save(page);
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  const original = (await records(page))[0]; assert.equal(original.revision, 1);
  assert.equal(original.listing.monthlyRevenueMinor, null); assert.equal(original.listing.monthlyProfitMinor, -50000);
  assert.equal(original.listing.monthlyRentMinor, 125000); assert.equal(original.listing.employees, 0);
  await page.screenshot({ path: path.join(output, 'listing-editor-desktop.png'), fullPage: true });
  await page.reload(); await open(page, original.title); await expect(page.locator('#listing-askingPriceMinor')).toHaveValue('85000.00');
  await page.locator('#description').fill('Updated private context'); await save(page);
  await expect.poll(async () => (await records(page))[0].revision).toBe(2);
  console.log('PASS create, strict inline validation, nullable values, edit and reload');

  const second = await context.newPage(); await second.goto(base + '#vendor-editor'); await open(second, original.title);
  await second.locator('#description').fill('Stale tab edits to preserve');
  await page.locator('#description').fill('Current tab wins once'); await save(page);
  await expect.poll(async () => (await records(page))[0].revision).toBe(3);
  await save(second); await expect(second.locator('#status')).toContainText('changed in another tab');
  await expect(second.locator('#description')).toHaveValue('Stale tab edits to preserve');
  assert.equal((await records(second))[0].description, 'Current tab wins once'); await second.close({ runBeforeUnload: false });
  console.log('PASS stale second-tab save refuses overwrite and preserves editor text');

  await page.locator('#archive-listing').click(); await expect(page.locator('#listing-state')).toContainText('Archived');
  await expect(page.locator('#review-launch')).toBeDisabled();
  await expect(page.locator('#prepare-listing')).toBeDisabled();
  const archived = (await records(page))[0]; assert.equal(archived.revision, 4);
  assert.equal(archived.id, original.id); assert.equal(archived.createdAt, original.createdAt);
  await page.getByRole('link', { name: 'Back to offers', exact: true }).click();
  await expect(page.locator('#vendor-table')).not.toContainText(original.title); await expect(page.locator('#vendor-total')).toHaveText('0');
  await chooseDropdown(page.locator('#vendor-state'), 'archived');
  await page.locator('#vendor-query').fill('East');
  await page.getByRole('button', { name: 'Open details for ' + original.title, exact: true }).click();
  await expect(page.locator('#vendor-table')).toContainText('Monthly profit / loss');
  await page.getByRole('link', { name: 'Edit or restore listing ↗', exact: true }).click();
  await page.locator('#archive-listing').click(); await expect(page.locator('#listing-state')).toHaveText('Private listing draft');
  assert.equal((await records(page))[0].revision, 5); assert.equal((await records(page))[0].listing.status, 'draft');
  console.log('PASS archive, active projection exclusion, category/location search and native detail/restore');

  await page.setViewportSize({ width: 360, height: 800 });
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
  await page.screenshot({ path: path.join(output, 'listing-editor-mobile.png'), fullPage: true });
  await expect(page.getByText('Offline access is ready.', { exact: false })).toContainText('Offline access is ready');
  await context.setOffline(true); await page.reload(); await open(page, original.title);
  await expect(page.locator('#listing-monthlyProfitMinor')).toHaveValue('-500.00');
  await page.locator('#listing-region').fill('East district'); await save(page);
  await expect.poll(async () => (await records(page))[0].revision).toBe(6);
  const final = (await records(page))[0]; assert.equal(final.listing.region, 'East district');
  await context.setOffline(false);
  console.log('PASS 360px reflow and offline reload/edit with the existing service worker');

  const backup = await page.evaluate(async () => (await import(new URL('drafts.js', document.querySelector('script[type=module]').src).href)).exportDrafts());
  assert.equal(JSON.parse(backup).schema, 'commerce.local-drafts/v4');
  const importedContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const imported = await importedContext.newPage(); imported.on('pageerror', error => errors.push(error.message)); await imported.goto(base + '#admin-data');
  await expect(imported.locator('#import')).toBeEnabled();
  await imported.locator('#import').setInputFiles({ name: 'listing-backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect.poll(async () => (await records(imported)).length).toBe(1);
  assert.deepEqual((await records(imported))[0], final);
  const transactions = await imported.evaluate(async backup => {
    const data = await import(new URL('drafts.js', document.querySelector('script[type=module]').src).href);
    const payload = JSON.parse(backup), before = JSON.stringify(await data.listDrafts());
    const conflict = structuredClone(payload.drafts[0]); conflict.title = 'Conflicting title';
    const addition = { ...payload.drafts[0], id: crypto.randomUUID(), listing: { ...payload.drafts[0].listing, sourceUrl: 'https://example.invalid/other' } };
    let failure; try { await data.importDrafts(JSON.stringify({ ...payload, drafts: [addition, conflict] })); } catch (error) { failure = error.message; }
    const unchanged = before === JSON.stringify(await data.listDrafts());
    const input = { title: 'Duplicate race', description: '', price: '', listing: { ...payload.drafts[0].listing, sourceUrl: 'https://example.invalid/race' } };
    const results = await Promise.allSettled([data.saveDraft(input), data.saveDraft(input)]);
    const same = await data.importDrafts(await data.exportDrafts());
    return { failure, unchanged, results: results.map(result => result.status), count: (await data.listDrafts()).length, unchangedImport: same };
  }, backup);
  assert.match(transactions.failure, /conflicts/); assert(transactions.unchanged);
  assert.equal(transactions.results.filter(status => status === 'fulfilled').length, 1);
  assert.equal(transactions.results.filter(status => status === 'rejected').length, 1);
  assert.equal(transactions.count, 2); assert.equal(transactions.unchangedImport, 0);
  await importedContext.close();
  console.log('PASS v4 UI import, lossless backup, atomic conflicting import and simultaneous duplicate-source refusal');
  const deniedContext = await browser.newContext();
  await deniedContext.addInitScript(() => { indexedDB.open = () => { throw Error('Storage denied for verification'); }; });
  const denied = await deniedContext.newPage(); await denied.goto(base + '#vendor-editor');
  await denied.locator('#title').fill('Text retained when storage is denied'); await save(denied);
  await expect(denied.locator('#status')).toContainText('Storage denied');
  await expect(denied.locator('#title')).toHaveValue('Text retained when storage is denied');
  await deniedContext.close(); console.log('PASS storage-denied save fails visibly and retains editor text');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ source: 'local-worktree', sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeClean: !execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), base, viewports: [1280, 360],
    assertions: 'create/edit/reload/validation/CAS/archive/search/restore/offline/backup/import/duplicate-race/storage-denied', errors, state: final }, null, 2));
  await context.close();
} finally { await browser.close(); }
