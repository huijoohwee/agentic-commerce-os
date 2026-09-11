import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs';

export async function checkRoleWorkspace({ browser, url, output, observeContext, record }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  observeContext(context);
  const page = await context.newPage(); await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Your collection starts with one offer.' })).toBeVisible();
  // Release-scoped assets cannot collide with the legacy cache-first service worker's unversioned paths.
  const css = await page.locator('link[rel=stylesheet]').getAttribute('href');
  const bootstrap = await page.locator('script[type=module]').getAttribute('src');
  assert.match(css, /^\.\/assets\/[a-f0-9]{40}\/style.css$/);
  assert.match(bootstrap, /^\.\/assets\/[a-f0-9]{40}\/workspace.js$/);
  assert.equal((await page.request.get(new URL(css, url).href)).status(), 200);
  await page.getByText('Offline access is ready.', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(output, 'shopper-empty-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await page.getByRole('link', { name: 'Data & portability', exact: true }).click();
  const now = Date.now();
  const drafts = Array.from({ length: 13 }, (_, index) => ({
    id: `12345678-1234-1234-1234-${String(index).padStart(12, '0')}`,
    title: index === 0 ? '<img src=x onerror="window.injected=true">' : `Independent offer ${String(index).padStart(2, '0')}`,
    description: 'PRIVATE interview notes', price: 'PRIVATE negotiation notes', revision: 1, createdAt: now, updatedAt: now + index,
    launch: { merchantId: index % 2 ? 'studio-north' : 'solo-studio', agentId: 'discovery-agent', currency: 'USD',
      audience: 'Independent founders', outcome: 'A useful result, prepared with care', priceMinor: 12500,
      deliveryCostMinor: index === 12 ? 15000 : 4000, providerFeeMinor: 500, agentCostMinor: 100,
      acquisitionCostMinor: 900, fixedCostMinor: 10000 },
  }));
  await expect(page.locator('#import')).toBeEnabled();
  await page.locator('#import').setInputFiles({ name: 'offers.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schema: 'commerce.local-drafts/v2', drafts })) });
  await expect(page.locator('#status')).toContainText('Imported 13 drafts.');
  await page.getByRole('link', { name: 'Vendor', exact: true }).click();
  await expect(page.locator('#vendor-total')).toHaveText('13');
  await expect(page.locator('#vendor-table tbody tr')).toHaveCount(10);
  await page.getByRole('navigation', { name: 'vendor pagination' }).getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#vendor-table tbody tr')).toHaveCount(3);
  await page.locator('#vendor-state').selectOption('revise');
  await expect(page.locator('#vendor-table tbody tr')).toHaveCount(1);
  await page.locator('#vendor-state').selectOption('');
  await page.screenshot({ path: path.join(output, 'vendor-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Shopper', exact: true }).click();
  await expect(page.locator('#shop-grid article')).toHaveCount(12);
  await page.locator('#shop-next').click(); await expect(page.locator('#shop-grid article')).toHaveCount(1);
  await page.locator('#shop-store').selectOption('studio-north'); await expect(page.locator('#shop-grid article')).toHaveCount(6);
  await page.locator('#shop-query').fill('offer 03'); await expect(page.locator('#shop-grid article')).toHaveCount(1);
  await page.locator('#shop-grid button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#detail-content')).toContainText('$125.00');
  await expect(page.locator('#detail-content')).not.toContainText('PRIVATE');
  await page.keyboard.press('Escape'); await expect(page.locator('#shop-grid button')).toBeFocused();
  await page.locator('#shop-query').fill(''); await page.locator('#shop-store').selectOption('');
  await page.locator('#shop-sort').selectOption('name');
  assert.equal(await page.locator('#shop-grid img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.screenshot({ path: path.join(output, 'shopper-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page.locator('#admin-reviewable')).toHaveText('12');
  await expect(page.locator('#admin-attention')).toHaveText('1');
  await expect(page.locator('#admin-stores')).toHaveText('2');
  await page.screenshot({ path: path.join(output, 'admin-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Launch reviews', exact: true }).click();
  await page.locator('#admin-query').fill('offer 03');
  await expect(page.locator('#admin-table tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'Review offer ↗', exact: true }).click();
  await expect(page.getByLabel('What are you creating?')).toHaveValue('Independent offer 03');
  await expect(page.getByLabel('The idea', { exact: true })).toHaveValue('PRIVATE interview notes');
  await page.getByRole('button', { name: 'Review launch', exact: true }).click();
  await expect(page.locator('#launch-review')).toBeVisible();
  await expect(page.locator('#export-launch')).toBeDisabled();
  await context.setOffline(true);
  for (const [role, hash] of [['shopper', 'shop'], ['vendor', 'vendor'], ['admin', 'admin']]) {
    await page.goto(url + '#' + hash); await page.reload();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(page.locator(`[data-role-panel="${hash}"]`)).toBeVisible();
    assert.equal(await page.evaluate(() => fetch('./readyz').then(() => false, () => true)), true);
    if (hash === 'shop') await expect(page.locator('#shop-grid article')).toHaveCount(12);
    if (hash === 'vendor') await expect(page.locator('#vendor-total')).toHaveText('13');
    if (hash === 'admin') await expect(page.locator('#admin-reviewable')).toHaveText('12');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, role + '-mobile.png'), fullPage: true });
  }
  record(BROWSER_CHECKS.roles);
  await context.close();
}
