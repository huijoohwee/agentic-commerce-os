import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Called by the existing role-workspace browser harness; it owns browser/server lifetime.
export async function verifyWorkspaceToolRefinements({ page, context, url, drafts }) {
  await page.goto(url + '#admin-tools'); await page.reload();
  const tool = page.locator('#workspace-tool'), summary = page.locator('#workspace-summary');
  const advanced = page.locator('#workspace-advanced'), args = page.locator('#workspace-arguments');
  const run = page.locator('#workspace-run'), output = page.locator('#workspace-result');
  const outbound = [];
  const record = request => { if (request.method() === 'POST' && /\/services\/workspace\/(?:api|invoke|mcp)$/.test(new URL(request.url()).pathname)) outbound.push(request.url()); };
  page.on('request', record);
  try {
    await expect(run).toBeEnabled(); await expect(output).toBeEmpty(); await expect(summary).toBeEmpty();
    await expect(page.locator('#workspace-provenance')).toContainText('Saved on this device');
    await page.locator('#workspace-field-query').fill('studio-north');
    assert.deepEqual(JSON.parse(await args.inputValue()), { query: 'studio-north' });
    await expect(output).toBeEmpty(); await run.click();
    await expect(summary).toContainText('studio-north');
    await expect(summary).not.toContainText('PRIVATE');
    await tool.selectOption('commerce.workspace.project.read');
    await page.locator('#workspace-field-projectId').fill('store:studio-north');
    await expect(page.locator('#workspace-field-projectId')).toHaveAttribute('required', '');
    await run.click(); await expect(summary).toContainText('Saved offers');
    await expect(summary).toContainText('Revision 1');
    await page.locator('#workspace-prepare').click();
    await expect(page.locator('#workspace-privacy')).toContainText('6 offers');
    await expect(page.locator('#workspace-privacy')).toContainText('Nothing was sent');
    await expect(summary).toContainText('Request ready to inspect');

    await tool.selectOption('commerce.workspace.offer.review');
    await page.locator('#workspace-field-offerId').fill(drafts[1].id);
    await page.locator('#workspace-field-expectedRevision').fill('1');
    await run.click(); await expect(summary).toContainText(drafts[1].title);
    await expect(summary).toContainText('Estimated contribution');
    await expect(summary).toContainText('Human launch review is still required');
    await page.locator('#workspace-prepare').click();
    await expect(page.locator('#workspace-privacy')).toContainText('1 offer');
    const request = JSON.parse(await output.textContent());
    assert.equal(request.params.arguments.snapshot.offers.length, 1);
    assert.equal(request.params.arguments.snapshot.offers[0].id, drafts[1].id);
    assert(!JSON.stringify(request).includes('PRIVATE'));
    await page.locator('#workspace-field-expectedRevision').fill('999');
    await expect(summary).toBeEmpty(); await run.click();
    await expect(page.locator('#workspace-tool-status')).toHaveText('workspace_revision_changed');
    await expect(page.locator('#workspace-recovery')).toContainText('reopen the offer');
    await expect(summary).toBeEmpty(); await expect(output).toBeEmpty();

    await advanced.evaluate(element => { element.open = true; });
    await args.fill('{'); await run.click();
    await expect(page.locator('#workspace-recovery')).toContainText('Inspect arguments');
    await page.getByRole('button', { name: 'Inspect arguments', exact: true }).click(); await expect(args).toBeFocused();
    await args.fill(JSON.stringify({ offerId: drafts[1].id, expectedRevision: 1, publish: true }));
    await expect(page.locator('#workspace-field-expectedRevision')).toHaveValue('1');
    // Field assistance preserves unknown properties so the domain validator still refuses them.
    await page.locator('#workspace-field-expectedRevision').fill('2');
    assert.equal(JSON.parse(await args.inputValue()).publish, true);
    await run.click(); await expect(page.locator('#workspace-tool-status')).toHaveText('workspace_arguments_invalid');

    await tool.selectOption('commerce.workspace.projects.list');
    await args.fill(JSON.stringify({ snapshot: { schema: 'commerce.workspace-snapshot/v1', offers: [] } }));
    await expect(page.locator('#workspace-provenance')).toContainText('Supplied snapshot');
    await run.click(); await expect(summary).toContainText('Supplied snapshot');
    await expect(summary).toContainText('Personal workspace');
    await expect(output).toContainText('provided-snapshot');

    await tool.selectOption('commerce.workspace.environment.read');
    await expect(page.locator('#workspace-fields input')).toHaveCount(0);
    await expect(page.locator('#workspace-provenance')).toContainText('Current runtime observation');
    await expect(output).toBeEmpty();
    const sourceRevision = await page.locator('meta[name="commerce-source"]').getAttribute('content');
    const readiness = { ok: true, profile: 'local-first', storage: 'browser-only', realMoney: false,
      checkout: 'sandbox', paymentStorage: 'stripe-test', paymentProvider: 'stripe', workerVersionId: null, sourceRevision };
    await page.route('**/readyz', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readiness) }));
    try { await run.click(); await expect(summary).toContainText('Configured at observation time'); await expect(summary).toContainText(sourceRevision); }
    finally { await page.unroute('**/readyz'); }
    assert.deepEqual(outbound, []);
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Mount with the native API unavailable: ordinary reads remain usable.
    await page.goto(url + '#admin'); await page.reload();
    await page.evaluate(() => { document.modelContext.registerTool = undefined; });
    await page.locator('#admin').getByRole('link', { name: 'Tools & commands', exact: true }).click();
    await expect(page.locator('#workspace-webmcp-enable')).toBeDisabled();
    await expect(page.locator('#workspace-webmcp-status')).toContainText('Unavailable in this browser');
    await run.click(); await expect(summary).toContainText('Saved on this device');
    await context.setOffline(true); await page.reload(); await run.click();
    await expect(summary).toContainText('Saved on this device');
    await context.setOffline(false);
  } finally {
    await context.setOffline(false); page.off('request', record);
    await page.goto(url + '#admin-tools');
  }
}
