import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';

export async function captureSharedShell(page) {
  await page.evaluate(() => {
    const shell = document.querySelector('#workspace-shell');
    const panel = document.querySelector('[data-role-panel]:not([hidden])');
    const content = panel?.querySelector('.workspace-content') ?? panel;
    Object.assign(window, {
      __sharedWorkspaceHeader: document.querySelector('.topbar'),
      __sharedWorkspaceSidebar: document.querySelector('[data-workspace-sidebar]'),
      __sharedWorkspaceShell: shell,
      __sharedWorkspaceFooter: document.querySelector('[data-workspace-footer]'),
      __sharedWorkspaceContentOffset: shell && content
        ? Math.round(content.getBoundingClientRect().top - shell.getBoundingClientRect().top) : null,
    });
  });
}

export async function assertSharedShell(page) {
  await expect(page.locator('[data-workspace-footer]')).toBeVisible();
  assert.equal(await page.evaluate(() => {
    const footer = document.querySelector('[data-workspace-footer]');
    const header = document.querySelector('[data-workspace-header]');
    const sidebar = document.querySelector('[data-workspace-sidebar]');
    const shell = document.querySelector('#workspace-shell');
    const panel = document.querySelector('[data-role-panel]:not([hidden])');
    const content = panel?.querySelector('.workspace-content') ?? panel;
    const contentOffset = shell && content
      ? Math.round(content.getBoundingClientRect().top - shell.getBoundingClientRect().top) : null;
    const navigationFits = [...document.querySelectorAll('[data-workspace-sidebar] .service-nav-links')]
      .every(navigation => navigation.scrollWidth <= navigation.clientWidth + 1);
    return window.__sharedWorkspaceHeader === document.querySelector('.topbar')
      && document.querySelectorAll('.topbar').length === 1
      && document.querySelectorAll('[data-workspace-header]').length === 1
      && header === document.querySelector('.topbar')
      && header?.parentElement === document.body
      && window.__sharedWorkspaceSidebar === document.querySelector('[data-workspace-sidebar]')
      && document.querySelectorAll('[data-workspace-sidebar]').length === 1
      && window.__sharedWorkspaceShell === document.querySelector('#workspace-shell')
      && document.querySelectorAll('#workspace-shell').length === 1
      && sidebar?.parentElement === shell
      && window.__sharedWorkspaceFooter === footer
      && footer?.tagName === 'FOOTER'
      && footer?.classList.contains('workspace-footer')
      && document.querySelectorAll('[data-workspace-footer]').length === 1
      && footer?.parentElement === document.body
      && !footer?.closest('[data-role-panel]')
      && !footer?.closest('#workspace-stage')
      && document.querySelectorAll('.workspace-shell').length === 1
      && contentOffset === window.__sharedWorkspaceContentOffset
      && navigationFits;
  }), true);
}

export async function checkSharedWorkspaceShell({ page, url, output }) {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + '#admin-tools'); await page.reload();
    await expect(page.locator('#workspace-run')).toBeEnabled();
    const toggle = page.locator('#workspace-navigation-toggle'), collapsed = width <= 850;
    await expect(toggle).toHaveAttribute('aria-controls', 'admin-navigation');
    await expect(toggle).toHaveAttribute('aria-expanded', String(!collapsed));
    if (collapsed) await expect(page.locator('#admin-navigation')).toBeHidden();
    else await expect(page.locator('#admin-navigation')).toBeVisible();
    const initial = await page.locator('#admin .workspace-content').boundingBox(); await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', String(collapsed));
    if (collapsed) await expect(page.locator('#admin-navigation')).toBeVisible();
    else await expect(page.locator('#admin-navigation')).toBeHidden();
    const toggled = await page.locator('#admin .workspace-content').boundingBox();
    if (width > 850) assert(toggled.width > initial.width); else assert(toggled.width > 0);
    if (collapsed) { await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(page.locator('#admin-navigation')).toBeHidden(); }
    for (const role of ['shop', 'vendor', 'admin']) {
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await page.locator('#workspace-role-switcher').selectOption(role); await expect(page.locator('#' + role)).toBeVisible();
      await expect.poll(() => page.evaluate(() => Math.abs(window.scrollY) <= 1)).toBe(true);
      await expect(toggle).toHaveAttribute('aria-controls', role + '-navigation'); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#' + role + '-navigation')).toBeHidden();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(page.locator('#admin-navigation')).toBeVisible();
    const reference = await page.locator('#admin .workspace-content').boundingBox();
    await captureSharedShell(page); await assertSharedShell(page);
    for (const role of ['shop', 'vendor']) {
      await page.locator('#workspace-role-switcher').selectOption(role); await expect(page.locator('#' + role)).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-controls', role + '-navigation'); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const sidebar = page.locator('#' + role + '-navigation'); await expect(sidebar).toBeVisible(); await assertSharedShell(page);
      if (width <= 680) {
        const links = sidebar.locator('.service-nav-links > a'), [first, second] = await Promise.all([links.nth(0).boundingBox(), links.nth(1).boundingBox()]);
        assert(Math.abs(first.y - second.y) < 1 && second.x >= first.x + first.width);
      }
      const content = await page.locator('#' + role + ' .workspace-content').boundingBox();
      assert.equal(content.x, reference.x); assert.equal(content.width, reference.width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await expect(page.locator('#workspace-role-switcher')).toBeVisible(); await page.keyboard.press('ControlOrMeta+k');
      await expect(page.locator('#' + role + '-query')).toBeFocused(); await page.locator('#' + role + '-query').fill('absent offer');
      await expect(page.locator(role === 'shop' ? '#shop-empty' : '#vendor-table')).toContainText(role === 'shop' ? 'No offers match' : 'No matching offers');
      await page.locator('#' + role + '-query').fill(''); await page.screenshot({ path: path.join(output, `aligned-${role}-${width}.png`) });
    }
    const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    await page.locator('#workspace-role-switcher').selectOption('sme'); await expect(page.locator('#sme')).toBeVisible();
    await expect(page.locator('#sme-navigation')).toBeVisible();
    if (width <= 680) await expect(page.locator('#console-breadcrumb')).toBeHidden(); else await expect(page.locator('#console-breadcrumb')).toBeVisible();
    await expect(page.locator('#console-root')).toHaveAttribute('href', '#sme'); await expect(page.locator('#console-root')).toHaveText('SME pack');
    await expect(toggle).toHaveAttribute('aria-controls', 'sme-navigation'); await assertSharedShell(page);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), navigationCount);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => { location.hash = 'checkout'; }); await expect(page.locator('#checkout')).toBeVisible(); await assertSharedShell(page);
    await page.locator('#workspace-role-switcher').selectOption('vendor'); await expect(page.locator('#vendor')).toBeVisible();
  }
  await page.locator('#workspace-navigation-toggle').click();
  await expect(page.locator('#workspace-navigation-toggle')).toHaveAttribute('aria-expanded', 'false'); await page.reload();
  await expect(page.locator('#workspace-navigation-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#vendor-navigation')).toBeVisible();
}
