import assert from 'node:assert/strict';
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
