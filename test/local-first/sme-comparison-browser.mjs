import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs'

export async function checkSmeComparisonBrowser({ browser, page, url, output, smeServiceRequests, record }) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block' })
  const planPage = await context.newPage(), serviceCalls = [], ganttCalls = [], started = performance.now()
  planPage.on('request', request => {
    if (request.url().includes('/graph-gantt-timeline.')) ganttCalls.push(request.url())
    if (new URL(request.url()).pathname.startsWith('/agentic-commerce-os/services/sme-business-pack')) serviceCalls.push(request.url())
  })
  await planPage.goto(url)
  await planPage.locator('#workspace-role-switcher').selectOption('sme')
  await expect(planPage.locator('#sme')).toBeVisible()
  await expect(planPage.locator('#sme-workflow-table-host')).toBeVisible()
  await expect(planPage.locator('#sme-plan-mode')).toHaveValue('buy_build')
  await expect(planPage.locator('#sme-review-controls')).toBeHidden()
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
  const metadataHeaders = ['Record type', 'Section', 'Group', 'Parameter', 'Stable key', 'Data type', 'Unit', 'Requirement',
    'Allowed values', 'Minimum', 'Maximum', 'Length limit', 'Pattern', 'Definition']
  await expect.poll(async () => (await workflowHeaders(planPage)).filter(Boolean).slice(0, metadataHeaders.length)).toEqual(metadataHeaders)
  const pivotHeaders = (await workflowHeaders(planPage)).filter(Boolean)
  assert.deepEqual(pivotHeaders.slice(0, 14), metadataHeaders)
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
  assert(contracts.some(label => label.startsWith('SME takeover checker · v1.2.0')))
  await planPage.locator('#pack-id').selectOption('sme.takeover-checker')
  await expect(planPage.locator('#service-status')).toContainText('SME takeover checker · v1.2.0')
  await expect(planPage.locator('#sme-plan-mode')).toHaveValue('buy_build')
  const guide = planPage.locator('#sme-review-controls'), gantt = planPage.locator('#sme-review-timeline')
  await expect(guide).toBeVisible()
  await expect(planPage.locator('#sme-review-view')).toHaveValue('review')
  assert.deepEqual((await workflowHeaders(planPage)).filter(Boolean).slice(0,5), ['Record type', 'Section', 'Group', 'Parameter', 'Stable key'])
  const reviewCells = await fieldRow(planPage, 'buyer_budget').innerText()
  await fieldRow(planPage, 'buyer_budget').click()
  await expect(planPage.locator('#compare-a-buyer_budget-low')).toBeFocused()
  await planPage.locator('#compare-a-buyer_budget-low').fill('125000')
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('125,000')
  assert.equal(ganttCalls.length, 0, 'Gantt assets must load only on demand')
  let releaseGantt; const gate = new Promise(resolve => { releaseGantt = resolve })
  await planPage.route('**/graph-gantt-timeline.js', async route => { await gate; await route.continue() })
  await planPage.locator('#sme-review-view').selectOption('gantt')
  await expect.poll(() => ganttCalls.length).toBeGreaterThan(0)
  await planPage.locator('#sme-review-view').selectOption('review'); releaseGantt()
  await expect(gantt).toBeHidden(); await expect(planPage.locator('#sme-workflow-table-host')).toBeVisible()
  await planPage.locator('#sme-review-view').selectOption('gantt')
  await expect(gantt.getByRole('button', { name: 'Select 1. Frame the review', exact: true })).toBeVisible()
  await expect(gantt).toContainText('Dependency order; dates are optional')
  assert.equal(await gantt.locator('.timeline-transport-track-clip').count(), 3)
  const labelHeights = await gantt.locator('.timeline-video-sequence-lane-select').evaluateAll(labels => labels.map(label => {
    const range = document.createRange(); range.selectNodeContents(label)
    return { text: range.getBoundingClientRect().height, lane: label.getBoundingClientRect().height }
  }))
  assert(labelHeights.every(item => item.text <= item.lane), 'Activity text must not spill into another native lane')
  assert.equal(await gantt.locator('time[datetime]').count(), 0, 'Dependency order must not invent clock durations')
  await gantt.getByRole('button', { name: 'Seek to Step 2', exact: true }).click()
  await expect(planPage.locator('#compare-a-transaction_structure')).toBeFocused()
  assert((await gantt.getByRole('button', { name: '1. Frame the review', exact: true }).boundingBox()).height >= 44)
  assert((await gantt.locator('.timeline-transport-track-clip').first().boundingBox()).height >= 20)
  await planPage.setViewportSize({ width: 1440, height: 1000 })
  await gantt.screenshot({ path: path.join(output, 'takeover-gantt-desktop.png') })
  await planPage.screenshot({ path: path.join(output, 'shared-schema-desktop.png') })
  await planPage.setViewportSize({ width: 360, height: 780 })
  await gantt.screenshot({ path: path.join(output, 'takeover-gantt-mobile.png') })
  assert.equal(await planPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  for (const [i, step] of ['Frame the review', 'Examine the transfer', 'Record questions and next action'].entries()) {
    await gantt.getByRole('button', { name: `Edit dates for ${i + 1}. ${step}`, exact: true }).click()
    await expect(planPage.locator('#sme-review-start')).toBeFocused()
    await planPage.locator('#sme-review-start').fill(`2026-11-0${i + 1}`); await planPage.locator('#sme-review-start').press('Tab')
    await planPage.locator('#sme-review-end').fill(`2026-11-0${i + 2}`); await planPage.locator('#sme-review-end').press('Tab')
    if (i === 0) { await expect(gantt.locator('[data-timing]')).toHaveAttribute('data-timing', 'dates'); await expect(gantt.locator('.timeline-transport-track-clip')).toHaveCount(1) }
  }
  await expect(gantt.locator('[data-timing]')).toHaveAttribute('data-timing', 'dates')
  await expect(gantt).toContainText('2026-11-01')
  await expect(gantt.locator('time[datetime="2026-11-01"]').first()).toBeVisible()
  await gantt.getByRole('button', { name: '2. Examine the transfer', exact: true }).click()
  await planPage.locator('#sme-review-start').fill('2026-11-01'); await planPage.locator('#sme-review-start').press('Tab')
  await expect(gantt.locator('[data-timing]')).toHaveAttribute('data-timing', 'dates')
  assert.equal(await gantt.locator('[data-kg-video-sequence-display-lane-row]').count(), 3)
  const overlappingBoxes = await Promise.all([0,1].map(i => gantt.locator('.timeline-transport-track-clip').nth(i).boundingBox()))
  assert.notEqual(overlappingBoxes[0].y, overlappingBoxes[1].y, 'Overlapping intervals must remain on distinct visible native lanes')
  await expect(gantt).toContainText('Recorded windows overlap by 1 calendar day')
  await expect(gantt.locator('nav time[datetime="2026-11-01"]')).toHaveCount(2)
  await planPage.setViewportSize({ width: 1440, height: 1000 }); await gantt.screenshot({ path: path.join(output, 'timeline-overlap-desktop.png') })
  await planPage.setViewportSize({ width: 360, height: 780 })
  await planPage.locator('#sme-review-start').fill('2026-11-02'); await planPage.locator('#sme-review-start').press('Tab')
  await gantt.getByRole('button', { name: '3. Record questions and next action', exact: true }).click()
  await planPage.locator('#sme-review-end').fill('2026-11-03'); await planPage.locator('#sme-review-end').press('Tab')
  await expect(gantt).toContainText('Entered milestone')
  await planPage.locator('#sme-review-end').fill('2026-11-04'); await planPage.locator('#sme-review-end').press('Tab')
  const reviewDownload = planPage.waitForEvent('download'); await planPage.locator('#sme-review-export').click()
  const reviewFile = await readFile(await (await reviewDownload).path(), 'utf8'), reviewRows = JSON.parse(reviewFile)
  assert.equal(reviewRows.rows[0]['review-start'], '2026-11-01'); assert.equal(reviewRows.schema, 'sme-business-plan/view-notes/v1'); assert.doesNotMatch(reviewFile, /125,000/)
  await planPage.locator('#sme-review-import').setInputFiles({ name: 'bad-review.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(planPage.locator('#sme-review-note')).toContainText('Review import refused')
  await expect(planPage.locator('#sme-review-start')).toHaveValue('2026-11-03')
  await planPage.locator('#sme-review-start').fill(''); await planPage.locator('#sme-review-start').press('Tab')
  await expect(gantt.locator('[data-timing]')).toHaveAttribute('data-timing', 'dates')
  await expect(gantt).toContainText('2 of 3 activities placed')
  assert.equal(await gantt.locator('.timeline-transport-track-clip').count(), 2)
  await expect(gantt.locator('nav time[datetime="2026-11-02"]')).toHaveCount(2)
  await expect(gantt).toContainText('End entered; start unknown')
  await planPage.locator('#sme-review-import').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(reviewFile) })
  await expect(gantt.locator('[data-timing]')).toHaveAttribute('data-timing', 'dates')
  await expect(planPage.locator('#sme-review-start')).toHaveValue('2026-11-03')
  await expect(planPage.locator('#compare-a-buyer_budget-low')).toHaveValue('125000')
  await planPage.screenshot({ path: path.join(output, 'neutral-timeline-mobile.png') })
  await planPage.locator('#sme-review-view').selectOption('review')
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('2026-11-01')
  await planPage.locator('#sme-compare-count').selectOption('3')
  await expect(fieldRow(planPage, 'review-step-id')).toBeVisible()
  await planPage.locator('#sme-review-view').selectOption('gantt')
  await expect(gantt.locator('[data-timing]')).toHaveCount(3)
  await planPage.locator('#sme-compare-count').selectOption('1')
  await expect(gantt.locator('[data-timing]')).toHaveCount(1)
  await planPage.locator('#sme-plan-mode').selectOption('scenario'); await expect(guide).toBeHidden()
  await planPage.locator('#sme-plan-mode').selectOption('buy_build'); await expect(guide).toBeVisible()
  await planPage.locator('#sme-review-view').selectOption('plan')
  await setWorkflowOrientation(planPage, 'columns')
  const planCells = await fieldRow(planPage, 'buyer_budget').innerText()
  assert.equal(planCells.replace(/125,000/g, 'Unknown · not entered'), reviewCells)
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('review-predecessor')
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('2026-11-01')
  await fieldRow(planPage, 'review-start').click()
  await expect(planPage.locator('#sme-review-start')).toBeFocused()
  await planPage.locator('#sme-review-view').selectOption('gantt')
  await expect.poll(() => fieldRow(planPage, 'buyer_budget').innerText()).toBe(planCells)
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-dictionary"]').click()
  await expect(planPage.locator('#sme-dictionary-table-host')).toContainText('review-start')
  await expect(planPage.locator('#sme-dictionary-table-host')).toContainText('sme-business-plan/view-notes/v1')
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-workflow"]').click()
  await planPage.locator('#sme-review-view').selectOption('plan')
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
  await checkTakeoverReview(planPage, output)

  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-dictionary"]').click()
  await expect(planPage.locator('#sme-dictionary-status')).toContainText('SME takeover checker · v1.2.0')
  const takeoverDictionary = await tableTextFor(planPage, '#sme-dictionary-table-host')
  assert.match(takeoverDictionary, /sme\.takeover-checker/)
  assert.match(takeoverDictionary, /transaction_structure/)
  assert.match(takeoverDictionary, /financial_basis/)
  assert.match(takeoverDictionary, /location_obligation/)
  assert.match(takeoverDictionary, /takeover-cash\/v1/)
  for (const key of ['opportunity_label', 'buyer_budget', 'accounts_access', 'review_stage', 'next_action']) assert.match(takeoverDictionary, new RegExp(key))
  if (await navigationToggle.getAttribute('aria-expanded') === 'false') await navigationToggle.click()
  await planPage.locator('#sme-navigation a[href="#sme-workflow"]').click()
  await planPage.locator('#sme-plan-mode').selectOption('scenario')
  await expect(planPage.locator('#sme-workflow-table-host')).toContainText('Scenario A')
  await expect(planPage.locator('#compare-a-purchase_price-low')).toHaveValue('80000')
  await planPage.locator('#pack-id').selectOption('sme.business-plan')
  await expect(planPage.locator('#service-status')).toContainText('General business plan · v2.3.0')
  await expect(guide).toBeHidden()
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
  await checkTakeoverOffline(browser, url, output)

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
  if (await region.getAttribute('data-orientation') !== orientation) await page.locator('#sme-workflow-pivot').click()
  await expect.poll(() => region.getAttribute('data-orientation')).toBe(orientation)
  await expect.poll(async () => (await workflowHeaders(page)).includes('Record type')).toBe(orientation === 'columns')
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

async function checkTakeoverReview(page, output) {
  const host = page.locator('#sme-workflow-table-host')
  const texts = { opportunity_label: 'Option A', business_activity: 'Repairs', operating_area: 'Remote', transfer_reason: 'User-stated transition',
    support_scope: 'Support agreed by the user', next_action: 'Clarify accounts for option A' }
  for (const [key, value] of Object.entries(texts)) await page.locator('#compare-a-' + key).fill(value)
  await page.locator('#compare-a-buyer_budget-low').fill('130000')
  await page.locator('#compare-a-target_handover_months').fill('2')
  for (const [key, value] of Object.entries({ operator_experience: 'related_reported', accounts_access: 'requested',
    permission_transfer_status: 'conditional', team_continuity: 'not_discussed', review_stage: 'handover_planning' }))
    await page.locator('#compare-a-' + key).selectOption(value)
  await expect(page.locator('#workflow-status')).toContainText('Inputs changed')
  await expect(host).not.toContainText('USD 117,000')
  await page.locator('#sme-compare-run').click()
  await expect(host).toContainText('USD 117,000')
  await expect(host).toContainText('Basis: current estimate · Period: 6 months')
  assert.equal((await workflowHeaders(page)).length, 61)
  assert.equal(new Set(await workflowHeaders(page)).size, 61)
  await page.locator('#sme-plan-mode').selectOption('scenario')
  const download = page.waitForEvent('download'); await page.locator('[data-export="json"]').click()
  const first = JSON.parse(await readFile(await (await download).path(), 'utf8'))
  assert.equal(Object.keys(first.inputs).length, 38)
  const sheets = [first, { ...first, inputs: { ...first.inputs, opportunity_label: 'Option B', next_action: 'Clarify option B', financial_basis: 'historical_records' } }]
  const upload = async (value, name = 'review.json') => page.locator('#sme-worksheet-import').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
  await upload({ ...first, inputs: { ...first.inputs, support_scope: '   ' } })
  await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
  await expect(page.locator('#compare-a-support_scope')).toHaveValue('')
  const blankDownload = page.waitForEvent('download'); await page.locator('[data-export="json"]').click()
  const normalized = JSON.parse(await readFile(await (await blankDownload).path(), 'utf8'))
  assert.equal(Object.hasOwn(normalized.inputs, 'support_scope'), false)
  await upload(sheets); await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
  await expect(page.locator('#sme-compare-count')).toHaveValue('2')
  await page.locator('#sme-compare-run').click()
  await expect(host).toContainText('not comparable on the supplied basis')
  await expect(host).toContainText('USD 117,000')
  await setWorkflowOrientation(page, 'columns')
  const expanded = await host.locator('tbody tr').count()
  await host.getByRole('button', { name: 'Collapse all nested rows', exact: true }).click()
  await expect.poll(() => host.locator('tbody tr').count()).toBeLessThan(expanded)
  await host.getByRole('button', { name: 'Expand all nested rows', exact: true }).click()
  await expect(host.locator('tbody tr')).toHaveCount(expanded)
  await host.getByRole('button', { name: 'Collapse nested group: Hierarchy group', exact: true }).first().click()
  await expect.poll(() => host.locator('tbody tr').count()).toBeLessThan(expanded)
  await host.getByRole('button', { name: 'Expand nested group: Hierarchy group', exact: true }).first().click()
  await setWorkflowOrientation(page, 'rows')
  await host.getByRole('row', { name: 'Data row: Scenario B', exact: true }).press('Enter')
  await expect(page.locator('#compare-b-next_action')).toHaveValue('Clarify option B')
  await host.getByRole('row', { name: 'Data row: Scenario A', exact: true }).click()
  for (const format of ['json', 'csv', 'markdown']) {
    const ready = page.waitForEvent('download'); await page.locator(`[data-export="${format}"]`).click()
    const file = await ready, content = await readFile(await file.path(), 'utf8')
    assert(content.includes('Option A') && content.includes('Option B'))
    if (format === 'json') assert.equal(JSON.parse(content).length, 2)
    if (format === 'csv') assert(content.includes('"pack_version","""1.2.0"""'))
    await page.locator('#compare-a-next_action').fill('New unsaved input')
    await page.locator('#sme-worksheet-import').setInputFiles({ name: file.suggestedFilename(), mimeType: 'text/plain', buffer: Buffer.from(content) })
    await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
    await expect(page.locator('#compare-a-next_action')).toHaveValue(texts.next_action)
    await expect(page.locator('#sme-compare-count')).toHaveValue('2')
  }
  for (const invalid of [{ ...sheets[1], pack_version: '1.1.0' }, { ...sheets[1], inputs: { ...sheets[1].inputs, next_action: 'person@example.test' } },
    { ...sheets[1], evidence: [{ field_key: 'support_scope', value: '   ', provenance: 'self_reported', observer_role: 'author', date: '2026-11-06' }] }]) {
    await upload([first, invalid]); await expect(page.locator('#workflow-status')).toContainText('Current inputs are kept')
    await expect(page.locator('#compare-a-next_action')).toHaveValue(texts.next_action)
    await expect(page.locator('#sme-compare-count')).toHaveValue('2')
  }
  await page.evaluate(() => { window.print = () => {} })
  await page.locator('#sme-print').click()
  await expect(page.locator('.sme-print-sheet')).toContainText('Option A')
  await expect(page.locator('.sme-print-sheet')).toContainText('Option B')
  await expect(page.locator('.sme-print-sheet')).toContainText('not comparable on the supplied basis')
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await expect(page.locator('.sme-print-sheet')).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator('#sme-compare-run').click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('#sme-workflow').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'sme-review-desktop.png') })
  await page.setViewportSize({ width: 360, height: 780 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await host.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'sme-review-mobile.png') })
  await page.evaluate(() => {
    window.worksheetReads = []; window.originalWorksheetText = File.prototype.text
    File.prototype.text = function () { const file = this; return new Promise(resolve => window.worksheetReads.push(async () => resolve(await window.originalWorksheetText.call(file)))) }
  })
  for (const next_action of ['Older selection', 'Newest selection']) await upload([{ ...first, inputs: { ...first.inputs, next_action } }])
  await expect.poll(() => page.evaluate(() => window.worksheetReads.length)).toBe(2)
  await page.evaluate(() => window.worksheetReads[0]())
  await expect.poll(() => page.locator('#sme-worksheet-import').evaluate(input => input.files.length)).toBe(0)
  await expect(page.locator('#compare-a-next_action')).toHaveValue(texts.next_action)
  await page.evaluate(() => { File.prototype.text = window.originalWorksheetText; window.worksheetReads[1]() })
  await expect(page.locator('#compare-a-next_action')).toHaveValue('Newest selection')
  await upload(sheets); await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
  // A delayed file read cannot undo a mode edit or repopulate a route that was left.
  for (const change of ['mode', 'contract', 'route']) {
    await page.evaluate(() => {
      window.originalWorksheetText = File.prototype.text
      File.prototype.text = function () { const file = this; return new Promise(resolve => { window.resumeWorksheet = async () => resolve(await window.originalWorksheetText.call(file)) }) }
    })
    await upload(sheets)
    await expect.poll(() => page.evaluate(() => typeof window.resumeWorksheet)).toBe('function')
    if (change === 'route') await page.locator('#workspace-role-switcher').selectOption('admin')
    else if (change === 'contract') await page.locator('#pack-id').selectOption('sme.business-plan')
    else await page.locator('#sme-plan-mode').selectOption('buy_build')
    await page.evaluate(() => { File.prototype.text = window.originalWorksheetText; window.resumeWorksheet(); delete window.resumeWorksheet })
    await expect.poll(() => page.locator('#sme-worksheet-import').evaluate(input => input.files.length)).toBe(0)
    if (change === 'route') {
      await page.locator('#workspace-role-switcher').selectOption('sme')
      await expect(host).not.toContainText(texts.next_action)
    } else if (change === 'contract') {
      await expect(page.locator('#pack-id')).toHaveValue('sme.business-plan')
      await expect(page.locator('#compare-a-next_action')).toHaveCount(0)
      await page.locator('#pack-id').selectOption('sme.takeover-checker')
      await expect(page.locator('#service-status')).toContainText('v1.2.0')
    } else await expect(page.locator('#sme-plan-mode')).toHaveValue('buy_build')
  }
  await page.locator('#sample').click(); await page.locator('#sme-compare-run').click()
}

async function checkTakeoverOffline(browser, url, output) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true })
  // Deterministic WebMCP contract fixture; this does not claim native browser availability.
  await context.addInitScript(() => {
    window.smeTools = new Map()
    Object.defineProperty(document, 'modelContext', { value: {
      registerTool(tool, { signal }) { window.smeTools.set(tool.name, tool); signal.addEventListener('abort', () => window.smeTools.delete(tool.name)) },
      unregisterTool(name) { window.smeTools.delete(name) },
    } })
  })
  const page = await context.newPage(), services = []
  page.on('request', request => { if (request.url().includes('/services/sme-business-pack')) services.push(request.url()) })
  await page.goto(url + '#shop')
  await page.getByText('Offline access is ready.', { exact: false }).waitFor()
  await context.setOffline(true)
  await page.locator('#workspace-role-switcher').selectOption('sme')
  await expect(page.locator('#service-status')).toContainText('General business plan')
  await expect(page.locator('#sme-workflow-table-host').getByRole('table')).toBeVisible()
  await context.setOffline(false)
  await page.locator('#pack-id').selectOption('sme.takeover-checker')
  await expect(page.locator('#service-status')).toContainText('v1.2.0')
  await expect(page.locator('#webmcp-status')).toContainText('4 optional pack tools registered')
  const protocol = await page.evaluate(async () => JSON.parse((await window.smeTools.get('pack.protocol').execute({ pack_id: 'sme.takeover-checker' }, {})).content[0].text))
  assert.equal(protocol.input_fields.length, 38)
  assert.deepEqual(await page.evaluate(() => [...window.smeTools.keys()]), ['pack.list', 'pack.protocol', 'business.plan.build', 'business.plan.compare'])
  await page.locator('#sme-review-view').selectOption('gantt')
  await expect(page.locator('#sme-review-timeline').getByRole('button', { name: 'Select 1. Frame the review', exact: true })).toBeVisible()
  await context.setOffline(true)
  const worksheet = { schema: 'sme-business-plan/worksheet/v2', pack_id: protocol.pack.id, pack_version: protocol.pack.version,
    mode: 'scenario', currency_code: 'USD', inputs: { ...protocol.illustrative_inputs, opportunity_label: 'Private offline option', next_action: 'Check the entered records' }, evidence: [] }
  const rows = [worksheet, { ...worksheet, inputs: { ...worksheet.inputs, financial_basis: 'unknown' } },
    { ...worksheet, inputs: { ...worksheet.inputs, financial_period_months: 3 } }]
  const upload = value => page.locator('#sme-worksheet-import').setInputFiles({ name: 'offline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
  await upload(rows); await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
  await page.locator('#sme-compare-run').tap()
  await expect(page.locator('#workflow-status')).toContainText('Local scenario comparison')
  await expect(page.locator('#sme-workflow-table-host')).toContainText('not comparable on the supplied basis')
  const comparison = await page.evaluate(async rows => JSON.parse((await window.smeTools.get('business.plan.compare').execute({ mode: 'scenario',
    plan_sets: rows.map(({ pack_id, pack_version, inputs, evidence }) => ({ pack_id, pack_version, inputs, evidence })) }, {})).content[0].text), rows)
  assert.deepEqual(comparison.slots.map(slot => slot.slot), ['A', 'B', 'C'])
  assert(comparison.slots.every(slot => slot.report.model.cash_to_close.low === 117000))
  assert.equal((await workflowHeaders(page)).length, 61)
  const evidence = Array.from({ length: 40 }, () => ({ field_key: 'support_scope', value: 'Context', provenance: 'self_reported', observer_role: 'author', date: '2026-11-06' }))
  await upload({ ...worksheet, evidence }); await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
  await page.locator('#sme-compare-run').tap(); await expect(page.locator('#workflow-status')).toContainText('Local scenario plan built')
  await upload(rows.map(row => ({ ...row, evidence: evidence.map(entry => ({ ...entry, value: '界'.repeat(280) })) })))
  await expect(page.locator('#workflow-status')).toContainText('Current inputs are kept')
  await expect(page.locator('#compare-a-next_action')).toHaveValue(worksheet.inputs.next_action)
  await expect(page.locator('#sme-compare-count')).toHaveValue('1')
  await upload({ ...worksheet, evidence: evidence.map(entry => ({ ...entry, value: 'Context '.repeat(12) })) })
  await expect(page.locator('#workflow-status')).toContainText('Table limit reached')
  await expect(page.locator('#compare-a-next_action')).toHaveValue(worksheet.inputs.next_action)
  const download = page.waitForEvent('download'); await page.locator('[data-export="json"]').tap()
  const content = await readFile(await (await download).path(), 'utf8')
  assert.equal(JSON.parse(content).evidence.length, 40)
  assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes('Private offline option')), false)
  await page.reload()
  await expect(page.locator('#sme')).toBeVisible()
  await page.locator('#pack-id').selectOption('sme.takeover-checker')
  await expect(page.locator('#service-status')).toContainText('v1.2.0')
  await page.locator('#sme-review-view').selectOption('gantt')
  await expect(page.locator('#sme-review-timeline')).toContainText('Dependency order; dates are optional')
  await page.locator('#sme-review-view').selectOption('plan')
  await page.locator('#sme-workflow-table-host').getByRole('row', { name: 'Data row: Plan option A', exact: true }).tap()
  await expect(page.locator('#compare-a-opportunity_label')).toHaveValue('')
  await upload(worksheet); await expect(page.locator('#workflow-status')).toContainText('Worksheet imported')
  await page.locator('#sme-compare-run').tap(); await expect(page.locator('#sme-workflow-table-host')).toContainText('USD 117,000')
  await page.locator('#sme-workflow-pivot').tap()
  await expect.poll(async () => (await workflowHeaders(page)).includes('Record type')).toBe(true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('#sme-workflow-table-host').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'sme-review-offline-mobile.png') })
  assert.equal(services.length, 0)
  await writeFile(path.join(output, 'sme-review-offline.json'), JSON.stringify({ source: await page.locator('meta[name="commerce-source"]').getAttribute('content'),
    contract: protocol.pack, threeRows: true, maximumEvidence: 40, limitsPreserveInputs: true, touch: true, cachedReload: true,
    webMcp: 'contract fixture; native availability not claimed', smeServiceRequests: services.length }, null, 2))
  await context.close()
}

function fieldRow(page, key) { return page.locator('#sme-workflow-table-host').getByRole('row').filter({ has: page.getByText(key, { exact: true }) }) }
