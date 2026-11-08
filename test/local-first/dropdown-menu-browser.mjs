import { expect } from '@playwright/test';

/** Exercise the visible shared menu; native backing fields are read only. */
export async function chooseDropdown(control, value) {
  let selection;
  await expect.poll(async () => { selection = await control.evaluate((node, requested) => {
    const select = node.tagName === 'SELECT' ? node : node.previousElementSibling;
    if (select?.tagName !== 'SELECT') return null;
    const option = [...select.options].find(item => item.value === String(requested));
    if (!option || option.hidden || option.disabled || option.parentElement?.disabled) return null;
    const trigger = select.nextElementSibling;
    if (!trigger?.matches('.agentic-select-trigger')) return null;
    return { trigger: trigger.id, label: option.label };
  }, value); return selection; }, { message: 'Shared dropdown and requested option are ready' }).not.toBeNull();
  const page = control.page(), trigger = page.locator(`#${selection.trigger}`);
  await expect(trigger).toBeVisible();
  const geometry = await trigger.evaluate(node => { const s = getComputedStyle(node), root = getComputedStyle(document.documentElement); return {
    height: node.getBoundingClientRect().height, token: parseFloat(s.getPropertyValue('--agentic-control-height')),
    font: parseFloat(s.fontSize), body: parseFloat(root.getPropertyValue('--agentic-font-size-body')) * parseFloat(root.fontSize),
    line: parseFloat(s.lineHeight), bodyLine: parseFloat(root.getPropertyValue('--agentic-line-height-body')) * parseFloat(root.fontSize) }; });
  expect(geometry.height).toBeCloseTo(geometry.token, 1);
  expect(geometry.font).toBeCloseTo(geometry.body, 1);
  expect(geometry.line).toBeCloseTo(geometry.bodyLine, 1);
  await trigger.click();
  const id = await trigger.getAttribute('aria-controls');
  if (!id) throw Error('Shared dropdown did not open');
  const menu = page.locator(`#${id}`);
  await expect(menu).toHaveClass(/\bagentic-menu\b/);
  await expect(trigger.getByRole('img', { name: 'Show choices', exact: true })).toBeVisible();
  expect(await menu.evaluate(node => !node.querySelector('div, [aria-hidden="true"]')
    && [...node.querySelectorAll('svg')].every(icon => icon.getAttribute('role') === 'img'
      && icon.getAttribute('aria-label') === 'Selected'
      && icon.closest('[aria-checked="true"]')))).toBe(true);
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })));
  await expect(menu).toBeVisible();
  await page.evaluate(() => {
    const inspect = event => event.preventDefault();
    document.body.addEventListener('mousedown', inspect, { once: true });
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: selection.label, exact: true }).click();
  await expect(menu).toBeHidden();
  return [String(value)];
}
