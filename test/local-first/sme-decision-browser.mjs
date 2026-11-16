import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { chooseDropdown } from './dropdown-menu-browser.mjs'

export async function checkSmeDecisionBrowser({ browser, url, output }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }), requests = [], errors = []
  context.on('request', request => requests.push({ method: request.method(), url: request.url() }))
  await context.addInitScript(() => {
    window.decisionTools = new Map()
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { window.decisionTools.set(tool.name, tool) }, unregisterTool(name) { window.decisionTools.delete(name) },
    } })
  })
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(url + '#sme')
    await page.waitForFunction(() => navigator.serviceWorker.controller)
    await page.locator('#sample').click()
    await chooseDropdown(page.locator('#sme-plan-mode'), 'scenario')
    await page.locator('#sme-compare-run').click()
    await expect(page.locator('#workflow-status')).toContainText('Local scenario plan built')
    await page.locator('#sme-baseline-request').click()
    await page.locator('#sme-baseline-confirm').focus(); await page.keyboard.press('Enter')
    await expect(page.locator('#sme-baseline-status')).toContainText('Baseline A')
    await chooseDropdown(page.locator('#sme-protected-field'), 'payroll_per_month')
    await page.locator('#sme-protect-field').click()
    await expect(page.locator('#sme-policy-status')).toContainText('Team and contractor cost per month')
    await chooseDropdown(page.locator('#sme-protected-field'), 'price_per_unit')
    await page.getByRole('spinbutton', { name: 'Minimum permitted value', exact: true }).fill('0')
    await page.getByRole('spinbutton', { name: 'Maximum permitted value', exact: true }).fill('100')
    await page.locator('#sme-bound-field').click()
    const firstDownload = page.waitForEvent('download'); await page.locator('[data-export="json"]').click()
    const firstSheet = JSON.parse(await readFile(await (await firstDownload).path(), 'utf8'))
    const pair = [firstSheet, { ...structuredClone(firstSheet), inputs: { ...firstSheet.inputs, price_per_unit: 22 }, row_revision: 1 }]
    await page.locator('#sme-worksheet-import').setInputFiles({ name: 'decision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pair)) })
    await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
    await page.locator('#sme-compare-run').click()
    await expect(page.locator('#workflow-status')).toContainText('Local scenario comparison')
    const select = async slot => { await page.locator('#sme-workflow-table-host').getByRole('row', { name: `Data row: Scenario ${slot}`, exact: true }).click() }
    await select('B')
    const working = page.locator('#sme-working'); await working.locator(':scope > summary').click()
    await expect(working).toContainText('Change from baseline A: 600 USD')
    await expect(working).toContainText('price_per_unit × units_per_month')
    await expect(working).toContainText('No dated evidence recorded')
    await page.locator('#compare-b-payroll_per_month-low').fill('1')
    await expect(page.locator('#workflow-status')).toContainText('Team and contractor cost per month is protected')
    await expect(page.locator('#compare-b-payroll_per_month-low')).toHaveValue('2500')
    await page.locator('#compare-b-price_per_unit-low').fill('101')
    await expect(page.locator('#workflow-status')).toContainText('Price per unit or billing interval is outside its permitted range')
    await expect(page.locator('#compare-b-price_per_unit-low')).toHaveValue('22')
    await page.locator('#sme-baseline-request').click(); await page.locator('#sme-baseline-decline').click()
    await expect(page.locator('#sme-baseline-status')).toContainText('Baseline A')
    await page.locator('#sme-baseline-request').click()
    await page.locator('#compare-b-price_per_unit-low').fill('24')
    await page.locator('#sme-baseline-confirm').click()
    await expect(page.locator('#workflow-status')).toContainText('review it again')
    await expect(page.locator('#sme-baseline-status')).toContainText('Baseline A')
    await page.locator('#sme-compare-run').click(); await expect(page.locator('#workflow-status')).toContainText('Local scenario comparison')
    await page.locator('#sme-baseline-request').click(); await page.locator('#sme-baseline-confirm').click()
    await expect(page.locator('#sme-baseline-status')).toContainText('Baseline B')
    await expect(page.locator('#sme-baseline-confirm')).toHaveCount(0)
    await page.locator('#sme-compare-run').click(); await expect(page.locator('#workflow-status')).toContainText('Local scenario comparison')
    const download = page.waitForEvent('download'); await page.locator('[data-export="json"]').click()
    const worksheet = await readFile(await (await download).path(), 'utf8'), sheets = JSON.parse(worksheet)
    assert.equal(sheets[0].decision.baseline, 'B')
    const tool = await page.evaluate(async rows => {
      const result = await window.decisionTools.get('business.plan.compare').execute({ mode: 'scenario', decision: rows[0].decision,
        plan_sets: rows.map(row => ({ pack_id: row.pack_id, pack_version: row.pack_version, inputs: row.inputs, evidence: row.evidence })) })
      return result.structuredContent ?? JSON.parse(result.content[0].text)
    }, sheets)
    assert.equal(tool.decision.baseline, 'B'); assert.equal(tool.decision.rows[0].deltas.monthly_revenue.value.low, -1200)
    assert.equal(await page.evaluate(() => window.decisionTools.has('business.plan.confirm')), false)
    const invalid = structuredClone(sheets); invalid[1].inputs.payroll_per_month = 1; invalid[1].inputs.price_per_unit = 25
    await page.locator('#sme-worksheet-import').setInputFiles({ name: 'refused.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) })
    await expect(page.locator('#workflow-status')).toContainText('Team and contractor cost per month is protected')
    await expect(page.locator('#compare-b-price_per_unit-low')).toHaveValue('24')
    await page.locator('#sme-working > summary').click()
    await page.locator('#sme-decision-panel').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'sme-decision-desktop.png') })
    const mobile = await context.newPage(); await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.goto(url + '#sme'); await mobile.waitForFunction(() => navigator.serviceWorker.controller)
    await mobile.locator('#sme-worksheet-import').setInputFiles({ name: 'decision.json', mimeType: 'application/json', buffer: Buffer.from(worksheet) })
    await expect(mobile.locator('#workflow-status')).toContainText('Worksheet imported')
    await expect(mobile.locator('#sme-baseline-status')).toContainText('Baseline B')
    await context.setOffline(true)
    await mobile.reload(); await expect(mobile.locator('#sme')).toBeVisible()
    await mobile.locator('#sme-worksheet-import').setInputFiles({ name: 'decision.json', mimeType: 'application/json', buffer: Buffer.from(worksheet) })
    await expect(mobile.locator('#workflow-status')).toContainText('Worksheet imported')
    await mobile.locator('#sme-compare-run').click(); await expect(mobile.locator('#workflow-status')).toContainText('Local scenario comparison')
    await mobile.locator('#sme-working > summary').click()
    await expect(mobile.locator('#sme-working')).toContainText('Change from baseline B: -1200 USD')
    await mobile.locator('#sme-decision-panel').scrollIntoViewIfNeeded()
    await mobile.screenshot({ path: path.join(output, 'sme-decision-mobile-offline.png') })
    for (const width of [320, 360, 390, 768, 1280]) {
      await mobile.setViewportSize({ width, height: 844 })
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}`)
    }
    await mobile.setViewportSize({ width: 390, height: 844 }); await mobile.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'text zoom overflow')
    assert.deepEqual(errors, [])
    assert.equal(requests.some(row => !['GET', 'HEAD'].includes(row.method)), false)
    assert.equal(requests.some(row => row.url.includes('/services/sme-business-pack/api') || row.url.includes('/services/sme-business-pack/mcp')), false)
    await writeFile(path.join(output, 'sme-decision-proof.json'), JSON.stringify({ source: await page.locator('meta[name="commerce-source"]').getAttribute('content'),
      baseline: 'B', staleConfirmationRefused: true, protectedAtomicImportRefused: true, working: true, transport: 'WebMCP contract fixture',
      nativeWebMcpAvailability: 'not claimed', privateNetworkWrites: 0, offlineReloadAndImport: true, widths: [320, 360, 390, 768, 1280], textZoom: '200%' }, null, 2))
  } finally { await context.close() }
}
