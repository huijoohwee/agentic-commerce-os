import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
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
  await expect(planPage.locator('#sme-plan-mode')).toHaveValue('buy_build')
  await expect(planPage.getByText('Choose a plan mode and contract. One table keeps all declared inputs, evidence, calculations, coverage, and next checks together. Select a row to edit its fields and evidence.', { exact: true })).toBeVisible()
  await planPage.locator('#sample').click()
  await planPage.locator('#compare-a-buy_build_path').selectOption('buy_existing')
  await expect(planPage.locator('#compare-a-acquisition_price-low')).toHaveAttribute('aria-required', 'true')
  await expect(planPage.locator('#compare-a-transition_costs-low')).toHaveAttribute('aria-required', 'true')
  await planPage.locator('#compare-a-buy_build_path').selectOption('build_new')
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('Local Buy/Build plan built')
  const firstPlanMs = Math.round(performance.now() - started)
  assert(firstPlanMs < 300000)
  assert.equal(serviceCalls.length, 0)
  await assertSingleWorkflow(planPage)
  const headers = await workflowHeaders(planPage)
  assert(headers.length <= 64, 'Shared Multi-dimensional Table column limit exceeded')
  for (const label of ['Plan · mode and contract', 'Input · Problem or need', 'Input · Model currency code', 'Input · Buy/Build approach',
    'Input · Existing business or asset purchase price', 'Input · Acquisition and transition costs', 'Readiness · required inputs',
    'Readiness · invalid entries', 'Evidence · values', 'Evidence · provenance', 'Evidence · observer role', 'Evidence · date',
    'Evidence · status', 'Coverage · calculated outputs', 'Coverage · pitch inputs',
    'Coverage · business-plan inputs', 'Coverage · financial model', 'Coverage · evidence prompts',
    'Model · Revenue per month', 'Pitch · Slide 1 · Venture and stage', 'Pitch · Slide 12 · Risks and milestones', 'Plan · next checks'])
    assert(headers.some(header => header === label || header.startsWith(`${label} ·`)), `Missing workflow column: ${label}`)
  let text = await tableText(planPage)
  assert.match(text, /USD 6,000/)
  assert.match(text, /USD 4,800/)
  await writeFile(path.join(output, 'sme-first-report-timing.json'), JSON.stringify({
    schema: 'commerce.sme-first-report-timing/v1', surface: 'fresh-anonymous-mobile', viewport: '360x780',
    elapsedMs: firstPlanMs, limitMs: 300000, serviceCalls: serviceCalls.length,
    sourceRevision: await planPage.locator('meta[name="commerce-source"]').getAttribute('content'),
  }, null, 2) + '\n')

  await planPage.locator('#sme-plan-mode').selectOption('scenario')
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('Illustrative project')
  await expect(planPage.locator('#sme-workflow-table-region')).toHaveAttribute('aria-label', /Plan scenarios are rows/)
  await planPage.locator('#sme-compare-count').selectOption('2')
  await selectScenario(planPage, 'B')
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('same plan contract and currency code across rows')
  await planPage.locator('#compare-b-currency_code').fill('USD')
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('Local scenario comparison')
  const labels = await planPage.locator('#sme-workflow-table-host').evaluate(host =>
    [...host.shadowRoot.querySelectorAll('tbody tr')].map(row => row.cells[0].innerText.trim()))
  assert.deepEqual(labels, ['Scenario A', 'Scenario B'])
  assert.match(await tableText(planPage), /Scenario/)

  await planPage.locator('#sme-workflow-table-host').evaluate(host => host.shadowRoot.querySelector('.base-multi-dimensional-table-pivot').click())
  await expect.poll(() => planPage.locator('#sme-workflow-table-region').getAttribute('data-orientation')).toBe('columns')
  const pivotHeaders = await workflowHeaders(planPage)
  assert.deepEqual(pivotHeaders.slice(0, 3), ['Field', 'Scenario A', 'Scenario B'])
  text = await tableText(planPage)
  assert.match(text, /USD 6,000/)
  assert.match(text, /A defined user group has a recurring task that takes time to complete/)
  assert.match(text, /Pitch · Slide 1 · Venture and stage/)

  const navigationToggle = planPage.locator('#workspace-navigation-toggle')
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-dictionary"]').click()
  await expect(planPage.locator('#sme-dictionary-heading')).toBeVisible()
  await expect(planPage.locator('#sme-dictionary-status')).toContainText('read-only schema and owner records')
  const dictionary = await planPage.locator('#sme-dictionary-table-host').evaluate(host => ({
    headers: [...host.shadowRoot.querySelectorAll('thead th')].map(cell => cell.innerText.trim()),
    rows: host.shadowRoot.querySelectorAll('tbody tr').length,
    text: host.shadowRoot.textContent,
    conditionalRequirements: [...host.shadowRoot.querySelectorAll('tbody tr')]
      .map(row => [...row.cells].map(cell => cell.innerText.trim()))
      .filter(row => row[0] === 'Input field' && ['buy_build_path', 'acquisition_price', 'transition_costs'].includes(row[1]))
      .map(row => [row[1], row[6]]),
    inputKeys: [...host.shadowRoot.querySelectorAll('tbody tr')]
      .map(row => [...row.cells].map(cell => cell.innerText.trim()))
      .filter(row => row[0] === 'Input field').map(row => row[1]),
  }))
  assert(dictionary.headers.includes('Stable key') && dictionary.headers.includes('Formula / source'))
  assert(dictionary.rows >= 50)
  assert.match(dictionary.text, /sme\.business-plan/)
  assert.match(dictionary.text, /business\.plan\.build/)
  assert.match(dictionary.text, /DICTIONARY-SEMANTIC/)
  assert.match(dictionary.text, /pitch_deck_outline/)
  assert.match(dictionary.text, /Coverage output/)
  assert.match(dictionary.text, /workflow_columns/)
  assert.match(dictionary.text, /Workflow mode/)
  assert.match(dictionary.text, /plan_modes/)
  assert.match(dictionary.text, /buy_build_path/)
  assert.deepEqual(dictionary.conditionalRequirements, [
    ['buy_build_path', 'Conditional'], ['acquisition_price', 'Conditional'], ['transition_costs', 'Conditional'],
  ])
  assert.equal(new Set(dictionary.inputKeys).size, dictionary.inputKeys.length, 'Active contract input keys must be unique')
  assert.match(dictionary.text, /evidence-values/)
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-workflow"]').click()
  await planPage.locator('#sample').click()
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('Local scenario plan built')
  for (const [format, selector] of [['json', '[data-export="json"]'], ['csv', '[data-export="csv"]'], ['markdown', '[data-export="markdown"]']]) {
    const downloadEvent = planPage.waitForEvent('download')
    await planPage.locator(selector).click()
    const download = await downloadEvent, content = await readFile(await download.path(), 'utf8')
    await planPage.locator('#sme-worksheet-import').setInputFiles({
      name: download.suggestedFilename(), mimeType: format === 'json' ? 'application/json'
        : format === 'csv' ? 'text/csv' : 'text/markdown', buffer: Buffer.from(content),
    })
    await expect(planPage.locator('#workflow-status')).toContainText('Worksheet imported in this tab')
    await expect(planPage.locator('#sme-plan-mode')).toHaveValue('scenario')
    await planPage.locator('#sme-compare-run').click()
    await expect(planPage.locator('#workflow-status')).toContainText('Local scenario plan built')
    text = await tableText(planPage)
    assert.match(text, /Model · Revenue per month/)
    assert.match(text, /USD 6,000/)
    await assertSingleWorkflow(planPage)
  }

  const contracts = await planPage.locator('#pack-id option').evaluateAll(options => options.map(option => option.textContent.trim()))
  assert(contracts.some(label => label.startsWith('SME takeover checker · v1.1.0')))
  await planPage.locator('#pack-id').selectOption('sme.takeover-checker')
  await expect(planPage.locator('#service-status')).toContainText('SME takeover checker · v1.1.0')
  await expect(planPage.locator('#sme-plan-mode')).toHaveValue('buy_build')
  await setWorkflowOrientation(planPage, 'rows')
  const takeoverHeaders = await workflowHeaders(planPage)
  for (const label of ['Input · Currency code', 'Input · Transfer structure', 'Input · Business or asset purchase price',
    'Input · Items or rights included', 'Input · Items or rights excluded', 'Input · User-entered equipment resale estimate',
    'Input · User-entered current improvements estimate', 'Input · User-entered monthly revenue', 'Input · Financial information basis',
    'Input · Financial information period covered', 'Input · Location payment obligation', 'Input · User-stated location renewal period',
    'Input · User-stated location assignment status',
    'Input · Cash available for the acquisition', 'Model · Cash required to close and fund the selected period',
    'Model · Remaining location payment exposure', 'Model · Cash shortfall after available cash',
    'Model · User-entered monthly revenue less listed monthly costs'])
    assert(takeoverHeaders.some(header => header === label || header.startsWith(`${label} ·`)), `Missing takeover checker column: ${label}`)
  assert(!takeoverHeaders.some(header => header.startsWith('Pitch · Slide')), 'Contract-specific pitch columns leaked into the takeover checker')
  await planPage.locator('#sample').click()
  await planPage.locator('#sme-compare-run').click()
  await expect(planPage.locator('#workflow-status')).toContainText('Local Buy/Build plan built')
  text = await tableText(planPage)
  assert.match(text, /USD 117,000/)
  assert.match(text, /USD 21,600/)
  assert.match(text, /USD 97,000/)
  assert.match(text, /USD 3,700/)
  await assertSingleWorkflow(planPage)

  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-dictionary"]').click()
  await expect(planPage.locator('#sme-dictionary-status')).toContainText('SME takeover checker · v1.1.0')
  const takeoverDictionary = await tableTextFor(planPage, '#sme-dictionary-table-host')
  assert.match(takeoverDictionary, /sme\.takeover-checker/)
  assert.match(takeoverDictionary, /transaction_structure/)
  assert.match(takeoverDictionary, /financial_basis/)
  assert.match(takeoverDictionary, /location_obligation/)
  assert.match(takeoverDictionary, /takeover-cash\/v1/)
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-workflow"]').click()
  await planPage.locator('#sme-plan-mode').selectOption('scenario')
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('Scenario A')
  await expect(planPage.locator('#compare-a-purchase_price-low')).toHaveValue('80000')
  await planPage.locator('#pack-id').selectOption('sme.business-plan')
  await expect(planPage.locator('#service-status')).toContainText('General business plan · v2.3.0')
  await expect(planPage.locator('#sme-plan-mode')).toHaveValue('buy_build')
  await expect(planPage.locator('#compare-a-purchase_price-low')).toHaveCount(0)
  assert((await workflowHeaders(planPage)).some(header => header.includes('Venture or project name')))
  await assertSingleWorkflow(planPage)

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

async function tableTextFor(page, selector) {
  return page.locator(selector).evaluate(host => host.shadowRoot?.textContent ?? '')
}

async function workflowHeaders(page) {
  return page.locator('#sme-workflow-table-host').evaluate(host =>
    [...host.shadowRoot.querySelectorAll('table thead th')].map(cell => cell.innerText.trim()))
}

async function setWorkflowOrientation(page, orientation) {
  const region = page.locator('#sme-workflow-table-region')
  if (await region.getAttribute('data-orientation') === orientation) return
  await page.locator('#sme-workflow-table-host').evaluate(host =>
    host.shadowRoot.querySelector('.base-multi-dimensional-table-pivot')?.click())
  await expect.poll(() => region.getAttribute('data-orientation')).toBe(orientation)
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
