import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs'

export async function checkSmeComparisonBrowser({ browser, page, url, output, smeServiceRequests, record }) {
  const fresh = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block' })
  const firstPage = await fresh.newPage(), serviceCalls = [], started = performance.now()
  firstPage.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/agentic-commerce-os/services/sme-business-pack')) serviceCalls.push(request.url())
  })
  await firstPage.goto(url)
  await expect(firstPage.locator('#workspace-role-switcher')).toBeVisible()
  await firstPage.locator('#workspace-role-switcher').selectOption('sme')
  await expect(firstPage.locator('#sme')).toBeVisible()
  await expect.poll(() => tableText(firstPage)).toContain('Cash to close')
  await firstPage.locator('#sample').click()
  await firstPage.locator('#sme-compare-run').click()
  await expect(firstPage.locator('#result-status')).toContainText('On-device calculation')
  const elapsedMs = Math.round(performance.now() - started)
  assert(elapsedMs < 300000)
  assert.equal(serviceCalls.length, 0)
  await assertPurposeTables(firstPage)
  await writeFile(path.join(output, 'sme-first-report-timing.json'), JSON.stringify({
    schema: 'commerce.sme-first-report-timing/v1', surface: 'fresh-anonymous-mobile', viewport: '360x780',
    elapsedMs, limitMs: 300000, serviceCalls: serviceCalls.length,
    sourceRevision: await firstPage.locator('meta[name="commerce-source"]').getAttribute('content'),
  }, null, 2) + '\n')
  await fresh.close()
  if (BROWSER_CHECKS.firstReport) record(BROWSER_CHECKS.firstReport)

  await page.setViewportSize({ width: 360, height: 780 })
  const workflowUrl = new URL(url); workflowUrl.searchParams.set('sme-e2e', 'workflow'); workflowUrl.hash = 'sme-workflow'
  await page.goto(workflowUrl.toString())
  await page.evaluate(() => history.replaceState(history.state, '', `${location.pathname}#sme-workflow`))
  await expect(page.locator('#sme-workflow')).toBeInViewport()
  await page.locator('#sme-compare-count').selectOption('2')
  await page.locator('#sme-workflow-table-host tr[aria-label*="Takeover price"]').click()
  await page.locator('#compare-a-price-low').fill('150000')
  await page.locator('#compare-b-price-low').fill('180000')
  await page.locator('#sme-evidence-provenance').selectOption('document_sighted')
  await page.locator('#sme-evidence-role').selectOption('adviser')
  await page.locator('#sme-evidence-date').fill('2026-10-31')
  await page.locator('#compare-evidence-price-low').fill('150000')
  await page.locator('#sme-evidence-add').click()
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Local comparison')
  await expect.poll(() => optionLabels(page)).toEqual(['A', 'B', 'Not supplied.'])
  await expect.poll(() => tableText(page)).toContain('Not supplied.')
  await expect.poll(() => tableText(page)).toContain('SG · SGD · v1.0.0')
  await expect.poll(() => tableText(page)).toContain('Cash to close')
  await assertPurposeTables(page)
  const payload = await page.evaluate(async claimSets => {
    const result = await (document.modelContext ?? navigator.modelContext).executeTool({ name: 'takeover.compare_claim_sets' }, { claim_sets: claimSets })
    return JSON.parse(result.content[0].text)
  }, [
    { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD', claims: { price: 150000 },
      evidence: [{ claim_kind: 'price', value: 150000, provenance: 'document_sighted', observer_role: 'adviser', date: '2026-10-31' }] },
    { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD', claims: { price: 180000 } },
  ])
  assert.equal(payload.persisted, false)
  assert.equal(payload.inference_tokens, 0)
  assert.equal(payload.slots[0].report.check.claim_counts_by_tier.T2, 1)
  assert.equal(payload.slots[1].report.check.claim_counts_by_tier.T2, 0)
  const parityText = await tableText(page)
  assert.match(parityText, /T2 1/)
  assert.match(parityText, /T2 0/)

  const firstOrientationText = await tableText(page)
  let previousRowIndex = -1
  for (const label of ['Cash to close', 'Gap above asking price', 'Opening runway', 'Lease exposure', 'Unchecked share', 'Missing claims']) {
    const rowIndex = firstOrientationText.indexOf(label)
    assert(rowIndex > previousRowIndex, `Expected fixed dimension ${label} in order`)
    previousRowIndex = rowIndex
  }
  const mobileScroll = await page.locator('#sme-table-host').evaluate(host => {
    const view = host.shadowRoot.querySelector('.agentic-base-data-view')
    return { clientWidth: view.clientWidth, scrollWidth: view.scrollWidth }
  })
  assert(mobileScroll.scrollWidth > mobileScroll.clientWidth, 'mobile table should remain horizontally scrollable inside Base')
  const region = page.locator('#sme-results-table-region')
  await region.focus()
  assert.equal(await region.evaluate(element => document.activeElement === element), true, 'table region should be keyboard focusable')
  const pivot = page.locator('#sme-table-host .base-multi-dimensional-table-pivot')
  await expect(pivot).toHaveAttribute('aria-label', 'Current table orientation: columns as records')
  await pivot.focus(); await pivot.press('Space')
  await expect(pivot).toHaveAttribute('aria-label', 'Current table orientation: rows as records')
  const rowOrientationText = await tableText(page)
  assert(rowOrientationText.includes('Cash to close'), 'Pivot lost the cash-to-close dimension')
  assert.deepEqual(await optionLabels(page), ['A', 'B', 'Not supplied.'])
  await pivot.press('Space')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page should not scroll horizontally')
  await page.setViewportSize({ width: 1280, height: 900 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop page should not scroll horizontally')
  await page.setViewportSize({ width: 360, height: 780 })
  assert.equal(smeServiceRequests.length, 0)

  await page.evaluate(() => {
    window.__smeRouteEvents = []
    addEventListener('hashchange', () => window.__smeRouteEvents.push('hash:' + location.hash))
    addEventListener('popstate', () => window.__smeRouteEvents.push('pop:' + location.hash))
    location.hash = 'sme'
  })
  await expect(page).toHaveURL(url + '#sme')
  await page.evaluate(() => { location.hash = 'sme-workflow' })
  await page.goBack(); await expect(page).toHaveURL(url + '#sme')
  await page.goForward(); await expect(page).toHaveURL(url + '#sme-workflow')
  const routeEvents = await page.evaluate(() => window.__smeRouteEvents)
  assert(routeEvents.includes('pop:#sme-workflow') && routeEvents.includes('hash:#sme-workflow'))
  await expect(page.locator('#compare-a-price-low')).toHaveValue('150000')

  await page.evaluate(() => { window.__smePrintOpened = false; window.print = () => { window.__smePrintOpened = true } })
  await page.getByRole('button', { name: 'Print worksheet', exact: true }).click()
  await expect(page.locator('#result-status')).toContainText('Print view opened')
  assert.equal(await page.evaluate(() => window.__smePrintOpened), true)
  const printPdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
  const printPages = Buffer.from(printPdf).toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0
  assert(printPages > 0 && printPages <= 4, `Printable worksheet should fit 1–4 pages; saw ${printPages}`)
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await expect(page.locator('body')).not.toHaveClass(/sme-printing/)
  assert.equal(await page.locator('.sme-print-sheet').count(), 0)
  await writeFile(path.join(output, 'sme-print-worksheet.pdf'), printPdf)
  await writeFile(path.join(output, 'sme-print-proof.json'), JSON.stringify({
    schema: 'commerce.sme-print-proof/v1', sourceRevision: await page.locator('meta[name="commerce-source"]').getAttribute('content'),
    evidenceEntries: 1, pages: printPages, maximumPages: 4, dialogInvoked: true, afterprintCleanup: true,
  }, null, 2) + '\n')

  await page.locator('#sme-compare-count').selectOption('3')
  await page.locator('#sme-workflow-table-host tr[aria-label*="Takeover price"]').click()
  await page.locator('#compare-c-price-low').fill('210000')
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Local comparison')
  await expect.poll(() => optionLabels(page)).toEqual(['A', 'B', 'C'])
  await expect.poll(() => tableText(page)).toContain('210,000')
  await assertPurposeTables(page)
  assert.equal(smeServiceRequests.length, 0)

  await holdNextComparison(page)
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Comparing locally')
  await page.locator('#compare-a-price-low').fill('160000')
  await releaseComparison(page)
  await expect(page.locator('#result-status')).toContainText('Inputs changed')
  const clearedTableText = await tableText(page)
  assert(clearedTableText.includes('Unknown · run local check'), 'input change should clear the old report values from the table')
  assert((await workflowTableText(page)).includes('160,000'), 'the workflow table should retain the changed buyer input')

  await holdNextComparison(page)
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Comparing locally')
  await page.locator('#workspace-role-switcher').selectOption('vendor')
  await expect(page.locator('#vendor')).toBeVisible()
  await releaseComparison(page)
  await page.locator('#workspace-role-switcher').selectOption('sme')
  await page.locator('#sme-workflow-table-host tr[aria-label*="Takeover price"]').click()
  await expect(page.locator('#compare-a-price-low')).toHaveValue('')
  await expect(page.locator('#sme-workflow-evidence-editor .sme-evidence-list')).toBeEmpty()
  await assertPurposeTables(page)
  assert.equal(smeServiceRequests.length, 0)
  await page.locator('#sample').click()
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('On-device calculation')
  if (BROWSER_CHECKS.smeComparison) record(BROWSER_CHECKS.smeComparison)
}

async function tableText(page) {
  return page.locator('#sme-table-host').evaluate(host => host.shadowRoot?.textContent ?? '')
}

async function workflowTableText(page) {
  return page.locator('#sme-workflow-table-host').evaluate(host => host.shadowRoot?.textContent ?? '')
}

async function optionLabels(page) {
  return page.locator('#sme-table-host').evaluate(host => {
    const table = host.shadowRoot.querySelector('table'), headers = [...table.querySelectorAll('thead th')]
    if (document.querySelector('#sme-results-table-region').dataset.orientation === 'columns') return headers.slice(1).map(cell => cell.innerText.trim())
    const index = headers.findIndex(cell => cell.innerText.includes('Option'))
    return [...table.querySelectorAll('tbody tr')].map(row => row.cells[index]?.innerText.trim())
  })
}

async function assertPurposeTables(page) {
  const shape = await page.locator('#sme').evaluate(root => ({
    workflowHosts: root.querySelectorAll('[data-sme-workflow-table-host]').length,
    resultsHosts: root.querySelectorAll('[data-sme-results-table-host]').length,
    workflowTables: root.querySelector('[data-sme-workflow-table-host]')?.shadowRoot?.querySelectorAll('table').length ?? 0,
    resultsTables: root.querySelector('[data-sme-results-table-host]')?.shadowRoot?.querySelectorAll('table').length ?? 0,
    legacyVariants: root.querySelectorAll('#result, #result-summary, .comparison-card, .report-section, .comparison-input-slots, .comparison-evidence').length,
    forms: root.querySelectorAll('#sme-check-form').length,
  }))
  assert.deepEqual(shape, { workflowHosts: 1, resultsHosts: 1, workflowTables: 1, resultsTables: 1, legacyVariants: 0, forms: 1 })
}

async function holdNextComparison(page) {
  await page.evaluate(() => {
    const original = Promise.race
    let release
    window.__releaseSmeComparison = () => {
      Promise.race = original
      window.__releaseSmeComparison = null
      return release().then(() => new Promise(resolve => setTimeout(resolve, 0)))
    }
    Promise.race = items => {
      const promises = Array.from(items)
      if (!release && promises.length === 2) return new Promise((resolve, reject) => {
        release = () => original.call(Promise, promises).then(value => { resolve(value); return value }, error => { reject(error); throw error })
      })
      return original.call(Promise, promises)
    }
  })
}

async function releaseComparison(page) {
  await page.evaluate(async () => { await window.__releaseSmeComparison?.() })
}
