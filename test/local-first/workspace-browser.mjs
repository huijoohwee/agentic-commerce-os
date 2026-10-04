import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs';

export async function checkRoleWorkspace({ browser, url, output, observeContext, record }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  observeContext(context);
  // API contract fixture; native browser availability is checked separately in live UI verification.
  await context.addInitScript(() => {
    const tools = new Map();
    Object.defineProperty(document, 'modelContext', { value: {
      async registerTool(tool, { signal }) {
        if (signal.aborted) throw Error('cancelled');
        if (tools.has(tool.name)) throw Error('duplicate'); tools.set(tool.name, tool);
        signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
      },
      async getTools() { return [...tools.values()].map(tool => ({ ...tool, inputSchema: JSON.stringify(tool.inputSchema) })); },
      async executeTool(tool, input) { return tools.get(tool.name).execute(input, {}); },
    } });
  });
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
  await page.locator('#admin').getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('#environment-badge')).toHaveText('Not checked');
  await context.setOffline(true); await context.setOffline(false);
  await expect(page.locator('#environment-status')).not.toContainText('Offline.');
  await page.getByRole('button', { name: 'Check environment', exact: true }).click();
  await expect(page.locator('#environment-badge')).toHaveText('Sandbox configured');
  await expect(page.locator('#environment-status')).toContainText('No real payment');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `environment-${width}.png`), fullPage: true });
  }
  await context.setOffline(true);
  await expect(page.locator('#environment-badge')).toHaveText('Offline');
  await expect(page.locator('#environment-checkout')).toContainText('Unknown');
  await expect(page.locator('#environment-refresh')).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator('#environment-badge')).toHaveText('Stale · Check again');
  const sourceRevision = await page.locator('meta[name="commerce-source"]').getAttribute('content');
  const readiness = { ok: true, profile: 'local-first', storage: 'browser-only', realMoney: false,
    checkout: 'sandbox', paymentStorage: 'stripe-test', paymentProvider: 'stripe', workerVersionId: null, sourceRevision };
  for (const body of [JSON.stringify({ ...readiness, sourceRevision: 'f'.repeat(40) }), '{', ' '.repeat(32769)]) {
    await page.route('**/readyz', route => route.fulfill({ status: 200, contentType: 'application/json', body }));
    await page.locator('#environment-refresh').click();
    await expect(page.locator('#environment-badge')).toHaveText('Unknown');
    await expect(page.locator('#environment-checkout')).not.toContainText('Configured');
    await page.unroute('**/readyz');
  }
  let releaseRead;
  const heldRead = new Promise(resolve => { releaseRead = resolve; });
  await page.route('**/readyz', async route => { await heldRead; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readiness) }); });
  await page.locator('#environment-refresh').click();
  await expect(page.locator('#environment-refresh')).toBeDisabled();
  await page.locator('#environment-cancel').click();
  await expect(page.locator('#environment-status')).toContainText('cancelled');
  releaseRead(); await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('#environment-badge')).toHaveText('Unknown');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#admin').getByRole('link', { name: 'Data & portability', exact: true }).click();
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
  // The three roles share one shell while retaining their own data and keyboard destinations.
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + '#admin-tools');
    await expect(page.locator('#workspace-run')).toBeEnabled();
    const reference = await page.locator('#admin .workspace-content').boundingBox();
    for (const role of ['shop', 'vendor']) {
      await page.getByRole('navigation', { name: 'Workspace', exact: true })
        .getByRole('link', { name: role === 'shop' ? 'Shopper' : 'Vendor', exact: true }).click();
      await expect(page.locator('#' + role)).toBeVisible();
      const content = await page.locator('#' + role + ' .workspace-content').boundingBox();
      assert.equal(content.x, reference.x); assert.equal(content.width, reference.width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await expect(page.getByRole('navigation', { name: 'Workspace location' })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.locator('#' + role + '-query')).toBeFocused();
      await page.locator('#' + role + '-query').fill('absent offer');
      await expect(page.locator(role === 'shop' ? '#shop-empty' : '#vendor-table')).toContainText(role === 'shop' ? 'No offers match' : 'No matching offers');
      await page.locator('#' + role + '-query').fill('');
      await page.screenshot({ path: path.join(output, `aligned-${role}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url + '#vendor-editor');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#vendor-query')).toBeFocused();
  await page.goto(url + '#shop-sandbox');
  await expect(page.locator('#live-offer-heading')).toBeInViewport();

  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page.locator('#admin-reviewable')).toHaveText('12');
  await expect(page.locator('#admin-attention')).toHaveText('1');
  await expect(page.locator('#admin-stores')).toHaveText('2');
  await expect(page.locator('#project-list .project-card')).toHaveCount(2);
  await expect(page.locator('#project-list')).not.toContainText('PRIVATE');
  const activity = page.getByRole('table', { name: 'Recent offer activity', exact: true });
  await expect(activity.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('navigation', { name: 'Recent offer activity pagination', exact: true }).getByRole('button', { name: 'Next' }).click();
  await expect(activity.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('searchbox', { name: 'Search recent offer activity', exact: true }).fill('offer 03');
  await expect(activity.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('#workspace-activity')).not.toContainText('PRIVATE');
  await page.getByRole('searchbox', { name: 'Search recent offer activity', exact: true }).fill('');
  assert.equal(await page.locator('#project-list img').count(), 0);
  await page.locator('#project-query').fill('studio-north');
  await expect(page.locator('#project-list .project-card')).toHaveCount(1);
  await page.locator('#project-query').fill('absent merchant');
  await expect(page.locator('#project-list')).toContainText('No projects match.');
  await page.locator('#project-query').fill('');
  await page.screenshot({ path: path.join(output, 'projects-desktop.png'), fullPage: true });
  await page.locator('[data-project="store:studio-north"]').getByRole('link', { name: 'Project details', exact: true }).click();
  await expect(page.locator('#project-heading')).toHaveText('studio-north');
  await expect(page.getByRole('table', { name: 'Project offers', exact: true }).locator('tbody tr')).toHaveCount(6);
  await expect(page.locator('#project-detail')).not.toContainText('Independent offer 02');
  await expect(page.locator('#project-detail')).not.toContainText('PRIVATE');
  await expect(page.locator('#console-location')).toHaveText('studio-north');
  await expect(page.locator('#admin-project-select')).toHaveValue('store:studio-north');
  await page.getByRole('searchbox', { name: 'Search project offers', exact: true }).fill('offer 03');
  await expect(page.getByRole('table', { name: 'Project offers', exact: true }).locator('tbody tr')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search project offers', exact: true }).fill('');
  await page.getByRole('link', { name: 'Environment details', exact: true }).click();
  await page.reload();
  await expect(page.locator('#environment-history-count')).toHaveText('0 checks · Page 1 of 1');
  await expect(page.locator('#environment-scope')).toHaveText('studio-north');
  await expect(page.locator('#console-location')).toHaveText('studio-north / Environment');
  await expect(page.locator('#environment-latest')).toHaveText('Independent offer 11');
  await expect(page.locator('#environment-preview')).not.toContainText('PRIVATE');
  await page.locator('#environment-refresh').click();
  await expect(page.locator('#environment-badge')).toHaveText('Sandbox configured');
  await page.locator('#environment-history-query').fill('no such observation');
  await expect(page.locator('#environment-history')).toContainText('No checks match');
  await page.locator('#environment-history-query').fill('');
  await expect(page.getByRole('table', { name: 'Environment check history' }).locator('tbody tr').first()).toContainText('Sandbox configured');
  const firstCheck = page.getByRole('button', { name: 'Inspect environment check 1', exact: true });
  await firstCheck.click();
  const checkDetail = page.getByRole('dialog', { name: 'Environment check 1', exact: true });
  await expect(checkDetail).toBeVisible();
  await expect(page.locator('#environment-check-facts')).toContainText('HTTP response200');
  const retained = JSON.parse(await page.locator('#environment-check-evidence').textContent());
  assert.equal(retained.sourceRevision, await page.locator('meta[name="commerce-source"]').getAttribute('content'));
  assert.equal(retained.checkout, 'sandbox'); assert.equal(retained.realMoney, false);
  await page.keyboard.press('ControlOrMeta+k'); await expect(checkDetail).toBeVisible();
  await page.keyboard.press('Escape'); await expect(firstCheck).toBeFocused();
  await page.route('**/readyz', route => route.abort());
  await page.locator('#environment-refresh').click(); await expect(page.locator('#environment-badge')).toHaveText('Unknown');
  await page.getByLabel('Filter check result', { exact: true }).selectOption('unknown');
  await expect(page.locator('#environment-history-count')).toHaveText('1 check · Page 1 of 1');
  await page.locator('#environment-history').getByRole('button', { name: 'Inspect environment check 2', exact: true }).click();
  await expect(page.locator('#environment-check-evidence')).toHaveText('No verified response was retained.');
  await expect(page.locator('#environment-check-facts')).toContainText('No response');
  await page.keyboard.press('Escape'); await page.unroute('**/readyz');
  await page.getByLabel('Filter check result', { exact: true }).selectOption('');
  for (let i = 0; i < 19; i++) {
    await page.locator('#environment-refresh').click();
    await expect(page.locator('#environment-refresh')).toBeEnabled();
  }
  await expect(page.locator('#environment-history-count')).toHaveText('20 checks · Page 1 of 2');
  await expect(page.getByRole('table', { name: 'Environment check history' }).locator('tbody tr')).toHaveCount(10);
  await page.locator('#environment-history-next').click();
  await expect(page.locator('#environment-history-count')).toHaveText('20 checks · Page 2 of 2');
  await expect(firstCheck).toHaveCount(0);
  await page.locator('#environment-history-query').fill('check 21');
  await expect(page.locator('#environment-history-count')).toHaveText('1 check · Page 1 of 1');
  await page.locator('#environment-history-query').fill('');
  await page.getByLabel('Filter check result', { exact: true }).selectOption('unavailable');
  await expect(page.locator('#environment-history')).toContainText('No checks match these filters.');
  await page.getByLabel('Filter check result', { exact: true }).selectOption('');
  await page.getByRole('link', { name: 'Check history', exact: true }).click();
  await expect(page.locator('#environment-history-heading')).toBeInViewport();
  await expect(page.locator('#admin-environment-history-link')).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('#admin-environment-history-link')).toHaveAttribute('href', '#admin-runtime?project=store%3Astudio-north&section=checks');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(url + '#admin-runtime?project=store%3Astudio-north');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `aligned-environment-${width}.png`), fullPage: true });
    await page.screenshot({ path: path.join(output, `environment-inspection-${width}.png`) });
    await page.locator('#environment-history').getByRole('button', { name: 'Inspect environment check 21', exact: true }).click();
    assert.equal(await page.locator('#environment-check-detail').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: path.join(output, `environment-check-detail-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.locator('#environment-project-link').click();
  await expect(page.locator('#project-heading')).toHaveText('studio-north');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `project-detail-${width}.png`), fullPage: true });
  }
  await context.setOffline(true);
  await expect(page.locator('[data-environment-observation]')).toHaveText('Offline');
  await page.reload();
  await expect(page.locator('#project-heading')).toHaveText('studio-north');
  // Chromium may reset navigator.onLine after a service-worker navigation; no observation is retained.
  await expect(page.locator('[data-environment-observation]')).toHaveText(/^(Offline|Not checked)$/);
  assert.equal(await page.evaluate(() => fetch('./readyz').then(() => false, () => true)), true);
  await context.setOffline(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Search projects' }).click();
  await expect(page.locator('#project-query')).toBeFocused();
  await page.goBack();
  await expect(page.locator('#project-heading')).toHaveText('studio-north');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#project-query')).toBeFocused();
  await page.getByLabel('Project', { exact: true }).selectOption('store:solo-studio');
  await expect(page.locator('#project-heading')).toHaveText('solo-studio');
  await page.goto(url + '#admin-runtime?project=missing');
  await expect(page.locator('#environment-context')).toContainText('Project unavailable');
  await expect(page.locator('.environment-overview')).toBeHidden();
  await page.goto(url + '#admin-project?project=missing');
  await expect(page.locator('#project-heading')).toHaveText('Project unavailable');
  await expect(page.locator('#project-detail .project-card')).toHaveCount(0);
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  await expect(page.locator('#project-list .project-card')).toHaveCount(2);
  await page.goto(url + '#admin-project?project=store%3Astudio-north');
  const agentButton = page.getByRole('button', { name: 'Agent tools', exact: true });
  const drawer = page.getByRole('dialog', { name: 'Agent tools', exact: true });
  await agentButton.click();
  await expect(drawer).toBeVisible();
  await expect(page.locator('#workspace-agent-context')).toHaveText('Project · studio-north');
  await expect(page.locator('#workspace-tool')).toHaveValue('commerce.workspace.project.read');
  await expect(page.locator('#workspace-invocation')).toHaveValue('/tool.route @mcp-gateway #mcp commerce.workspace.project.read');
  await expect(page.locator('#workspace-result')).toBeEmpty();
  assert.equal(new URL(page.url()).hash, '#admin-project?project=store%3Astudio-north');
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-result')).toContainText('browser-local');
  const panelRead = JSON.parse(await page.locator('#workspace-result').textContent());
  assert.equal(panelRead.value.offers.length, 6);
  await page.locator('#workspace-webmcp-enable').click();
  await expect(page.locator('#workspace-webmcp-status')).toContainText('Four read-only tools registered');
  const browserRead = await page.evaluate(async () => {
    const api = document.modelContext, tools = await api.getTools();
    return api.executeTool(tools.find(tool => tool.name.endsWith('.project.read')), { projectId: 'store:studio-north' });
  });
  assert.deepEqual(browserRead, panelRead);
  await page.locator('#workspace-prepare').click();
  await expect(page.locator('#workspace-tool-status')).toContainText('Nothing was sent.');
  const prepared = JSON.parse(await page.locator('#workspace-result').textContent());
  assert.equal(prepared.params.arguments.snapshot.offers.length, 6);
  assert(prepared.params.arguments.snapshot.offers.every(offer => offer.launch.merchantId === 'studio-north'));
  assert(!JSON.stringify(prepared).includes('PRIVATE'));
  await page.getByRole('button', { name: 'Close agent tools', exact: true }).click();
  await expect(agentButton).toBeFocused();
  await expect.poll(() => page.evaluate(async () => (await document.modelContext.getTools()).length)).toBe(0);
  assert.equal(await page.locator('#workspace-tool').count(), 1);
  const inspectOffer = page.getByRole('button', { name: 'Inspect Independent offer 03 with agent tools', exact: true });
  await inspectOffer.click();
  await expect(page.locator('#workspace-tool')).toHaveValue('commerce.workspace.offer.review');
  await page.locator('#workspace-prepare').click();
  await expect(page.locator('#workspace-tool-status')).toContainText('Nothing was sent.');
  const offerRequest = JSON.parse(await page.locator('#workspace-result').textContent());
  assert.equal(offerRequest.params.arguments.snapshot.offers.length, 1);
  assert.equal(offerRequest.params.arguments.offerId, drafts[3].id);
  await page.locator('#workspace-arguments').fill(JSON.stringify({ offerId: drafts[3].id, expectedRevision: 99 }));
  await page.locator('#workspace-prepare').click();
  await expect(page.locator('#workspace-tool-status')).toHaveText('workspace_revision_changed');
  await expect(page.locator('#workspace-result')).toBeEmpty();
  await page.keyboard.press('Escape'); await expect(inspectOffer).toBeFocused();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + '#admin-runtime?project=store%3Astudio-north'); await agentButton.click();
    await expect(page.locator('#workspace-tool')).toHaveValue('commerce.workspace.environment.read');
    await expect(page.locator('#workspace-arguments')).toHaveValue('{}');
    await expect(page.locator('#workspace-result')).toBeEmpty();
    assert.equal(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `contextual-agent-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(agentButton).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url + '#admin-project?project=store%3Astudio-north');
  await context.setOffline(true); await page.reload(); await agentButton.click();
  await page.locator('#workspace-run').click(); await expect(page.locator('#workspace-result')).toContainText('studio-north');
  await page.keyboard.press('Escape'); await context.setOffline(false);
  await page.goto(url + '#admin-project?project=missing'); await agentButton.click();
  await expect(page.locator('#workspace-agent-status')).toContainText('project is unavailable');
  await expect(page.locator('#workspace-agent-content')).toBeEmpty(); await page.keyboard.press('Escape');
  await page.goto(url + '#admin');
  await page.locator('#admin').getByRole('link', { name: 'Tools & commands', exact: true }).click();
  await page.locator('#workspace-tool').selectOption('commerce.workspace.projects.list');
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-result')).toContainText('browser-local');
  await expect(page.locator('#workspace-result')).toContainText('studio-north');
  await expect(page.locator('#workspace-result')).not.toContainText('PRIVATE');
  await page.locator('#workspace-webmcp-enable').click();
  await expect(page.locator('#workspace-webmcp-status')).toContainText('Four read-only tools registered');
  const nativeList = await page.evaluate(async () => {
    const tools = await document.modelContext.getTools();
    return document.modelContext.executeTool(tools.find(tool => tool.name.endsWith('.projects.list')), {});
  });
  assert.deepEqual(nativeList, JSON.parse(await page.locator('#workspace-result').textContent()));
  const explicit = await page.evaluate(async () => {
    const tools = await document.modelContext.getTools();
    return document.modelContext.executeTool(tools.find(tool => tool.name.endsWith('.projects.list')),
      { snapshot: { schema: 'commerce.workspace-snapshot/v1', offers: [] } });
  });
  assert.equal(explicit.provenance, 'provided-snapshot'); assert.equal(explicit.value.projects[0].offerCount, 0);
  await page.locator('#workspace-tool').selectOption('commerce.workspace.offer.review');
  await page.locator('#workspace-arguments').fill(JSON.stringify({ offerId: drafts[1].id, expectedRevision: 999 }));
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-tool-status')).toHaveText('workspace_revision_changed');
  await page.locator('#workspace-arguments').fill(JSON.stringify({ offerId: drafts[1].id, expectedRevision: 1 }));
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-result')).toContainText('still-required');
  await page.locator('#workspace-prepare').click();
  await expect(page.locator('#workspace-tool-status')).toContainText('Nothing was sent.');
  await expect(page.locator('#workspace-result')).toContainText('commerce.workspace-snapshot/v1');
  await expect(page.locator('#workspace-result')).not.toContainText('PRIVATE');
  await page.locator('#workspace-tool').selectOption('commerce.workspace.projects.list');
  await page.locator('#workspace-invocation').fill('/tool.route @wrong #mcp commerce.workspace.projects.list');
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-tool-status')).toContainText('workspace_invocation_invalid');
  await page.locator('#workspace-invocation').fill('/tool.route @mcp-gateway #mcp commerce.workspace.projects.list');
  await page.locator('#workspace-run').click();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `workspace-tools-${width}.png`), fullPage: true });
  }
  const drift = await page.evaluate(async () => {
    const api = document.modelContext, original = api.getTools, tool = (await original())[0];
    api.getTools = async () => [];
    try { await api.executeTool(tool, {}); return 'unexpected success'; }
    catch (error) { return error.message; }
    finally { api.getTools = original; }
  });
  assert.match(drift, /registration changed/);
  await expect(page.locator('#workspace-webmcp-status')).toContainText('Disabled.');
  await page.locator('#workspace-webmcp-enable').click();
  await expect(page.locator('#workspace-webmcp-status')).toContainText('Four read-only tools registered');
  await page.locator('#workspace-webmcp-disable').click();
  assert.equal(await page.evaluate(async () => (await document.modelContext.getTools()).length), 0);
  await context.setOffline(true); await page.reload();
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-result')).toContainText('studio-north');
  await page.locator('#workspace-tool').selectOption('commerce.workspace.environment.read');
  await page.locator('#workspace-run').click();
  await expect(page.locator('#workspace-tool-status')).toContainText(/workspace_environment_(busy_or_offline|unverified)/);
  await context.setOffline(false);
  await page.locator('.console-sidebar').getByRole('link', { name: 'Projects', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'admin-desktop.png'), fullPage: true });
  await page.locator('#admin').getByRole('link', { name: 'Launch reviews', exact: true }).click();
  await page.locator('#admin-query').fill('offer 03');
  await expect(page.locator('#admin-table tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'Review offer ↗', exact: true }).click();
  await expect(page.getByLabel('What are you creating?')).toHaveValue('Independent offer 03');
  await expect(page.getByLabel('The idea', { exact: true })).toHaveValue('PRIVATE interview notes');
  await page.getByRole('button', { name: 'Review launch', exact: true }).click();
  await expect(page.locator('#launch-review')).toBeVisible();
  await expect(page.locator('#export-launch')).toBeDisabled();
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await page.getByRole('link', { name: 'Create offer', exact: true }).click();
  await expect(page.getByLabel('What are you creating?')).toHaveValue('');
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
