import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs'

export async function checkSmeComparisonBrowser({ browser, page, url, output, smeServiceRequests, record }) {
  const fresh = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block' })
  const firstPage = await fresh.newPage(), serviceCalls = []
  firstPage.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/agentic-commerce-os/services/sme-business-pack')) serviceCalls.push(request.url())
  })
  const started = performance.now()
  await firstPage.goto(url)
  await expect(firstPage.locator('#workspace-role-switcher')).toBeVisible()
  await firstPage.locator('#workspace-role-switcher').selectOption('sme')
  await expect(firstPage.locator('#sme')).toBeVisible()
  await firstPage.locator('#sample').click()
  await firstPage.locator('#sme-check-form button[type="submit"]').click()
  await expect(firstPage.locator('#result-status')).toContainText('On-device calculation')
  const elapsedMs = Math.round(performance.now() - started)
  assert(elapsedMs < 300000)
  assert.equal(serviceCalls.length, 0)
  await writeFile(path.join(output, 'sme-first-report-timing.json'), JSON.stringify({
    schema: 'commerce.sme-first-report-timing/v1', surface: 'fresh-anonymous-mobile', viewport: '360x780',
    elapsedMs, limitMs: 300000, serviceCalls: serviceCalls.length,
    sourceRevision: await firstPage.locator('meta[name="commerce-source"]').getAttribute('content'),
  }, null, 2) + '\n')
  await fresh.close()
  if (BROWSER_CHECKS.firstReport) record(BROWSER_CHECKS.firstReport)

  await page.setViewportSize({ width: 360, height: 780 })
  await page.goto(url + '#sme-compare')
  await expect(page.locator('#sme-compare')).toBeInViewport()
  await page.locator('#compare-a-price-low').fill('150000')
  await page.locator('#compare-b-price-low').fill('180000')
  await page.locator('#compare-evidence-a-details > summary').click()
  await page.locator('#compare-evidence-a-kind').selectOption('price')
  await page.locator('#compare-evidence-a-provenance').selectOption('document_sighted')
  await page.locator('#compare-evidence-a-role').selectOption('adviser')
  await page.locator('#compare-evidence-a-date').fill('2026-10-31')
  await page.locator('#compare-evidence-a-price-low').fill('150000')
  await page.locator('#compare-evidence-a-add').click()
  await page.locator('#sme-compare-run').click()
  const result = page.locator('#result-summary')
  await expect(result).toContainText('Slot A')
  await expect(result).toContainText('Slot B')
  await expect(result).toContainText('Not supplied.')
  await expect(result).toContainText('No winner reported')
  await expect(result).toContainText('Singapore · SGD')
  await expect(result).toContainText('Pack v1.0.0')
  await expect(result).toContainText('As of 2026-10-22')
  await expect(result).toContainText('Unknown · incomplete')
  await expect(result.locator('.base-multi-dimensional-table')).toHaveCount(1)
  await expect(result.locator('.comparison-card')).toHaveCount(0)
  const tableText = async () => result.locator('[data-sme-comparison-table-host]').evaluate(host => host.shadowRoot.textContent)
  const table = result.locator('[data-sme-comparison-table-host] .base-multi-dimensional-table')
  await expect(table).toContainText('Slot A')
  await expect(table).toContainText('Slot B')
  const fixedRows = ['Cash to close', 'Gap above asking price', 'Opening runway', 'Lease exposure', 'Unchecked share', 'Missing claims']
  const firstOrientationText = await tableText()
  let previousRowIndex = -1
  for (const label of fixedRows) {
    const rowIndex = firstOrientationText.indexOf(label)
    assert(rowIndex > previousRowIndex, `Expected fixed comparison row ${label} in order`)
    previousRowIndex = rowIndex
  }
  const mobileScroll = await result.locator('[data-sme-comparison-table-host]').evaluate(host => {
    const view = host.shadowRoot.querySelector('.agentic-base-data-view')
    return { clientWidth: view.clientWidth, scrollWidth: view.scrollWidth }
  })
  assert(mobileScroll.scrollWidth > mobileScroll.clientWidth, 'mobile comparison should remain horizontally scrollable inside Base')
  await result.scrollIntoViewIfNeeded()
  const touch = await page.context().newCDPSession(page)
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, configuration: 'mobile' })
  const touchBounds = await result.locator('[data-sme-comparison-table-host]').evaluate(host => {
    const view = host.shadowRoot.querySelector('.agentic-base-data-view'), rect = view.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, left: view.scrollLeft }
  })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: touchBounds.x + touchBounds.width - 12, y: touchBounds.y + 80, force: 1 }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: touchBounds.x + 24, y: touchBounds.y + 80, force: 1 }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const touchLeft = await result.locator('[data-sme-comparison-table-host]').evaluate(host => host.shadowRoot.querySelector('.agentic-base-data-view').scrollLeft)
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await touch.detach()
  assert(touchLeft > touchBounds.left, 'touch swipe should scroll the shared Base table')
  const region = result.locator('.comparison-table-scroll')
  await region.focus()
  assert.equal(await region.evaluate(element => document.activeElement === element), true, 'comparison region should be keyboard focusable')
  const pivot = result.locator('.base-multi-dimensional-table-pivot')
  await expect(pivot).toHaveAttribute('aria-label', 'Current table orientation: columns as records')
  await pivot.focus()
  await pivot.press('Space')
  await expect(pivot).toHaveAttribute('aria-label', 'Current table orientation: rows as records')
  const rowOrientationText = await tableText()
  for (const label of fixedRows) assert(rowOrientationText.includes(label), `Pivot lost comparison row ${label}`)
  for (const label of ['Slot A', 'Slot B']) assert(rowOrientationText.includes(label), `Pivot lost ${label}`)
  await pivot.press('Space')
  await expect(pivot).toHaveAttribute('aria-label', 'Current table orientation: columns as records')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page should not scroll horizontally')
  await page.setViewportSize({ width: 1280, height: 900 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop page should not scroll horizontally')
  await page.setViewportSize({ width: 360, height: 780 })
  assert.equal(smeServiceRequests.length, 0)
  const payload = JSON.parse(await page.locator('#result').textContent())
  assert.equal(payload.persisted, false)
  assert.equal(payload.inference_tokens, 0)
  assert.equal(payload.slots[0].report.check.claim_counts_by_tier.T2, 1)
  assert.equal(payload.slots[0].report.budget.budget.lines.find(row => row.id === 'L1').checked, true)
  assert.equal(payload.slots[1].report.check.claim_counts_by_tier.T2, 0)
  const inPageComparison = await page.evaluate(async claim_sets => {
    const result = await document.modelContext.executeTool({ name: 'takeover.compare_claim_sets' }, { claim_sets })
    return JSON.parse(result.content[0].text)
  }, [
    { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD', claims: { price: 150000 },
      evidence: [{ claim_kind: 'price', value: 150000, provenance: 'document_sighted', observer_role: 'adviser', date: '2026-10-31' }] },
    { pack_id: 'sg.fnb.takeover', pack_version: '1.0.0', currency: 'SGD', claims: { price: 180000 } },
  ])
  assert.deepEqual(inPageComparison, payload)

  await page.evaluate(() => {
    window.__smeRouteEvents = []
    addEventListener('hashchange', () => window.__smeRouteEvents.push('hash:' + location.hash))
    addEventListener('popstate', () => window.__smeRouteEvents.push('pop:' + location.hash))
    location.hash = 'sme'
  })
  await expect(page).toHaveURL(url + '#sme')
  await page.evaluate(() => { location.hash = 'sme-compare' })
  await page.goBack()
  await expect(page).toHaveURL(url + '#sme')
  await page.goForward()
  await expect(page).toHaveURL(url + '#sme-compare')
  const routeEvents = await page.evaluate(() => window.__smeRouteEvents)
  assert(routeEvents.includes('pop:#sme-compare') && routeEvents.includes('hash:#sme-compare'))
  await expect(page.locator('#sme-compare')).toBeInViewport()
  await expect(page.locator('#compare-a-price-low')).toHaveValue('150000')

  await page.locator('#claim-price-low').fill('150000')
  await page.locator('#sme-check-form button[type="submit"]').click()
  await expect(result).toContainText('Cash to close')
  await page.locator('#sample').click()
  await page.locator('#sme-evidence-kind').selectOption('price')
  await page.locator('#sme-evidence-provenance').selectOption('document_sighted')
  await page.locator('#sme-evidence-role').selectOption('adviser')
  await page.locator('#sme-evidence-date').fill('2026-10-31')
  await page.locator('#evidence-price-low').fill('150000')
  await page.evaluate(() => { for (let index = 0; index < 40; index++) document.querySelector('#sme-add-evidence').click() })
  await page.locator('#sme-check-form button[type="submit"]').click()
  await expect(result).toContainText('Cash to close')
  await page.evaluate(() => { window.__smePrintOpened = false; window.print = () => { window.__smePrintOpened = true } })
  await page.getByRole('button', { name: 'Print worksheet', exact: true }).click()
  await expect(page.locator('#result-status')).toContainText(/Print view opened|Print worksheet refused/)
  const printStatus = await page.locator('#result-status').textContent()
  assert.match(printStatus ?? '', /Print view opened/, `Printable worksheet failed: ${await page.locator('#result-status').getAttribute('data-print-error')}`)
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
    evidenceEntries: 40, pages: printPages, maximumPages: 4, dialogInvoked: true, afterprintCleanup: true,
  }, null, 2) + '\n')
  await holdNextComparison(page)
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Comparing locally')
  await expect(page.locator('#result')).toHaveText('')
  await releaseComparison(page)
  await expect(result).toContainText('Slot A')

  await page.locator('#sme-compare-count').selectOption('3')
  await page.locator('#compare-c-price-low').fill('210000')
  await page.locator('#sme-compare-run').click()
  await expect(result.locator('.base-multi-dimensional-table')).toHaveCount(1)
  await expect(result.locator('.comparison-card')).toHaveCount(0)
  await expect(result.locator('[data-sme-comparison-table-host] .base-multi-dimensional-table')).toContainText('Slot C')
  await expect(result.locator('[data-sme-comparison-table-host] .base-multi-dimensional-table')).toContainText('210,000')
  await expect(result).not.toContainText('Not supplied.')
  assert.equal(smeServiceRequests.length, 0)

  await holdNextComparison(page)
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Comparing locally')
  await page.locator('#compare-a-price-low').fill('160000')
  await releaseComparison(page)
  await expect(page.locator('#result')).toHaveText('')
  await expect(result).not.toContainText('Slot A')

  await holdNextComparison(page)
  await page.locator('#sme-compare-run').click()
  await expect(page.locator('#result-status')).toContainText('Comparing locally')
  await page.locator('#workspace-role-switcher').selectOption('vendor')
  await expect(page.locator('#vendor')).toBeVisible()
  await releaseComparison(page)
  await page.locator('#workspace-role-switcher').selectOption('sme')
  await expect(page.locator('#compare-a-price-low')).toHaveValue('')
  await expect(page.locator('#compare-evidence-a-list')).toBeEmpty()
  await expect(page.locator('#result')).toHaveText('')
  assert.equal(smeServiceRequests.length, 0)
  await page.locator('#sample').click()
  await page.locator('#sme-evidence-kind').selectOption('price')
  await page.locator('#sme-evidence-provenance').selectOption('document_sighted')
  await page.locator('#sme-evidence-role').selectOption('buyer')
  await page.locator('#sme-evidence-date').fill('2026-10-31')
  await page.locator('#evidence-price-low').fill('150000')
  await page.locator('#sme-add-evidence').click()
  await page.locator('#sme-check-form button[type="submit"]').click()
  await expect(page.locator('#result-status')).toContainText('On-device calculation')
  if (BROWSER_CHECKS.smeComparison) record(BROWSER_CHECKS.smeComparison)
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
