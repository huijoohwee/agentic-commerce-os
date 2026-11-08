import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyDashboardGrid(grid, { columns, count }) {
  const cards = grid.locator(':scope > .agentic-dashboard-card');
  await expect(cards).toHaveCount(count);
  const measured = await grid.evaluate(element => {
    const style = getComputedStyle(element);
    const card = getComputedStyle(element.firstElementChild);
    const reference = document.createElement('div');
    reference.style.borderRadius = 'var(--agentic-control-radius)';
    element.append(reference);
    const ownerRadius = getComputedStyle(reference).borderTopLeftRadius;
    reference.remove();
    return {
      columns: style.gridTemplateColumns.split(' ').length,
      gap: style.columnGap,
      padding: card.paddingInlineStart,
      radius: card.borderTopLeftRadius,
      ownerGap: style.getPropertyValue('--agentic-dashboard-card-gap').trim(),
      ownerRadius,
    };
  });
  assert.equal(measured.columns, columns);
  assert.equal(measured.gap, measured.ownerGap);
  assert.equal(measured.padding, measured.ownerGap);
  assert.equal(measured.radius, measured.ownerRadius);
}
