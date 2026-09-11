import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs';

export async function checkMerchantLaunch({ browser, url, output, observeContext, record }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  observeContext(context);
  const page = await context.newPage();
  await page.goto(url + '#vendor-editor');
  await page.getByText('Offline access is ready.', { exact: false }).waitFor();
  await context.setOffline(true); await page.reload();
  await page.getByLabel('What are you creating?').fill('Solo pilot');
  await page.getByLabel('The idea', { exact: true }).fill('PRIVATE customer interview notes');
  await page.getByLabel('Price notes').fill('PRIVATE negotiation notes');
  await page.getByText('Prepare for a first sale', { exact: true }).click();
  for (const [label, value] of [
    ['Who has this problem?', 'Solo founders who need one useful result'], ['What will you deliver?', 'One reviewed itinerary'],
    ['Merchant ID', 'solo-pilot'], ['Registered discovery agent ID', 'dev-e2e-flight'], ['Currency', 'USD'],
    ['Planned price', '125.00'], ['Delivery cost per sale', '40.00'], ['Payment fee per sale', '5.00'],
    ['Agent cost per sale', '1.00'], ['Acquisition cost per sale', '9.00'], ['One-time setup cost', '100.00'],
  ]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByText('Saved privately on this device.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review launch', exact: true }).click();
  await expect(page.locator('#launch-review')).toBeVisible();
  await expect(page.locator('#economics')).toContainText('$70.00');
  await expect(page.getByRole('button', { name: 'Export reviewed launch pack' })).toBeDisabled();
  await page.getByLabel('I reviewed this offer and its estimated costs.').check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export reviewed launch pack' }).click();
  const pack = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
  assert.equal(pack.nextAction.tool, 'commerce.theme.deploy');
  assert.equal(pack.economics.contributionMinor, 7000);
  assert.equal(pack.economics.breakEvenSales, 2);
  assert.equal(pack.review.grantsPaymentAuthority, false);
  assert.equal(JSON.stringify(pack).includes('PRIVATE'), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'merchant-mobile.png'), fullPage: true });
  record(BROWSER_CHECKS.launch);

  await page.getByLabel('What will you deliver?').fill('A revised outcome');
  await expect(page.locator('#launch-review')).toBeHidden();
  await page.getByRole('button', { name: 'Review launch', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Save this offer');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByText('Saved privately on this device.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review launch', exact: true }).click();
  await expect(page.locator('#launch-review')).toBeVisible();
  await page.getByLabel('I reviewed this offer and its estimated costs.').check();
  // A writer without BroadcastChannel still cannot export an earlier review.
  await page.evaluate(async () => {
    const bootstrap = document.querySelector('script[type=module]').src;
    const { listDrafts, saveDraft } = await import(new URL('drafts.js', bootstrap).href);
    const draft = (await listDrafts())[0];
    await saveDraft({ ...draft, title: 'Changed in another tab' }, draft.revision);
  });
  await page.getByRole('button', { name: 'Export reviewed launch pack' }).click();
  await expect(page.locator('#status')).toContainText('This offer changed.');
  record(BROWSER_CHECKS.review);

  await page.reload(); await page.locator('#draft-list button').first().click();
  await expect(page.getByLabel('Planned price', { exact: true })).toHaveValue('125.00');
  await page.getByLabel('Delivery cost per sale').fill('200.00');
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await page.getByText('Saved privately on this device.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review launch', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Estimated revenue must exceed');
  await expect(page.locator('#launch-review')).toBeHidden();
  record(BROWSER_CHECKS.economics);
  await context.close();
}
