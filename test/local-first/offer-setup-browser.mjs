import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

const steps = ['describe', 'identity', 'economics', 'review'];
const amounts = ['#delivery-cost', '#provider-fee', '#agent-cost', '#acquisition-cost', '#fixed-cost'];
const step = (page, name) => page.locator(`[data-setup-step="${name}"]`);

async function openStep(page, name) {
  const row = step(page, name);
  if (!await row.evaluate(element => element.open)) await row.locator('summary').click();
  return row;
}

async function action(page, name) {
  return (await openStep(page, 'review')).getByRole('button', { name, exact: true });
}

async function progress(page, count) {
  await expect(page.locator('#setup-count')).toHaveText(`${count} of 4 steps complete`);
  await expect(step(page, 'review').locator('summary')).toContainText(count === 4 ? 'Complete' : 'Needs attention');
}

async function savedDrafts(page) {
  return page.evaluate(async () => {
    const bootstrap = document.querySelector('script[type=module]').src;
    return (await import(new URL('drafts.js', bootstrap).href)).listDrafts();
  });
}

async function saveAndReview(page) {
  await (await action(page, 'Save offer')).click();
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  await progress(page, 3);
  await expect(page.locator('#launch-review')).toBeHidden();
  await (await action(page, 'Review saved offer')).click();
  await expect(page.locator('#launch-review')).toBeVisible();
  await progress(page, 3);
}

async function acknowledge(page) {
  await (await action(page, 'Read and acknowledge review')).click();
  await expect(page.locator('#approve-launch')).toBeFocused();
  await expect(page.locator('#approve-launch')).not.toBeChecked();
  await expect(page.locator('#export-launch')).toBeDisabled();
  await progress(page, 3);
  await page.keyboard.press('Space');
  await expect(page.locator('#approve-launch')).toBeChecked();
  await progress(page, 4);
}

async function responsiveGuide(page, output) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const normalFont = await page.locator('#setup-count').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.locator('#setup-count').evaluate(element => parseFloat(getComputedStyle(element).fontSize)), normalFont * 2,
    'Setup progress follows the native text scale at 200%');
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of steps) await openStep(page, name);
    const geometry = await page.locator('#offer-setup').evaluate(section => {
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, left: rect.left, right: rect.right,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      };
      return { pageFits: document.documentElement.scrollWidth <= innerWidth, section: bounds(section),
        actions: [...section.querySelectorAll('button, summary')].map(bounds) };
    });
    assert.equal(geometry.pageFits, true, `No page overflow at ${width}px with doubled text`);
    assert(geometry.section.left >= 0 && geometry.section.right <= width + 1, `Setup stays within ${width}px`);
    for (const bounds of geometry.actions) {
      assert(bounds.height >= 44 && bounds.width >= 44, `Setup targets remain at least 44px at ${width}px`);
      assert(bounds.scrollWidth <= bounds.clientWidth + 1, `Setup action text is not clipped at ${width}px`);
    }
    await page.locator('#offer-setup').screenshot({ path: path.join(output, `offer-setup-${width}-200pct.png`) });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 768, height: 900 });
}

export async function checkOfferSetup({ browser, url, output, observeContext }) {
  const context = await browser.newContext({ viewport: { width: 768, height: 900 }, acceptDownloads: true });
  observeContext(context);
  try {
    const page = await context.newPage();
    await page.goto(url + '#vendor-editor');
    await page.getByText('Offline access is ready.', { exact: false }).waitFor();
    await expect(page.locator('#offer-setup').getByRole('heading', { name: 'Offer setup', exact: true })).toBeVisible();
    await expect(page.locator('#setup-status')).toHaveAttribute('role', 'status');
    await expect(page.locator('[data-setup-step]')).toHaveCount(4);
    await progress(page, 0);
    for (const name of steps) await expect(step(page, name).locator('summary')).toContainText('Needs attention');

    // A keyboard guide action opens native launch details and focuses the first missing field.
    await page.locator('#title').fill('Setup browser offer');
    await progress(page, 0);
    const describe = await openStep(page, 'describe');
    await expect(page.locator('#launch-fields')).not.toHaveAttribute('open');
    await describe.getByRole('button', { name: 'Edit description', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#launch-fields')).toHaveAttribute('open', '');
    await expect(page.locator('#audience')).toBeFocused();
    await page.locator('#audience').fill('Independent makers who need one clear outcome');
    await progress(page, 0);
    await page.locator('#outcome').fill('One reviewed setup checklist');
    await progress(page, 1);
    await expect(describe.locator('summary')).toContainText('Complete');

    const identity = await openStep(page, 'identity');
    await identity.getByRole('button', { name: 'Edit identifiers', exact: true }).click();
    await expect(page.locator('#merchant-id')).toBeFocused();
    await page.locator('#merchant-id').fill('INVALID STORE');
    await page.locator('#agent-id').fill('dev-setup-agent');
    await progress(page, 1);
    await page.locator('#merchant-id').fill('setup-store');
    await progress(page, 2);
    await expect(identity.locator('summary')).toContainText('Complete');

    const economics = await openStep(page, 'economics');
    await economics.getByRole('button', { name: 'Edit estimates', exact: true }).click();
    await expect(page.locator('#currency')).toBeFocused();
    await page.locator('#currency').fill('USD');
    await page.locator('#sale-price').fill('10.00');
    // Blank costs must not silently become zero; each explicit zero is a valid estimate.
    await progress(page, 2);
    for (const selector of amounts) await page.locator(selector).fill('0');
    await progress(page, 3);
    await expect(economics.locator('summary')).toContainText('Complete');
    await page.locator('#sale-price').fill('0');
    await progress(page, 2);
    await page.locator('#sale-price').fill('10.00');
    await page.locator('#delivery-cost').fill('12.00');
    await progress(page, 2);
    await expect(economics.locator('summary')).toContainText('Needs attention');
    await page.locator('#delivery-cost').fill('0');
    await progress(page, 3);
    assert.equal((await savedDrafts(page)).length, 0, 'Input completion does not save an offer');
    await expect(page.locator('#launch-review')).toBeHidden();
    await expect(page.locator('#approve-launch')).not.toBeChecked();
    await responsiveGuide(page, output);

    // A warm offline reload and the entire review/export sequence use the existing local flow.
    await page.locator('#description').fill('PRIVATE setup interview notes');
    await page.locator('#price').fill('PRIVATE negotiation estimate');
    await (await action(page, 'Save offer')).click();
    await expect(page.locator('#save-state')).toHaveText('Saved on this device');
    await context.setOffline(true);
    await page.reload();
    await page.locator('#draft-list button').first().click();
    await progress(page, 3);
    await expect(page.locator('#launch-review')).toBeHidden();
    await (await action(page, 'Review saved offer')).click();
    await expect(page.locator('#launch-review')).toBeVisible();
    await acknowledge(page);
    const download = page.waitForEvent('download');
    await (await action(page, 'Export reviewed setup')).click();
    const pack = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
    assert.equal(pack.review.grantsPublishAuthority, false);
    assert.equal(pack.review.grantsPaymentAuthority, false);
    assert.equal(JSON.stringify(pack).includes('PRIVATE'), false);
    await progress(page, 4);

    // Every persisted input, including private notes, invalidates the exact saved review.
    for (const [selector, changed] of [
      ['#title', 'Revised setup offer'], ['#description', 'PRIVATE revised idea'], ['#price', 'PRIVATE revised note'],
      ['#audience', 'Revised buyer'], ['#outcome', 'Revised outcome'], ['#merchant-id', 'revised-store'],
      ['#agent-id', 'revised-agent'], ['#currency', 'SGD'], ['#sale-price', '11.00'],
      ...amounts.map(selector => [selector, '1.00']),
    ]) {
      const input = page.locator(selector), original = await input.inputValue();
      await input.fill(changed);
      await progress(page, 3);
      await expect(page.locator('#approve-launch')).not.toBeChecked();
      await expect(page.locator('#export-launch')).toBeDisabled();
      await expect(page.locator('#launch-review')).toBeHidden();
      await input.fill(original);
      await progress(page, 3);
      await saveAndReview(page);
      await acknowledge(page);
    }

    // Abort one real IndexedDB write. Restoring the API before abort keeps subsequent recovery native.
    const before = (await savedDrafts(page))[0];
    await page.locator('#title').fill('Unsaved after storage failure');
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.__offerSetupWriteAborted = false;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name !== 'drafts') return put.apply(this, args);
        IDBObjectStore.prototype.put = put;
        const request = put.apply(this, args);
        window.__offerSetupWriteAborted = true;
        this.transaction.abort();
        return request;
      };
    });
    await (await action(page, 'Save offer')).click();
    await expect(page.locator('#status')).toHaveAttribute('data-error', 'true');
    assert.equal(await page.evaluate(() => window.__offerSetupWriteAborted), true, 'The native write was attempted and aborted');
    await expect(page.locator('#title')).toHaveValue('Unsaved after storage failure');
    await expect(page.locator('#save-state')).toHaveText('Unsaved changes');
    await progress(page, 3);
    await expect(page.locator('#approve-launch')).not.toBeChecked();
    await expect(page.locator('#export-launch')).toBeDisabled();
    assert.deepEqual((await savedDrafts(page))[0], before, 'Failed save leaves the saved revision intact');
    await saveAndReview(page);
    await acknowledge(page);

    // A peer writer makes this editor stale without replacing its unsaved text or review authority.
    const peer = await context.newPage();
    await peer.goto(url + '#vendor-editor');
    await peer.locator('#draft-list button').first().click();
    await page.locator('#description').fill('PRIVATE unsaved text to preserve');
    await peer.locator('#title').fill('Changed in setup peer');
    await peer.locator('#save').click();
    await expect(peer.locator('#save-state')).toHaveText('Saved on this device');
    const reload = await action(page, 'Reload saved offer');
    await expect(reload).toBeVisible();
    await progress(page, 3);
    await expect(page.locator('#description')).toHaveValue('PRIVATE unsaved text to preserve');
    await expect(page.locator('#approve-launch')).not.toBeChecked();
    await expect(page.locator('#export-launch')).toBeDisabled();
    page.once('dialog', dialog => dialog.dismiss());
    await reload.click();
    await expect(page.locator('#description')).toHaveValue('PRIVATE unsaved text to preserve');
    await expect(reload).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await reload.click();
    await expect(page.locator('#title')).toHaveValue('Changed in setup peer');
    await expect(page.locator('#description')).toHaveValue(before.description);
    await progress(page, 3);
    await expect(await action(page, 'Review saved offer')).toBeVisible();
    await expect(page.locator('#approve-launch')).not.toBeChecked();

    // An older client can write without broadcasting. The save conflict must offer reload itself.
    const unannounced = await peer.evaluate(async () => {
      const bootstrap = document.querySelector('script[type=module]').src;
      const { listDrafts, saveDraft } = await import(new URL('drafts.js', bootstrap).href);
      const draft = (await listDrafts())[0];
      await saveDraft({ ...draft, title: 'Unannounced peer revision' }, draft.revision);
      return (await listDrafts())[0];
    });
    await expect(page.locator('#title')).toHaveValue('Changed in setup peer');
    await expect(await action(page, 'Review saved offer')).toBeVisible();
    await page.locator('#description').fill('PRIVATE edits after unannounced revision');
    await (await action(page, 'Save offer')).click();
    await expect(page.locator('#status')).toContainText('changed in another tab');
    await expect(await action(page, 'Reload saved offer')).toBeVisible();
    await expect(page.locator('#description')).toHaveValue('PRIVATE edits after unannounced revision');
    await progress(page, 3);
    await expect(page.locator('#approve-launch')).not.toBeChecked();
    await expect(page.locator('#export-launch')).toBeDisabled();
    assert.deepEqual((await savedDrafts(page))[0], unannounced, 'A conflicting save cannot overwrite the unannounced revision');

    // Hold only delivery of the next native open success; the real database and reads stay intact.
    await page.evaluate(() => {
      const open = IDBFactory.prototype.open;
      const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
      window.__offerSetupOpenHeld = false;
      IDBFactory.prototype.open = function (...args) {
        const request = open.apply(this, args);
        if (args[0] !== 'agentic-commerce-local-drafts') return request;
        IDBFactory.prototype.open = open;
        Object.defineProperty(request, 'onsuccess', { configurable: true,
          set(handler) {
            success.set.call(request, event => {
              window.__offerSetupOpenHeld = true;
              let released = false;
              window.__offerSetupReleaseOpen = () => {
                if (released) return;
                released = true; clearTimeout(timeout); handler.call(request, event);
              };
              const timeout = setTimeout(window.__offerSetupReleaseOpen, 10000);
            });
          },
        });
        return request;
      };
    });
    page.once('dialog', dialog => dialog.accept());
    await (await action(page, 'Reload saved offer')).click();
    await page.waitForFunction(() => window.__offerSetupOpenHeld === true);
    try {
      await expect(page.locator('#setup-status')).toHaveText('Checking this offer…');
      const editorControls = page.locator('[data-view-panel="vendor-editor"] button, [data-view-panel="vendor-editor"] input, [data-view-panel="vendor-editor"] textarea');
      assert(await editorControls.count() > 15, 'The delayed read checks the complete editor controls');
      assert.equal(await editorControls.evaluateAll(elements => elements.every(element => element.disabled)), true,
        'Reload disables editing and actions before waiting for native storage');
      await expect(page.locator('#title')).toHaveValue('Changed in setup peer');
      await expect(page.locator('#description')).toHaveValue('PRIVATE edits after unannounced revision');
    } finally {
      await page.evaluate(() => window.__offerSetupReleaseOpen());
    }
    await expect(page.locator('#title')).toHaveValue(unannounced.title);
    await expect(page.locator('#description')).toHaveValue(unannounced.description);
    await expect(page.locator('#title')).toBeEnabled();
    await expect(page.locator('#setup-status')).toContainText(`Revision ${unannounced.revision} saved on this device`);
    await expect(await action(page, 'Review saved offer')).toBeEnabled();
    await progress(page, 3);
    await expect(page.locator('#launch-review')).toBeHidden();
    await expect(page.locator('#approve-launch')).not.toBeChecked();
  } finally {
    await context.close();
  }
}
