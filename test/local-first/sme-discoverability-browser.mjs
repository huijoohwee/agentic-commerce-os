import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { chooseDropdown } from './dropdown-menu-browser.mjs'

export async function checkSmeDiscoverabilityBrowser({ browser, url, output }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage(), errors = [], writes = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()) })
  try {
    await page.goto(url + '#sme')
    await expect(page.locator('#sme-workflow-editor')).toBeVisible()
    await expect(page.locator('#sme-edit-slot')).toHaveValue('A')
    await expect(page.locator('#compare-a-venture_name')).toHaveValue('')
    const links = page.getByRole('navigation', { name: 'Plan workspace sections' }).getByRole('link')
    await expect(links).toHaveCount(6)
    await page.screenshot({ path: path.join(output, 'sme-visible-desktop.png') })
    await page.locator('#compare-a-venture_name').fill('Visibility draft')
    await chooseDropdown(page.locator('#sme-plan-mode'), 'scenario')
    await chooseDropdown(page.locator('#sme-compare-count'), '2')
    await chooseDropdown(page.locator('#sme-edit-slot'), 'B')
    await expect(page.locator('#sme-workflow-editor-heading')).toHaveText('Edit · Scenario B')
    await page.locator('#compare-b-venture_name').fill('Second draft')
    await chooseDropdown(page.locator('#sme-compare-count'), '1')
    await expect(page.locator('#sme-edit-slot')).toHaveValue('A')
    await expect(page.locator('#compare-a-venture_name')).toHaveValue('Visibility draft')
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      for (const target of ['sme-workflow-editor', 'sme-decision-panel', 'sme-workflow-evidence', 'sme-workflow-table-region', 'sme-worksheet-actions', 'sme-agent-tools']) {
        await page.locator(`#sme-section-navigation a[href="#${target}"]`).focus()
        await page.keyboard.press('Enter')
        await expect(page.locator('#' + target)).toBeFocused()
        await expect.poll(() => page.locator('#' + target).evaluate(node => {
          const top = node.getBoundingClientRect().top; return top >= 100 && top < innerHeight
        }), { message: `${target} is reachable below the toolbar at ${width}px` }).toBe(true)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`)
      await expect(page.locator('#sme-agent-tools')).toHaveAttribute('open', '')
      await page.locator('#agent-heading').click()
      await page.locator('#sme-section-navigation a[href="#sme-agent-tools"]').click()
      await expect(page.locator('#sme-agent-tools')).toHaveAttribute('open', '')
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#sme-section-navigation a[href="#sme-workflow-editor"]').click()
    await expect(page.locator('#compare-a-venture_name')).toHaveValue('Visibility draft')
    await page.screenshot({ path: path.join(output, 'sme-visible-mobile-inputs.png') })
    await page.evaluate(() => scrollTo(0, 0))
    await page.screenshot({ path: path.join(output, 'sme-visible-mobile.png') })
    assert.deepEqual(errors, []); assert.deepEqual(writes, [])
    await writeFile(path.join(output, 'sme-discoverability-proof.json'), JSON.stringify({
      schema: 'commerce.sme-discoverability/v1', sourceMarker: await page.locator('meta[name="commerce-source"]').getAttribute('content'),
      defaultEditor: 'A', sectionLinks: 6, widths: [1280, 390, 320], keyboardFocusAndToolbarClearance: true,
      optionSwitchAndRemoval: true, draftPreservedAcrossSections: true, repeatedAgentDisclosure: true, pageErrors: errors, networkWrites: writes,
    }, null, 2) + '\n')
  } finally { await context.close() }
}
