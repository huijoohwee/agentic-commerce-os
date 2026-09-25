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
  let releaseModule = () => {};
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
    await expect(page.getByRole('complementary', { name: 'Console' })).toBeVisible();
    await expect(consoleToggle).toHaveAttribute('aria-expanded', 'true');
    const dock = await page.locator('#console-panel').boundingBox();
    const workspace = await page.locator('#builder').boundingBox();
    assert(workspace.x + workspace.width <= dock.x);
    await expect(page.locator('#console-tool-count')).toHaveText('1 browser tool');
    assert.equal(requests.some(request => request.url.endsWith('/workspace-pack.simulation.js')), false);
    const scenario = page.getByLabel('Scenario', { exact: true });
    const runSimulation = page.getByRole('button', { name: 'Run simulation', exact: true });
    const stages = page.getByRole('group', { name: 'Response stage', exact: true });
    const liveActivity = await page.locator('#console-events').innerText();
    await expect(stages.getByRole('button', { name: 'Recovery', exact: true })).toBeDisabled();
    // A selection made during first lazy import must retire the older pending run.
    const moduleGate = new Promise(resolve => { releaseModule = resolve; });
    await page.route('**/workspace-pack.simulation.js', async route => { await moduleGate; await route.continue(); });
    const loading = page.waitForRequest(request => request.url().endsWith('/workspace-pack.simulation.js'));
    await runSimulation.click(); await loading;
    await scenario.selectOption('checkout'); releaseModule();
    await expect(page.locator('#simulation-report')).toBeHidden();
    for (const [value, label, status] of [['calm', 'Calm', 200], ['checkout', 'Checkout', 403],
      ['timeout', 'Timeout', 504], ['payment', 'Payment', 409], ['backlog', 'Backlog', 503]]) {
      await scenario.selectOption(value); await runSimulation.click();
      await expect(page.locator('#simulation-status')).toHaveText(`${label} · Simulated condition loaded`);
      await expect(stages.getByRole('button', { name: 'Triage', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#simulation-signal')).toContainText(`Fixture HTTP ${status}`);
      await expect(page.locator('#simulation-recover')).toBeHidden();
      await stages.getByRole('button', { name: 'Diagnosis', exact: true }).click();
      await expect(page.locator('#simulation-report-heading')).toHaveText('Understand the condition');
      await stages.getByRole('button', { name: 'Recovery', exact: true }).click();
      await page.getByRole('button', { name: 'Apply to simulation', exact: true }).click();
      await expect(page.locator('#simulation-status')).toHaveText(`${label} · Simulation complete`);
      await expect(page.locator('#simulation-signal')).toHaveText('Fixture HTTP 200');
      await expect(page.locator('#simulation-recover')).toBeDisabled();
    }
    await page.screenshot({ path: path.join(output, 'workspace-pack-simulation-desktop.jpg'), quality: 75 });
    await scenario.selectOption('timeout');
    await expect(page.locator('#simulation-report')).toBeHidden();
    await expect(stages.getByRole('button', { name: 'Recovery', exact: true })).toBeDisabled();
    await context.setOffline(true); await runSimulation.click();
    await expect(page.locator('#simulation-status')).toHaveText('Timeout · Simulated condition loaded');
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(runSimulation).toBeFocused();
    await expect(source).toHaveValue(original);
    await expect(page.locator('#console-form-state')).toHaveText('Prepare your source');
    assert.equal(await page.locator('#console-events').innerText(), liveActivity);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    assert.equal(requests.filter(request => request.url.endsWith('/workspace-pack.simulation.js')).length, 1);
    record('five lazy-loaded scenario rehearsals, staged/reviewed recovery, stale-selection reset and offline replay leave live state and requests untouched');
    await page.screenshot({ path: path.join(output, 'workspace-pack-console-desktop.jpg'), quality: 75 });
    await page.locator('#console-review').click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('#console-form-state')).toHaveText('Waiting for your review');
    await expect(page.locator('[data-stage=review]')).toHaveAttribute('aria-current', 'step');
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#console-form-state')).toHaveText('Ready to review');
    await expect(page.locator('#console-review')).toBeFocused();
    await expect(page.locator('#console-service')).toHaveText('Ready');
    await expect(page.locator('#console-browser-tool')).toHaveText('Registered');
    await expect(page.locator('#console-events')).toContainText('Browser WebMCP tool registered');
    assert.equal((await page.locator('#console-events').innerText()).includes(original), false);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#console-panel')).toBeHidden();
    await expect(consoleToggle).toBeFocused();
    record('Console docks without overlap on desktop; its review action uses the existing form gate with no pre-confirmation POST');
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
    await expect(page.locator('#console-form-state')).toHaveText('Four files verified');
    await expect(page.locator('[data-stage=files]')).toHaveAttribute('aria-current', 'step');
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
    await expect(page.locator('#console-form-state')).toHaveText('Review to try again');
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
    await runSimulation.click();
    await stages.getByRole('button', { name: 'Diagnosis', exact: true }).click();
    await stages.getByRole('button', { name: 'Recovery', exact: true }).click();
    await expect(page.locator('#simulation-recover')).toBeEnabled();
    const simGeometry = await page.locator('#simulation-run').boundingBox();
    assert(simGeometry.width >= 44 && simGeometry.height >= 44);
    await expect(page.locator('#console-events')).toContainText('Browser tool invoked.');
    await expect(page.locator('#console-events')).toContainText('Browser tool returned a verified pack.');
    assert.equal((await page.locator('#console-events').innerText()).includes(original), false);
    assert.equal(await page.locator('#console-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.getByRole('button', { name: 'Close Console' }).click();
    record('browser tool uses real conversion and Console records only bounded metadata at mobile width');
    await page.reload();
    await expect(create).toBeEnabled();
    await expect(page.locator('#console-panel')).toBeHidden();
    await consoleToggle.click();
    await expect(page.locator('#console-panel')).toBeVisible();
    await page.screenshot({ path: path.join(output, 'workspace-pack-console-mobile.jpg'), quality: 75 });
    record('a fresh mobile visit keeps the Console closeable and reachable from navigation');
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
  } finally { releaseModule(); await context.close(); }
}
