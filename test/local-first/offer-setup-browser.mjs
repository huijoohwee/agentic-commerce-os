import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

const steps = ['describe', 'identity', 'economics', 'review'];
const amounts = ['#delivery-cost', '#provider-fee', '#agent-cost', '#acquisition-cost', '#fixed-cost'];
const guide = page => page.locator('#setup-guide-panel');
const step = (page, name) => guide(page).locator(`button[data-step-id="${name}"]`);
const closeButton = page => guide(page).getByRole('button', { name: 'Close offer setup', exact: true });

async function openGuide(page) {
  const launcher = page.locator('#open-setup-guide');
  if (await launcher.getAttribute('aria-expanded') !== 'true') await launcher.click();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  await expect(guide(page).getByRole('heading', { name: 'Offer setup', exact: true })).toBeVisible();
  await expect(guide(page).locator('button[data-step-id]')).toHaveCount(4);
  return guide(page);
}

async function closeGuide(page) {
  if (await page.locator('#open-setup-guide').getAttribute('aria-expanded') !== 'true') return;
  await closeButton(page).click();
  await expect(guide(page)).toHaveCount(0);
  await expect(page.locator('#open-setup-guide')).toHaveAttribute('aria-expanded', 'false');
}

async function selectStep(page, name) {
  await openGuide(page);
  await step(page, name).click();
  await expect(step(page, name)).toHaveAttribute('aria-pressed', 'true');
  return guide(page);
}

async function stepStatus(page, name, status) {
  await openGuide(page);
  await expect(step(page, name)).toContainText(status);
  await closeGuide(page);
}

async function action(page, name) {
  return (await selectStep(page, 'review')).getByRole('button', { name, exact: true });
}

async function progress(page, count) {
  await expect(page.locator('#setup-count')).toHaveText(`${count} of 4 steps complete`);
  if (await page.locator('#open-setup-guide').getAttribute('aria-expanded') === 'true')
    await expect(step(page, 'review')).toContainText(count === 4 ? 'Complete' : 'Needs attention');
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
  await expect(guide(page)).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#approve-launch')).toBeFocused();
  await expect(page.locator('#approve-launch')).not.toBeChecked();
  await expect(page.locator('#export-launch')).toBeDisabled();
  await progress(page, 3);
  await page.keyboard.press('Space');
  await expect(page.locator('#approve-launch')).toBeChecked();
  await progress(page, 4);
}

async function checkGuideChrome(page, defaultGlyph = true) {
  const geometry = await closeButton(page).evaluate(button => {
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const icon = button.querySelector('svg');
    return { button: bounds(button), icon: bounds(icon), header: bounds(button.closest('header')),
      controlHeight: parseFloat(getComputedStyle(button).getPropertyValue('--kg-control-height')),
      touchTarget: matchMedia('(pointer: coarse), (max-width: 768px)').matches,
      strokeWidth: Number(icon.getAttribute('stroke-width')) };
  });
  const target = geometry.touchTarget ? 44 : 28;
  assert.equal(geometry.controlHeight, target, 'The guide inherits the native fine/touch control-height token');
  assert(Math.abs(geometry.button.height - Math.max(target, geometry.icon.height)) <= 1,
    'Close uses the native control height and grows enough for an enlarged shared glyph');
  assert(geometry.button.width >= target, 'Close preserves the native minimum target width');
  assert(Math.abs(geometry.header.height - geometry.button.height) <= 1, 'The floating header stays compact around its native control');
  assert.equal(geometry.strokeWidth, 1.5, 'The close glyph inherits the shared default stroke');
  if (defaultGlyph) {
    assert.equal(geometry.icon.width, 16, 'The default native glyph is 16px wide');
    assert.equal(geometry.icon.height, 16, 'The default native glyph is 16px high');
  }
  assert(geometry.icon.left >= geometry.button.left && geometry.icon.right <= geometry.button.right
    && geometry.icon.top >= geometry.button.top && geometry.icon.bottom <= geometry.button.bottom,
  'The close glyph remains fully inside its target, including with doubled text');
}

async function coarseGuideControls({ browser, url, observeContext }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
  observeContext(context);
  try {
    const page = await context.newPage();
    await page.goto(url + '#vendor-editor');
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    await openGuide(page);
    await checkGuideChrome(page);
    await closeGuide(page);
    await expect(page.locator('#open-setup-guide')).toBeFocused();
  } finally {
    await context.close();
  }
}

async function responsiveGuide(page, output) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const normalFont = await page.locator('#setup-count').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.locator('#setup-count').evaluate(element => parseFloat(getComputedStyle(element).fontSize)), normalFont * 2,
    'Setup progress follows the native text scale at 200%');
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await selectStep(page, 'review');
    await checkGuideChrome(page, false);
    await step(page, 'review').scrollIntoViewIfNeeded();
    const panel = guide(page).locator('[data-kg-floating-panel-root="true"]');
    const geometry = await panel.evaluate(section => {
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      };
      const close = section.querySelector('header button');
      const page = { innerWidth, documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth, bodyWidth: document.body.scrollWidth };
      const overflow = [...document.body.querySelectorAll('*')].flatMap(element => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || rect.right <= innerWidth + 1 || getComputedStyle(element).display === 'none') return [];
        const bounds = node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right,
          width: box.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; };
        const ancestors = [];
        for (let node = element.parentElement; node && ancestors.length < 5; node = node.parentElement) {
          const style = getComputedStyle(node);
          ancestors.push({ tag: node.tagName.toLowerCase(), id: node.id,
            className: typeof node.className === 'string' ? node.className.slice(0, 100) : '',
            ...bounds(node), overflowX: style.overflowX, minWidth: style.minWidth, width: style.width });
        }
        return [{ tag: element.tagName.toLowerCase(), id: element.id,
          className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
          text: element.textContent?.trim().slice(0, 80) ?? '',
          href: element.tagName === 'A' ? element.getAttribute('href') : null,
          parent: element.parentElement ? { tag: element.parentElement.tagName.toLowerCase(),
            id: element.parentElement.id, className: typeof element.parentElement.className === 'string'
              ? element.parentElement.className.slice(0, 100) : '' } : null,
          ancestors,
          left: rect.left, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth }];
      }).slice(0, 8);
      return { pageFits: page.documentWidth <= innerWidth, page, overflow, section: bounds(section),
        actions: [...section.querySelectorAll('button')].filter(button => button !== close).map(bounds) };
    });
    assert.equal(geometry.pageFits, true,
      `No page overflow at ${width}px with doubled text: ${JSON.stringify({ page: geometry.page, overflow: geometry.overflow })}`);
    assert(geometry.section.left >= 0 && geometry.section.right <= width + 1, `Setup stays within ${width}px`);
    assert(geometry.section.top >= 0 && geometry.section.bottom <= 901, `Setup stays within the viewport height at ${width}px`);
    for (const bounds of geometry.actions) {
      assert(bounds.height >= 44 && bounds.width >= 44, `Setup targets remain at least 44px at ${width}px`);
      assert(bounds.scrollWidth <= bounds.clientWidth + 1, `Setup action text is not clipped at ${width}px`);
    }
    await expect(closeButton(page)).toBeInViewport();
    await expect(step(page, 'review')).toBeInViewport();
    await panel.screenshot({ path: path.join(output, `offer-setup-${width}-200pct.png`) });
    await closeGuide(page);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 768, height: 900 });
}

async function delayedGuideLifecycle({ browser, url, observeContext }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  observeContext(context);
  let release, requested = false;
  const held = new Promise(resolve => { release = resolve; });
  try {
    await context.route('**/graph-data-view.js', async route => { requested = true; await held; await route.continue(); });
    const page = await context.newPage();
    await page.goto(url + '#vendor-editor');
    const launcher = page.locator('#open-setup-guide');
    await launcher.click();
    await expect.poll(() => requested).toBe(true);
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#vendor-navigation a[data-view="vendor"]').click();
    await expect(guide(page)).toHaveCount(0);
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    release();
    await page.evaluate(async () => {
      const bootstrap = document.querySelector('script[type=module]').src;
      await import(new URL('graph-data-view.js', bootstrap).href);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(guide(page)).toHaveCount(0);
    await page.locator('#vendor-navigation a[data-view="vendor-editor"]').click();
    await openGuide(page);
    await expect(guide(page)).toHaveCount(1);
    await checkGuideChrome(page);
    await closeGuide(page);
    await expect(launcher).toBeFocused();
  } finally {
    release(); await context.close();
  }
}

export async function checkOfferSetup({ browser, url, output, observeContext }) {
  await delayedGuideLifecycle({ browser, url, observeContext });
  await coarseGuideControls({ browser, url, observeContext });
  const context = await browser.newContext({ viewport: { width: 768, height: 900 }, acceptDownloads: true });
  observeContext(context);
  try {
    const page = await context.newPage();
    await page.goto(url + '#vendor-editor');
    await page.getByText('Offline access is ready.', { exact: false }).waitFor();
    await expect(page.locator('#offer-setup').getByRole('heading', { name: 'Offer setup', exact: true })).toBeVisible();
    await expect(page.locator('#setup-status')).toHaveAttribute('role', 'status');
    const launcher = page.locator('#open-setup-guide');
    await expect(launcher).toHaveAttribute('aria-controls', 'setup-guide-panel');
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await expect(guide(page)).toHaveCount(0);
    await launcher.focus(); await page.keyboard.press('Enter');
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    await expect(guide(page).getByRole('heading', { name: 'Offer setup', exact: true })).toBeFocused();
    await expect(guide(page).locator('button[data-step-id]')).toHaveCount(4);
    await checkGuideChrome(page);
    await progress(page, 0);
    for (const name of steps) await expect(step(page, name)).toContainText('Needs attention');
    await selectStep(page, 'review');
    assert.equal((await savedDrafts(page)).length, 0, 'Selecting a guide step has no save effect');
    await expect(page.locator('#launch-review')).toBeHidden();
    await expect(page.locator('#approve-launch')).not.toBeChecked();
    await closeButton(page).focus(); await page.keyboard.press('Escape');
    await expect(guide(page)).toHaveCount(0);
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await expect(launcher).toBeFocused();
    await openGuide(page); await closeGuide(page);
    await expect(launcher).toBeFocused();
    await openGuide(page);
    await page.locator('#vendor-navigation a[data-view="vendor"]').click();
    await expect(guide(page)).toHaveCount(0);
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#vendor-navigation a[data-view="vendor-editor"]').click();
    await expect(guide(page)).toHaveCount(0);

    await (await action(page, 'Save offer')).click();
    await expect(guide(page)).toHaveCount(0);
    await expect(page.locator('#title')).toBeFocused();
    assert.equal((await savedDrafts(page)).length, 0, 'Invalid native form stays unsaved and visible');

    // A keyboard guide action opens native launch details and focuses the first missing field.
    await page.locator('#title').fill('Setup browser offer');
    await progress(page, 0);
    const describe = await selectStep(page, 'describe');
    await expect(page.locator('#launch-fields')).not.toHaveAttribute('open');
    await describe.getByRole('button', { name: 'Edit description', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(guide(page)).toHaveCount(0);
    await expect(page.locator('#launch-fields')).toHaveAttribute('open', '');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#audience')).toBeFocused();
    await page.locator('#audience').fill('Independent makers who need one clear outcome');
    await progress(page, 0);
    await page.locator('#outcome').fill('One reviewed setup checklist');
    await progress(page, 1);
    await stepStatus(page, 'describe', 'Complete');

    const identity = await selectStep(page, 'identity');
    await identity.getByRole('button', { name: 'Edit identifiers', exact: true }).click();
    await expect(page.locator('#merchant-id')).toBeFocused();
    await page.locator('#merchant-id').fill('INVALID STORE');
    await page.locator('#agent-id').fill('dev-setup-agent');
    await progress(page, 1);
    await page.locator('#merchant-id').fill('setup-store');
    await progress(page, 2);
    await stepStatus(page, 'identity', 'Complete');

    const economics = await selectStep(page, 'economics');
    await economics.getByRole('button', { name: 'Edit estimates', exact: true }).click();
    await expect(page.locator('#currency')).toBeFocused();
    await page.locator('#currency').fill('USD');
    await page.locator('#sale-price').fill('10.00');
    // Blank costs must not silently become zero; each explicit zero is a valid estimate.
    await progress(page, 2);
    for (const selector of amounts) await page.locator(selector).fill('0');
    await progress(page, 3);
    await stepStatus(page, 'economics', 'Complete');
    await page.locator('#sale-price').fill('0');
    await progress(page, 2);
    await page.locator('#sale-price').fill('10.00');
    await page.locator('#delivery-cost').fill('12.00');
    await progress(page, 2);
    await stepStatus(page, 'economics', 'Needs attention');
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
    await closeGuide(page); await stepStatus(page, 'review', 'Complete');
    await expect(page.locator('#approve-launch')).toBeChecked();

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
      assert.equal(await guide(page).locator('button[data-step-id]').evaluateAll(elements => elements.length === 4 && elements.every(element => element.disabled)), true,
        'The portaled native guide disables every step during the same storage wait');
      await expect(guide(page).getByRole('button', { name: 'Reload saved offer', exact: true })).toBeDisabled();
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
