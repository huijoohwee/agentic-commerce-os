import { expect } from '@playwright/test';

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
    const options = page.getByRole('region', { name: 'Tools and Console' });
    const nav = page.locator('#workspace-navigation-toggle');
    for (const [name, hash] of Object.entries({ Shopper: 'shop', Vendor: 'vendor', Admin: 'admin',
      'SME pack': 'sme', Housing: 'housing', Workspace: 'builder', 'Included files': 'formats' })) {
      const isPack = ['builder', 'formats'].includes(hash);
      await page.goto((isPack ? pack : url) + '#' + hash);
      await expect(link(name)).toHaveAttribute('aria-current', 'location');
      await expect(page.getByRole('note').filter({ hasText: 'Workspace Program Pack' })).toBeInViewport();
      await expect(nav).toBeInViewport();
      if (isPack) {
        await nav.click();
        await expect(page.getByRole('region', { name: 'Pack navigation' }).getByRole('link', { name: 'Included files' })).toBeVisible();
        await page.keyboard.press('Escape'); await expect(nav).toBeFocused();
      } else {
        const expanded = await nav.getAttribute('aria-expanded'); await nav.click();
        await expect(nav).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true'); await nav.click();
      }
      await panels.focus(); await page.keyboard.press('Enter');
      await expect(options.getByRole(isPack ? 'button' : 'link', { name: 'Console' })).toBeVisible();
      await options.getByRole('button', { name: 'Agent tools' }).click();
      const agent = page.locator(isPack ? '#console-sheet' : '#workspace-agent-drawer');
      await expect(agent).toBeVisible();
      await expect(page.locator(isPack ? '#console-filter' : '#workspace-tool + button')).toBeFocused();
      await page.keyboard.press('Escape'); await expect(panels).toBeFocused();
    }
    await page.goto(url + '#vendor');
    const roleLinks = toolbar.locator('[data-workspace-destination]');
    await expect(link('Vendor')).toHaveAttribute('aria-current', 'location');
    await expect(service).toHaveText('Service ready');
    const roles = await roleLinks.allTextContents();
    await link('Workspace').click();
    await expect(page).toHaveURL(pack + '#builder');
    await expect(roleLinks).toHaveText(roles);
    await expect(link('Workspace')).toHaveAttribute('aria-current', 'location');
    await link('Included files').click();
    await expect(page).toHaveURL(pack + '#formats');
    await expect(link('Included files')).toHaveAttribute('aria-current', 'location');
    await link('Vendor').click();
    await expect(page).toHaveURL(url + '#vendor');
    await panels.click(); await options.getByRole('link', { name: 'Console' }).click();
    await expect(page).toHaveURL(pack + '#console');
    await expect(page.getByRole('complementary', { name: 'Console' })).toBeVisible();
    await expect(page.locator('#console-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panels).toBeFocused();
    await page.goBack();
    await expect(link('Vendor')).toHaveAttribute('aria-current', 'location');
    if (width <= 390) {
      await page.route(pack + 'service.json', route => route.fulfill({ json: {} }));
      await page.reload();
      await expect(service).toHaveText('Service unavailable');
      await expect(toolbar.locator('#connection')).toHaveAccessibleName('Local workspace · Online');
      await page.unroute(pack + 'service.json');
      await context.setOffline(true);
      await context.setOffline(false);
      await expect(service).toHaveText('Service ready');
    }
  } finally {
    await context.close();
  }
}
