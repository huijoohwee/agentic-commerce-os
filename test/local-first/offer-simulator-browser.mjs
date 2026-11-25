import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';

async function snapshot(page) {
  const bytes = await page.evaluate(async () => {
    const url = new URL('drafts.js', document.querySelector('script[type=module]').src);
    return (await import(url)).exportDrafts();
  });
  return { digest: createHash('sha256').update(bytes).digest('hex'), drafts: JSON.parse(bytes).drafts };
}

export async function checkOfferSimulator({ browser, url }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, forcedColors: 'active' });
  try {
    const page = await context.newPage();
    await page.goto(url + '#vendor-editor');
    await page.getByText('Offline access is ready.', { exact: false }).waitFor();
    const other = await context.newPage();
    await other.goto(url + '#vendor-editor');
    const draft = await other.evaluate(async () => {
      const { saveDraft } = await import(new URL('drafts.js', document.querySelector('script[type=module]').src));
      await saveDraft({ title: 'Incomplete offer', description: '', price: '', launch: null });
      return saveDraft({ title: 'Maker kit', description: 'Private description', price: 'Private price',
        launch: { merchantId: 'maker', agentId: 'studio', audience: 'Home makers', outcome: 'One finished kit',
          currency: 'USD', priceMinor: 1000, deliveryCostMinor: 100, providerFeeMinor: 20, agentCostMinor: 0,
          acquisitionCostMinor: 0, fixedCostMinor: 500 } });
    });
    await context.setOffline(true);
    await page.reload();
    const open = page.getByText('Simulate offer terms', { exact: true });
    const panel = page.locator('details').filter({ has: open });
    await page.locator('#draft-list button').filter({ hasText: 'Incomplete offer' }).click();
    await open.click(); await expect(panel.getByRole('status')).toContainText('merchant ID');
    await expect(panel.getByRole('status')).toContainText('Price');
    await page.locator('#draft-list button').filter({ hasText: draft.title }).click();
    const initial = await snapshot(page), price = panel.getByLabel('Price', { exact: true });
    const adopt = panel.getByRole('button', { name: 'Adopt preview' });
    await expect(price).toHaveValue('10.00'); await expect(adopt).toBeDisabled();
    await expect(panel.getByRole('status')).toContainText('Demand is unvalidated');
    await expect(panel.getByRole('slider')).toHaveCount(6);
    await expect(panel.getByRole('table')).toContainText('±10%');
    await price.fill('11.05'); await expect(price).toBeFocused();
    await expect(panel.getByRole('row').nth(1)).toContainText('Price');
    await expect(panel.getByText('Change +$10.50', { exact: true })).toBeVisible();
    await panel.getByLabel('Sensitivity band (%)').fill('51');
    await expect(adopt).toBeDisabled(); await expect(panel.getByRole('table')).toHaveCount(0);
    await panel.getByLabel('Sensitivity band (%)').fill('25');
    await price.fill('0.50');
    await expect(panel.getByRole('status')).toContainText('does not cover');
    await expect(panel.getByText('Change Not reachable', { exact: true })).toBeVisible();
    const slider = panel.getByRole('slider', { name: 'Adjust Price', exact: true });
    await slider.focus(); await slider.press('ArrowRight'); await expect(price).toHaveValue('0.51');
    await panel.getByRole('button', { name: 'Reset preview' }).click();
    await expect(price).toHaveValue('10.00'); await expect(adopt).toBeDisabled();
    await price.fill('12.00');
    assert.equal((await snapshot(page)).digest, initial.digest);
    assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Simulator fits a narrow touch viewport');

    // Commit a competing revision in a second tab after the preview was opened.
    await other.evaluate(async id => {
      const store = await import(new URL('drafts.js', document.querySelector('script[type=module]').src));
      const current = (await store.listDrafts()).find(row => row.id === id);
      await store.saveDraft({ ...current, description: 'Updated private note',
        launch: { ...current.launch, providerFeeMinor: 75 } }, current.revision);
    }, draft.id);
    const afterOtherTab = await snapshot(page);
    await adopt.click();
    await expect(panel.getByRole('status')).toContainText('Saved terms changed');
    await expect(panel.getByRole('status')).toContainText('Revision 2');
    await expect(price).toHaveValue('12.00'); await expect(panel.getByLabel('Provider fee per sale', { exact: true })).toHaveValue('0.75');
    assert.equal((await snapshot(page)).digest, afterOtherTab.digest);
    await adopt.click(); await expect(page.locator('#status')).toHaveText('Preview adopted as revision 3.');
    await expect(adopt).toBeDisabled(); await expect(page.locator('#approve-launch')).not.toBeChecked();
    const saved = (await snapshot(page)).drafts.find(item => item.id === draft.id);
    assert.deepEqual(saved.launch, { ...draft.launch, priceMinor: 1200, providerFeeMinor: 75 });
    assert.equal(saved.revision, 3); assert.equal(saved.description, 'Updated private note'); assert.equal(saved.price, draft.price);
    await expect(page.locator('#sale-price')).toHaveValue('12.00');
    await page.reload(); await page.locator('#draft-list button').filter({ hasText: draft.title }).click();
    await open.click(); await expect(panel.getByRole('status')).toContainText('Revision 3'); await expect(adopt).toBeDisabled();
  } finally { await context.close(); }
}
