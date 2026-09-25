import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';

const sha = text => createHash('sha256').update(text).digest('hex');
export async function checkWorkspacePack({ browser, url, output, revision }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true,
    reducedMotion: 'reduce' });
  const requests = [], errors = [], checks = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const record = name => checks.push(name);
  try {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'modelContext', { configurable: true,
        value: { registerTool(tool) { window.__workspacePackTool = tool; } } });
    });
    await page.goto(url + 'services/workspace-pack/');
    const create = page.getByRole('button', { name: 'Review request', exact: true });
    const dialog = page.getByRole('dialog'), confirm = page.getByRole('button', { name: 'Create free pack', exact: true });
    const source = page.locator('#source'), title = page.getByLabel('Pack name');
    await expect(create).toBeEnabled();
    const original = await source.inputValue();
    const consoleToggle = page.getByRole('button', { name: 'Console', exact: true });
    await consoleToggle.click();
    await expect(page.getByRole('complementary', { name: 'Console' })).toBeVisible();
    await expect(page.locator('#console-service')).toHaveText('Ready');
    await expect(page.locator('#console-browser-tool')).toHaveText('Registered');
    await expect(page.locator('#console-events')).toContainText('Browser WebMCP tool registered');
    assert.equal((await page.locator('#console-events').innerText()).includes(original), false);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#console-panel')).toBeHidden();
    await expect(consoleToggle).toBeFocused();
    record('Console opens with truthful capability state, tab-only activity and no source leak or request');
    await page.screenshot({ path: path.join(output, 'workspace-pack-desktop.jpg'), quality: 75, fullPage: true });
    await create.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('#close-review')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#edit-request')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#close-review')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(create).toBeFocused();
    await expect(source).toHaveValue(original);
    await create.click();
    await page.mouse.click(10, 10);
    await expect(dialog).not.toBeVisible();
    await create.click();
    await page.getByRole('button', { name: 'Back to editing', exact: true }).click();
    await expect(source).toBeFocused();
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    record('review, focus trap, Escape, backdrop and edit preserve source without a POST');
    await title.fill('Reviewed program');
    await create.click();
    await expect(page.locator('#review-title')).toHaveText('Reviewed program');
    await expect(page.locator('#review-size')).toContainText('194 bytes');
    await page.screenshot({ path: path.join(output, 'workspace-pack-review.jpg'), quality: 75 });
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/workspace-pack/api') && response.request().method() === 'POST');
    await confirm.click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const pack = await response.json();
    await expect(page.locator('#result-badge')).toHaveText('4 files verified');
    await expect(page.locator('#result-heading')).toBeFocused();
    assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(pack.title, 'Reviewed program');
    assert.equal(pack.files[0].content, original);
    assert.equal(pack.sourceDigest, sha(original));
    await consoleToggle.click();
    await expect(page.locator('#console-events')).toContainText('Form review opened. Source not sent.');
    await expect(page.locator('#console-events')).toContainText('Form conversion returned four verified files.');
    assert.equal((await page.locator('#console-events').innerText()).includes(original), false);
    await page.getByRole('button', { name: 'Close Console' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download full pack', exact: false }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'workspace-program-pack.json');
    const downloaded = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.deepEqual(downloaded, pack);
    for (const file of downloaded.files) assert.equal(sha(file.content), file.digest);
    const { artifactDigest, ...unsigned } = downloaded;
    assert.equal(sha(JSON.stringify(unsigned)), artifactDigest);
    record('one confirmed request creates the reviewed pack; actual browser download matches all four hashes');
    await source.fill('import os\n');
    await expect(page.locator('#result')).toBeHidden();
    await create.click(); await confirm.click();
    await expect(page.locator('#status')).toContainText('Could not create this pack');
    await expect(source).toHaveValue('import os\n');
    await expect(page.locator('#result')).toBeHidden();
    record('changed source retires the previous result and refused syntax preserves editable input');
    await source.fill(original);
    await context.setOffline(true);
    await create.click(); await expect(dialog).toBeVisible(); await confirm.click();
    await expect(page.locator('#status')).toContainText('Could not create this pack');
    await expect(source).toHaveValue(original);
    await expect(create).toBeEnabled();
    await context.setOffline(false);
    await create.click(); await confirm.click();
    await expect(page.locator('#result-badge')).toHaveText('4 files verified');
    record('offline conversion fails visibly; source remains and an explicit reviewed retry succeeds');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(page.locator('#preview')).toContainText('flowchart TD');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await create.click(); await expect(dialog).toBeVisible();
    const geometry = await page.evaluate(() => {
      const selectors = ['#close-review', '#confirm-request', '#edit-request'];
      return selectors.map(selector => { const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, width: rect.width, height: rect.height }; });
    });
    assert(geometry.every(rect => rect.width >= 44 && rect.height >= 44));
    const appearance = await page.evaluate(() => {
      const rgb = text => text.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = values => values.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; })
        .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const surface = rgb(getComputedStyle(document.querySelector('#request-review')).backgroundColor);
      const ink = rgb(getComputedStyle(document.querySelector('#review-heading')).color);
      const muted = rgb(getComputedStyle(document.querySelector('#review-disclosure')).color);
      const button = getComputedStyle(document.querySelector('#confirm-request'));
      const focus = getComputedStyle(document.querySelector('#close-review'));
      return { primary: contrast(ink, surface), secondary: contrast(muted, surface),
        button: contrast(rgb(button.color), rgb(button.backgroundColor)),
        focus: contrast(rgb(focus.outlineColor), surface),
        typography: getComputedStyle(document.body).fontFamily,
        codeTypography: getComputedStyle(document.querySelector('#source')).fontFamily,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    assert(appearance.primary >= 4.5 && appearance.secondary >= 4.5 && appearance.button >= 4.5 && appearance.focus >= 3);
    assert.equal(appearance.reducedMotion, true);
    await page.screenshot({ path: path.join(output, 'workspace-pack-mobile-review.jpg'), quality: 75 });
    await page.keyboard.press('Escape');
    // Real computed-font enlargement checks text reflow; it does not claim browser zoom preference coverage.
    await page.evaluate(() => {
      const elements = [...document.querySelectorAll('body, body *')];
      const sizes = elements.map(element => getComputedStyle(element).fontSize);
      elements.forEach((element, index) => { element.style.fontSize = `${parseFloat(sizes[index]) * 2}px`; });
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await create.click(); await expect(dialog).toBeVisible();
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.getByRole('button', { name: 'Back to editing', exact: true }).click();
    record('390px layout, 44px drawer controls, computed contrast, reduced motion and 200% text reflow');
    const toolOutput = await page.evaluate(async input => window.__workspacePackTool.execute(input),
      { title: 'Browser tool check', source: original, sourceDigest: sha(original) });
    const toolPack = JSON.parse(toolOutput.content[0].text);
    assert.equal(toolPack.sourceDigest, sha(original));
    assert.equal(toolPack.files.length, 4);
    await consoleToggle.click();
    await expect(page.locator('#console-events')).toContainText('Browser tool invoked.');
    await expect(page.locator('#console-events')).toContainText('Browser tool returned a verified pack.');
    assert.equal((await page.locator('#console-events').innerText()).includes(original), false);
    assert.equal(await page.locator('#console-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.getByRole('button', { name: 'Close Console' }).click();
    record('browser tool uses real conversion and Console records only bounded metadata at mobile width');
    assert.deepEqual(errors, []);
    const origin = new URL(url).origin;
    assert(requests.every(request => new URL(request.url).origin === origin));
    assert(requests.filter(request => request.method === 'POST').every(request => request.url === url + 'services/workspace-pack/api'));
    fs.writeFileSync(path.join(output, 'workspace-pack-browser-proof.json'), JSON.stringify({ ok: true,
      sourceRevision: revision, checks, artifactDigest, appearance, geometry, requests,
      completedAt: new Date().toISOString(), boundary: 'native browser and local service; no marketplace or payment claim' }, null, 2) + '\n');
    console.log('PASS Workspace Program Pack review, download, recovery and mobile accessibility');
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'workspace-pack-failure.jpg'), quality: 75 }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
