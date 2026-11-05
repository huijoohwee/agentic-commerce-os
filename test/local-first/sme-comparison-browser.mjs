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
  await expect(planPage.getByText('Choose a plan mode and contract. One table keeps all declared inputs, evidence, calculations, coverage, and next checks together. Select a plan row to edit its fields and evidence, or inspect each field in metadata columns.', { exact: true })).toBeVisible()
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
  assert.equal(new Set(headers).size, headers.length, 'Shared Multi-dimensional Table labels must be unique')
  for (const label of ['Plan › Selection › Mode and contract [plan-mode]', 'Problem or need', 'Model currency code',
    'Buy/Build approach', 'Existing business or asset purchase price', 'Acquisition and transition costs',
    'Readiness › Input coverage › required inputs [plan-completeness]',
    'Readiness › Validation › invalid entries [data-validation]', 'Evidence › Field context › values [evidence-values]',
    'Evidence › Record attributes › provenance [evidence-provenance]', 'Evidence › Record attributes › observer role [evidence-observer]',
    'Evidence › Record attributes › date [evidence-date]', 'Evidence › Record status › status [evidence-status]',
    'Readiness › Model coverage › calculated outputs [model-coverage]', 'Coverage › projection › pitch inputs [pitch_deck]',
    'Coverage › projection › business-plan inputs [business_plan]', 'Coverage › projection › financial model [financial_model]',
    'Coverage › evidence › evidence prompts [evidence]', 'Model › Calculated outputs › Revenue per month [monthly_revenue]',
    'Pitch › Slide 1 › Venture and stage', 'Pitch › Slide 12 › Risks and milestones', 'Plan › Follow-up › next checks [next-checks]'])
    assert(headers.some(header => header.startsWith(label)), `Missing workflow column: ${label}`)
  assert(headers.includes('Venture or project name'))
  assert(!headers.some(header => header.includes('venture_name') || / · (?:text|enum|money|currency) · /u.test(header)), 'Field metadata should not be concatenated into input headers')
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
  await expect(planPage.locator('#sme-workflow-table-region')).toHaveAttribute('aria-label', /Scenarios are rows/)
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

  await planPage.locator('#sme-workflow-pivot').click()
  await expect.poll(() => planPage.locator('#sme-workflow-table-region').getAttribute('data-orientation')).toBe('columns')
  const pivotHeaders = await workflowHeaders(planPage)
  assert.deepEqual(pivotHeaders.slice(0, 14), ['Record type', 'Section', 'Group', 'Parameter', 'Stable key', 'Data type', 'Unit', 'Requirement', 'Allowed values', 'Minimum', 'Maximum', 'Length limit', 'Pattern', 'Definition'])
  assert.deepEqual(pivotHeaders.slice(-2), ['Scenario A', 'Scenario B'])
  const ventureField = await planPage.locator('#sme-workflow-table-host').evaluate(host => {
    const headers = [...host.shadowRoot.querySelectorAll('thead th')].map(cell => cell.innerText.trim())
    const row = [...host.shadowRoot.querySelectorAll('tbody tr')].find(item => item.cells[headers.indexOf('Parameter')]?.innerText.trim() === 'Venture or project name')
    return row ? Object.fromEntries(headers.map((header, index) => [header, row.cells[index].innerText.trim()])) : null
  })
  assert.equal(ventureField.Section, 'Venture')
  assert.equal(ventureField.Parameter, 'Venture or project name')
  assert.equal(ventureField['Stable key'], 'venture_name')
  assert.equal(ventureField['Data type'], 'text')
  assert.equal(ventureField.Requirement, 'optional')
  assert.equal(await planPage.locator('#sme-workflow-table-host').evaluate(host => host.shadowRoot.querySelectorAll('.base-multi-dimensional-table-pivot').length), 0)
  await assertSingleWorkflow(planPage)
  text = await tableText(planPage)
  assert.match(text, /USD 6,000/)
  assert.match(text, /A defined user group has a recurring task that takes time to complete/)
  assert.match(text, /Venture and stage/)
  assert.match(text, /Slide 1/)

  const navigationToggle = planPage.locator('#workspace-navigation-toggle')
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-dictionary"]').click()
  await expect(planPage.locator('#sme-dictionary-heading')).toBeVisible()
  await expect(planPage.locator('#sme-dictionary-status')).toContainText('read-only schema and owner records')
  const dictionary = await planPage.locator('#sme-dictionary-table-host').evaluate(host => ({
    headers: [...host.shadowRoot.querySelectorAll('thead th')].map(cell => cell.innerText.trim()),
    rows: [...host.shadowRoot.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.innerText.trim())),
    text: host.shadowRoot.textContent,
  }))
  const recordColumn = dictionary.headers.indexOf('Record'), keyColumn = dictionary.headers.indexOf('Stable key'), requiredColumn = dictionary.headers.indexOf('Required')
  const dictionaryRecords = dictionary.rows.map(row => ({ record: row[recordColumn], key: row[keyColumn], required: row[requiredColumn] }))
  const conditionalRequirements = dictionaryRecords
    .filter(row => row.record === 'Input field' && ['buy_build_path', 'acquisition_price', 'transition_costs'].includes(row.key))
    .map(row => [row.key, row.required])
  const inputKeys = dictionaryRecords.filter(row => row.record === 'Input field').map(row => row.key)
  const hierarchyKeys = dictionaryRecords.filter(row => row.record === 'Hierarchy group').map(row => row.key)
  assert(dictionary.headers.includes('Stable key') && dictionary.headers.includes('Formula / source'))
  assert(dictionary.rows.length >= 50)
  assert(hierarchyKeys.includes('group:Inputs'))
  assert(hierarchyKeys.includes('group:Inputs.Buy/Build'))
  assert.match(dictionary.text, /sme\.business-plan/)
  assert.match(dictionary.text, /business\.plan\.build/)
  assert.match(dictionary.text, /DICTIONARY-SEMANTIC/)
  assert.match(dictionary.text, /pitch_deck_outline/)
  assert.match(dictionary.text, /Coverage output/)
  assert.match(dictionary.text, /workflow_columns/)
  assert.match(dictionary.text, /Workflow mode/)
  assert.match(dictionary.text, /plan_modes/)
  assert.match(dictionary.text, /buy_build_path/)
  assert.deepEqual(conditionalRequirements, [
    ['buy_build_path', 'Conditional'], ['acquisition_price', 'Conditional'], ['transition_costs', 'Conditional'],
  ])
  assert.equal(new Set(inputKeys).size, inputKeys.length, 'Active contract input keys must be unique')
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
    assert.match(text, /Calculated outputs/)
    assert.match(text, /Revenue per month/)
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
  assert.equal(new Set(takeoverHeaders).size, takeoverHeaders.length, 'Takeover checker column labels must be unique')
  for (const label of ['Currency code', 'Transfer structure', 'Business or asset purchase price', 'Items or rights included', 'Items or rights excluded',
    'User-entered equipment resale estimate', 'User-entered current improvements estimate', 'User-entered monthly revenue', 'Financial information basis',
    'Financial information period covered', 'Location payment obligation', 'User-stated location renewal period', 'User-stated location assignment status', 'Cash available for the acquisition',
    'Model › Calculated outputs › Cash required to close and fund the selected period [cash_to_close]',
    'Model › Calculated outputs › Remaining location payment exposure [location_exposure]',
    'Model › Calculated outputs › Cash shortfall after available cash [cash_shortfall]',
    'Model › Calculated outputs › User-entered monthly revenue less listed monthly costs [operating_difference_per_month]'])
    assert(takeoverHeaders.some(header => header.startsWith(label)), `Missing takeover checker column: ${label}`)
  assert(!takeoverHeaders.some(header => header.startsWith('Pitch › Slide')), 'Contract-specific pitch columns leaked into the takeover checker')
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
  await setWorkflowOrientation(planPage, 'rows')
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
    [...host.shadowRoot.querySelectorAll('table thead th')].map(cell => cell.innerText.trim().replace(/\s+/gu, ' ')))
}

async function setWorkflowOrientation(page, orientation) {
  const region = page.locator('#sme-workflow-table-region')
  if (await region.getAttribute('data-orientation') === orientation) return
  await page.locator('#sme-workflow-pivot').click()
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
