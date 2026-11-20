import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { chooseDropdown } from './dropdown-menu-browser.mjs'
import { invokeSmePackTool, PACK_INDEX } from '../../public/local-first/sme-business-pack-core.js'

export async function checkSmeKtvBrowser({ browser, url, output }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(url + '#sme')
    const protocol = await invokeSmePackTool('pack.protocol', { pack_id: PACK_INDEX[0].id })
    const expectedRows = protocol.input_fields.reduce((count, field) => count + (field.type === 'money' ? 2 : 1), 0)
    const rows = page.locator('#sme-workflow-inputs .agentic-ktv-row')
    await expect(rows).toHaveCount(expectedRows)
    assert.deepEqual(await rows.first().evaluate(node => [...node.children].map(cell => cell.tagName)), ['DT', 'DD', 'DD'])
    assert.equal(await rows.locator('.agentic-ktv-type svg[role="img"][aria-label]').count(), expectedRows)
    for (const row of await rows.all()) {
      assert.equal(await row.locator('input, select').count(), 1, 'one editable value per KTV row, including enhanced selects')
    }
    for (const field of protocol.input_fields.filter(field => field.type === 'money')) {
      const low = page.locator('#compare-a-' + field.name + '-low'), high = page.locator('#compare-a-' + field.name + '-high')
      assert.notEqual(await low.evaluate(node => node.closest('dl').id), await high.evaluate(node => node.closest('dl').id))
    }
    await expect(page.locator('#sme-workflow-inputs .workflow-edit-fields')).toHaveCount(0)
    assert.deepEqual(await rows.first().evaluate(row => { const label = row.querySelector('dt label');
      return [getComputedStyle(row).margin, getComputedStyle(label).margin, getComputedStyle(label).fontWeight === getComputedStyle(label.parentElement).fontWeight]
    }), ['0px', '0px', true], 'native labels inherit shared row density without legacy form margins')
    await page.locator('#sample').click()
    const price = page.locator('#compare-a-price_per_unit-low'), control = await price.elementHandle()
    await price.fill('25'); await page.locator('#sme-compare-run').click()
    await expect(page.locator('#workflow-status')).toContainText('Local Buy/Build plan built')
    assert.equal(await price.evaluate((node, original) => node === original, control), true, 'building retains the input node and its value')
    await expect(price).toHaveValue('25')
    await expect(page.locator('#sme-working')).toContainText('7,500')
    const assertKtv = async selector => {
      const region = page.locator(selector)
      assert.deepEqual(await region.locator('input, select, textarea').evaluateAll(controls => controls.filter(control => !control.closest('.agentic-ktv-row')).map(control => control.id || control.name)), [], selector + ': every field uses central KTV')
      for (const row of await region.locator('.agentic-ktv-row').all()) {
        assert.deepEqual(await row.evaluate(node => [...node.children].map(cell => cell.tagName)), ['DT', 'DD', 'DD'])
        assert.ok(await row.locator('input, select, textarea').count() <= 1, selector + ': one independent value per row')
      }
    }
    await assertKtv('#sme-workflow')
    await page.locator('#compare-a-venture_name').focus()
    await expect(page.locator('#sme-workflow-parameter-details .agentic-ktv-row')).toHaveCount(6)
    await page.locator('#compare-evidence-market_basis').fill('Observed test context')
    await chooseDropdown(page.locator('#sme-evidence-provenance'), 'directly_observed')
    await chooseDropdown(page.locator('#sme-evidence-role'), 'observer')
    await page.locator('#sme-evidence-date').fill('2026-11-17')
    await page.locator('#sme-evidence-add').click()
    await expect(page.locator('.sme-evidence-list .agentic-ktv-row')).toHaveCount(5)
    await page.getByRole('button', { name: 'Remove Market evidence or basis evidence', exact: true }).click()
    await expect(page.locator('.sme-evidence-list li')).toHaveCount(0)
    await page.goto(url + '#housing')
    await page.locator('[data-housing-workflow] > summary').click()
    await assertKtv('#housing-root')
    await expect(page.locator('.housing-table-actions .agentic-ktv-row')).toHaveCount(3)
    await page.getByRole('button', { name: 'Use sample profile', exact: true }).click()
    await expect(page.locator('.housing-context-summary')).toContainText('Set for this visit')
    await expect(page.locator('.housing-table-actions button[data-action="plan-open"]')).toHaveCount(3)
    await page.locator('[name="dimension-query"]').fill('rent')
    await expect(page.getByRole('button', { name: 'Clear table dimension search', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Clear table dimension search', exact: true }).click()
    await expect(page.locator('[name="dimension-query"]')).toHaveValue('')
    await assertKtv('#housing-root')
    await page.screenshot({ path: path.join(output, 'housing-ktv-desktop.png') })
    await page.goto(url + '#vendor-editor')
    await page.locator('#title').waitFor({ state: 'visible' })
    await expect(page.locator('#save')).toBeEnabled()
    await assertKtv('#draft-form')
    await page.locator('#title').fill('KTV verification offer')
    await page.locator('#description').fill('An illustrative local draft to verify the existing save action.')
    await page.locator('#save').click()
    await expect(page.locator('#save-state')).toContainText('Saved')
    await expect(page.locator('#title')).toHaveValue('KTV verification offer')
    await page.screenshot({ path: path.join(output, 'vendor-ktv-desktop.png') })
    await page.goto(url + '#sme')
    await rows.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'sme-ktv-desktop.png') })
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}`)
      assert.equal(await rows.first().evaluate(node => node.scrollWidth <= node.clientWidth), true, `row overflow at ${width}`)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await rows.first().locator('.agentic-ktv-value').evaluate(node => getComputedStyle(node).gridColumn), '1 / -1')
    await rows.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'sme-ktv-mobile.png') })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '200% text zoom overflow')
    await page.waitForFunction(() => navigator.serviceWorker.controller)
    await context.setOffline(true); await page.reload()
    await expect(rows).toHaveCount(expectedRows)
    await page.locator('#sample').click(); await page.locator('#sme-compare-run').click()
    await expect(page.locator('#workflow-status')).toContainText('Local Buy/Build plan built')
    assert.deepEqual(errors, [])
    await writeFile(path.join(output, 'sme-ktv-proof.json'), JSON.stringify({ schema: 'commerce.sme-ktv/v1',
      owner: 'agentic-design-system', revision: '98807b856ab35bac53c54987d4340cd37982d3ec', fields: protocol.input_fields.length,
      rows: expectedRows, oneEditableValuePerRow: true, sections: ['metadata', 'evidence', 'housing context', 'listing actions', 'offer editor', 'workflow controls', 'launch inputs'],
      evidenceAddRemove: true, housingContextAndSearch: true, vendorSave: true,
      semanticCells: ['DT', 'DD', 'DD'], namedTypeIcons: true, controlIdentityPreserved: true, revenueAfterPriceEdit: 7500,
      widths: [320, 390, 768, 1280], narrowValueStacks: true, textZoom: '200%', offlineReloadAndBuild: true, pageErrors: errors,
    }, null, 2) + '\n')
  } finally { await context.close() }
}
