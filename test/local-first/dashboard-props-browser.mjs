import { expect } from '@playwright/test';
import { chooseDropdown } from './dropdown-menu-browser.mjs';

// Keep release journeys read-only: this browser context owns its own layout service fixture.
export async function checkDashboardEditor(page, url) {
  const key = 'a'.repeat(64), endpoint = url + 'dashboard-layout';
  let saved = {revision:0, columns:{}};
  await page.route(endpoint + '**', async route => {
    const request = route.request(), method = request.method();
    if (method === 'GET') return route.fulfill({json:{...saved, authoring:true}});
    if (request.headers().authorization !== 'Bearer ' + key) return route.fulfill({status:403, json:{}});
    if (method === 'PUT') {
      const change = request.postDataJSON();
      expect(change.view).toBe('shop'); expect(change.revision).toBe(saved.revision);
      saved = {revision:saved.revision + 1, columns:change.columns === null ? {} : {shop:change.columns}};
    }
    return route.fulfill({json:saved});
  });
  await page.goto(url + '#admin');
  const button = page.getByRole('button', {name:'Tools and Console'});
  const panel = page.locator('#commerce-workspace-panel');
  const start = panel.getByRole('button', {name:'Enter admin edit mode'});
  await button.click(); await start.click();
  await panel.getByLabel('Layout admin key').fill('b'.repeat(64));
  await panel.getByRole('button', {name:'Unlock layout editing'}).click();
  await expect(panel.getByRole('status')).toHaveText('Layout admin key refused.');
  await panel.getByLabel('Layout admin key').fill(key);
  await panel.getByRole('button', {name:'Unlock layout editing'}).click();
  const fields = panel.locator('select'), save = panel.getByRole('button', {name:'Save layout'});
  await chooseDropdown(fields.nth(0), 'shop'); await chooseDropdown(fields.nth(1), '1');
  await save.click(); await expect(panel.getByRole('status')).toHaveText('Layout saved.');
  expect(saved).toEqual({revision:1, columns:{shop:1}});
  await chooseDropdown(fields.nth(0), 'vendor');
  await expect(fields.nth(1).locator('+ button')).toHaveText('Dashboard default');
  await chooseDropdown(fields.nth(0), 'shop');
  await expect(fields.nth(1).locator('+ button')).toHaveText('1');
  await chooseDropdown(fields.nth(1), ''); await save.click();
  await expect.poll(() => saved).toEqual({revision:2, columns:{}});
  await page.keyboard.press('Escape'); await button.click();
  await expect(start).toBeVisible(); await expect(save).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', {name:'Workspace Toolbar'}).getByRole('link', {name:'Shopper', exact:true}).click();
  await button.click(); await expect(start).toHaveCount(0);
}
