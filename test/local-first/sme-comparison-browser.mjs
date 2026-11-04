import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs'

export async function checkSmeComparisonBrowser({ browser, page, url, output, smeServiceRequests, record }) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block' })
  const planPage = await context.newPage(), serviceCalls = [], started = performance.now()
  planPage.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/agentic-commerce-os/services/sme-business-pack')) serviceCalls.push(request.url())
  })
  await planPage.goto(url)
  await planPage.locator('#workspace-role-switcher').selectOption('sme')
  await expect(planPage.locator('#sme')).toBeVisible()
  await expect(planPage.locator('#sme-workflow-table-host')).toBeVisible()
  await planPage.locator('#sample').click()
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('Local plan built')
  const firstPlanMs = Math.round(performance.now() - started)
  assert(firstPlanMs < 300000)
  assert.equal(serviceCalls.length, 0)
  await assertSingleWorkflow(planPage)
  const headers = await workflowHeaders(planPage)
  for (const label of ['Input · Problem or need', 'Input · Model currency code', 'Model · Revenue per month', 'Pitch · deck outline', 'Plan · next checks'])
    assert(headers.includes(label), `Missing workflow column: ${label}`)
  let text = await tableText(planPage)
  assert.match(text, /USD 6,000/)
  assert.match(text, /USD 4,800/)
  await writeFile(path.join(output, 'sme-first-report-timing.json'), JSON.stringify({
    schema: 'commerce.sme-first-report-timing/v1', surface: 'fresh-anonymous-mobile', viewport: '360x780',
    elapsedMs: firstPlanMs, limitMs: 300000, serviceCalls: serviceCalls.length,
    sourceRevision: await planPage.locator('meta[name="commerce-source"]').getAttribute('content'),
  }, null, 2) + '\n')

  await planPage.locator('#sme-compare-count').selectOption('2')
  await selectScenario(planPage, 'B')
  await planPage.locator('#compare-b-currency_code').fill('USD')
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('Local scenario comparison')
  const labels = await planPage.locator('#sme-workflow-table-host').evaluate(host =>
    [...host.shadowRoot.querySelectorAll('tbody tr')].map(row => row.cells[0].innerText.trim()))
  assert.deepEqual(labels, ['Scenario A', 'Scenario B'])

  await planPage.locator('#sme-workflow-table-host').evaluate(host => host.shadowRoot.querySelector('.base-multi-dimensional-table-pivot').click())
  await expect.poll(() => planPage.locator('#sme-workflow-table-region').getAttribute('data-orientation')).toBe('columns')
  const pivotHeaders = await workflowHeaders(planPage)
  assert.deepEqual(pivotHeaders.slice(0, 3), ['Field', 'Scenario A', 'Scenario B'])
  text = await tableText(planPage)
  assert.match(text, /USD 6,000/)
  assert.match(text, /Teams lose time coordinating recurring work/)
  assert.match(text, /Slide 10\. Financial model/)

  await planPage.locator('#sme-navigation a[href="#sme-dictionary"]').click()
  await expect(planPage.locator('#sme-dictionary-heading')).toBeVisible()
  await expect(planPage.locator('#sme-dictionary-status')).toContainText('read-only schema and owner records')
  const dictionary = await planPage.locator('#sme-dictionary-table-host').evaluate(host => ({
    headers: [...host.shadowRoot.querySelectorAll('thead th')].map(cell => cell.innerText.trim()),
    rows: host.shadowRoot.querySelectorAll('tbody tr').length,
    text: host.shadowRoot.innerText,
  }))
  assert(dictionary.headers.includes('Stable key') && dictionary.headers.includes('Formula / source'))
  assert(dictionary.rows >= 50)
  assert.match(dictionary.text, /sme\.business-plan/)
  assert.match(dictionary.text, /business\.plan\.build/)
  assert.match(dictionary.text, /DICTIONARY-SEMANTIC/)
  assert.match(dictionary.text, /pitch_deck_outline/)
  assert.equal(await planPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(serviceCalls.length, 0)
  await assertSingleWorkflow(planPage)
  await writeFile(path.join(output, 'sme-first-report-timing.json'), JSON.stringify({
    schema: 'commerce.sme-first-report-timing/v1', surface: 'fresh-anonymous-mobile', viewport: '360x780',
    elapsedMs: firstPlanMs, limitMs: 300000, serviceCalls: serviceCalls.length,
    sourceRevision: await planPage.locator('meta[name="commerce-source"]').getAttribute('content'),
  }, null, 2) + '\n')
  await context.close()

  await page.setViewportSize({ width: 360, height: 780 })
  await page.goto(url + '#sme-workflow')
  await expect(page.locator('#sme-workflow')).toBeInViewport()
  await assertSingleWorkflow(page)
  if (BROWSER_CHECKS.firstReport) record(BROWSER_CHECKS.firstReport)
  if (BROWSER_CHECKS.smeComparison) record(BROWSER_CHECKS.smeComparison)
}

async function tableText(page) {
  return page.locator('#sme-workflow-table-host').evaluate(host => host.shadowRoot?.textContent ?? '')
}

async function workflowHeaders(page) {
  return page.locator('#sme-workflow-table-host').evaluate(host =>
    [...host.shadowRoot.querySelectorAll('table thead th')].map(cell => cell.innerText.trim()))
}

async function selectScenario(page, slot) {
  await page.locator('#sme-workflow-table-host').evaluate((host, row) => {
    host.shadowRoot.querySelector(`tbody tr[aria-label="Data row: Scenario ${row}"]`)?.click()
  }, slot)
  await expect(page.locator('#sme-workflow-editor-heading')).toHaveText(`Edit · Scenario ${slot}`)
}

async function assertSingleWorkflow(page) {
  const shape = await page.locator('#sme').evaluate(root => ({
    workflowHosts: root.querySelectorAll('[data-sme-workflow-table-host]').length,
    dictionaryHosts: root.querySelectorAll('[data-sme-dictionary-table-host], #sme-dictionary-table-host').length,
    legacyResultHosts: root.querySelectorAll('[data-sme-results-table-host], #result, #result-summary').length,
    workflowNavigation: root.ownerDocument.querySelectorAll('#sme-navigation a[href="#sme-workflow"]').length,
    dictionaryNavigation: root.ownerDocument.querySelectorAll('#sme-navigation a[href="#sme-dictionary"]').length,
  }))
  assert.deepEqual(shape, { workflowHosts: 1, dictionaryHosts: 1, legacyResultHosts: 0, workflowNavigation: 1, dictionaryNavigation: 1 })
}
