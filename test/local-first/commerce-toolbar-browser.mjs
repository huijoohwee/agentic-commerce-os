import { expect } from '@playwright/test';
import { checkDashboardEditor } from './dashboard-props-browser.mjs';

export async function checkCommerceToolbar(browser, url, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    const toolbar = page.getByRole('navigation', { name: 'Workspace Toolbar' });
    const link = name => toolbar.getByRole('link', { name, exact: true });
    const service = toolbar.locator('[data-pack-status]');
    const pack = url + 'services/workspace-pack/';
    const panels = page.getByRole('button', { name: 'Tools and Console' });
    const options = page.locator('#commerce-workspace-panel');
    const nav = page.locator('#workspace-navigation-toggle');
    for (const [name, hash] of Object.entries({ Shopper: 'shop', Vendor: 'vendor', Admin: 'admin',
      'SME pack': 'sme', Housing: 'housing', Workspace: 'builder', 'Included files': 'formats' })) {
      const isPack = ['builder', 'formats'].includes(hash);
      await page.goto((isPack ? pack : url) + '#' + hash);
      await expect(link(name)).toHaveAttribute('aria-current', 'location');
      await expect(page.getByRole('note').filter({ hasText: 'Workspace Program Pack' })).toBeInViewport();
      await expect(nav).toBeInViewport();
      const heading = page.locator('#'+hash+' [data-dashboard-primitive="heading"]').first();
      await expect(heading).toBeVisible();
      expect(await heading.evaluate(h => {
        const css = getComputedStyle(h), reference = document.createElement('span');
        reference.style.fontSize = 'var(--kg-text-3xl)'; h.after(reference);
        const matches = css.fontSize === getComputedStyle(reference).fontSize; reference.remove();
        return matches && !!h.closest('.agentic-dashboard-layout') && css.fontWeight === '600';
      })).toBe(true);
      if (isPack) {
        await nav.click();
        await expect(page.getByRole('region', { name: 'Pack navigation' }).getByRole('link', { name: 'Included files' })).toBeVisible();
        await page.keyboard.press('Escape'); await expect(nav).toBeFocused();
      } else {
        const expanded = await nav.getAttribute('aria-expanded'); await nav.click();
        await expect(nav).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true'); await nav.click();
      }
      await panels.focus(); await page.keyboard.press('Enter');
      await expect(options).toBeVisible();
      await expect(panels).toHaveAttribute('aria-expanded', 'true');
      expect(await options.evaluate(root => ({
        popover: root.hasAttribute('popover'),
        placement: root.dataset.agenticFloatingPanelPlacement,
        position: getComputedStyle(root).position,
      }))).toEqual({ popover: false, placement: 'viewport-overlay', position: 'fixed' });
      await expect(options.getByRole('tab', { name: 'Console' })).toBeVisible();
      if (isPack) {
        await options.getByRole('tab', { name: 'Console' }).click();
        const consolePanel = options.getByRole('tabpanel', { name: 'Console' });
        await expect(consolePanel.getByRole('heading', { name: 'Response rehearsal' })).toBeVisible();
        await options.getByRole('tab', { name: 'Setup Guide' }).click();
        const guide = options.getByRole('tabpanel', { name: 'Setup Guide' });
        await expect(guide.getByRole('heading', { name: 'Program Pack setup' })).toBeVisible();
        await expect(guide.locator('button[data-step-id]')).toHaveCount(4);
      }
      await options.getByRole('tab', { name: 'Agent tools' }).click();
      const agent = options.getByRole('tabpanel', { name: 'Agent tools' });
      await expect(agent).toBeVisible();
      if (isPack) {
        await expect(agent.locator('#commerce-pack-agent-content')).toBeVisible();
        await expect(options.getByRole('tab', { name: 'Agent tools' })).toBeFocused();
        await expect(agent.locator('#agent-tools-filter')).toBeVisible();
      } else {
        await expect(agent.locator('#workspace-agent-content')).toBeVisible();
        await expect(options.getByRole('tab', { name: 'Agent tools' })).toBeFocused();
      }
      await page.keyboard.press('Escape'); await expect(panels).toBeFocused();
    }
    await link('Housing').click();
    await expect(link('Housing')).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => { window.originalToolbar = document.querySelector('.agentic-toolbar'); });
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await link('Workspace').click();
    const packTitle = page.locator('#pack-view').getByLabel('Pack name');
    await packTitle.fill('Keep this draft');
    await link('Housing').click();
    await expect(page.locator('#housing')).toBeVisible();
    await page.goBack();
    await expect(packTitle).toHaveValue('Keep this draft');
    await page.goForward();
    await expect(link('Housing')).toHaveAttribute('aria-current', 'location');
    expect(documents).toEqual([]);
    expect(await page.evaluate(() => window.originalToolbar === document.querySelector('.agentic-toolbar'))).toBe(true);
    await page.goto(url + '#vendor');
    const roleLinks = toolbar.locator('[data-workspace-destination]');
    await expect(link('Vendor')).toHaveAttribute('aria-current', 'location');
    await expect(service).toHaveText('Service ready');
    const roles = await roleLinks.allTextContents();
    await link('Workspace').click();
    await expect(page).toHaveURL(url + '#builder');
    await expect(roleLinks).toHaveText(roles);
    await expect(link('Workspace')).toHaveAttribute('aria-current', 'location');
    await link('Included files').click();
    await expect(page).toHaveURL(url + '#formats');
    await expect(link('Included files')).toHaveAttribute('aria-current', 'location');
    await link('Vendor').click();
    await expect(page).toHaveURL(url + '#vendor');
    await panels.click(); await options.getByRole('tab', { name: 'Console' }).click();
    await expect(options.getByRole('tabpanel', { name: 'Console' }).getByRole('heading', { name: 'Response rehearsal' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panels).toBeFocused();
    await page.goBack();
    await expect(link('Included files')).toHaveAttribute('aria-current', 'location');
    if (width <= 390) {
      await page.route(pack + 'service.json', route => route.fulfill({ json: {} }));
      await page.reload();
      await expect(service).toHaveText('Service unavailable');
      await expect(toolbar.locator('#connection')).toHaveAccessibleName('Local workspace · Online');
      await page.unroute(pack + 'service.json');
      await context.setOffline(true);
      await context.setOffline(false);
      await expect(service).toHaveText('Service ready');
      await checkDashboardEditor(page, url);
    }
  } finally {
    await context.close();
  }
}
