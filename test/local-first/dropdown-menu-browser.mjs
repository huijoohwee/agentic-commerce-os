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
  await trigger.click();
  const id = await trigger.getAttribute('aria-controls');
  if (!id) throw Error('Shared dropdown did not open');
  const menu = page.locator(`#${id}`);
  await expect(menu).toHaveClass(/\bagentic-menu\b/);
  await menu.getByRole('menuitemradio', { name: selection.label, exact: true }).click();
  await expect(menu).toBeHidden();
  return [String(value)];
}
