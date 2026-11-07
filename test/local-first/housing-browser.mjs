import { chooseDropdown } from './dropdown-menu-browser.mjs';
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect } from '@playwright/test'
import { BROWSER_CHECKS } from '../../scripts/local-first-release/browser-proof.mjs'

const housingSavedKey = 'commerce.housing.saved-ids/v1'
const pngCrc = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngPixel(red, green, blue) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), body = Buffer.concat([name, data]), length = Buffer.alloc(4), crc = Buffer.alloc(4)
    length.writeUInt32BE(data.length); crc.writeUInt32BE(pngCrc(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4)
  header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const stateIds = async page => page.locator('[name="listing"]:checked').evaluateAll(nodes => nodes.map(node => node.value))
const listingCard = (page, label) => page.locator('[data-listing-item]').filter({ hasText: label })
async function addManualListing(page, { label, rent, photos = [] }) {
  await page.getByText('Add a listing manually', { exact: true }).click()
  const form = page.locator('[data-form="listing"]')
  await form.getByLabel('Local label').fill(label)
  await form.getByLabel('Monthly rent').fill(String(rent))
  if (photos.length) await form.locator('[name="photos"]').setInputFiles(photos.map((buffer, index) => ({
    name: `${label.toLowerCase().replaceAll(' ', '-')}-${index + 1}.png`, mimeType: 'image/png', buffer,
  })))
  await form.getByRole('button', { name: 'Add this listing' }).click()
  await expect(page.locator('.housing-status').last()).toContainText('Listing added')
  const card = listingCard(page, label)
  await expect(card).toBeVisible()
  return card.getAttribute('data-id')
}
async function comparisonTable(page, ready = table => table !== null) {
  let snapshot
  await expect.poll(async () => {
    snapshot = await page.locator('[data-housing-table-host]').evaluate(host => {
      const table = host.shadowRoot?.querySelector('table')
      if (!table) return null
      const rows = [...table.rows].map(row => [...row.cells].map(cell => cell.innerText.trim().replaceAll('\u00a0', ' ')))
      return { rows, headers: rows[0], width: table.scrollWidth,
        multiDimensional: !!host.shadowRoot.querySelector('.base-multi-dimensional-table') }
    })
    return ready(snapshot)
  }, { timeout: 5000 }).toBe(true)
  return snapshot
}
const valueAt = (table, rowName, columnName) => {
  const column = table.headers.indexOf(columnName), row = table.rows.find(cells => cells[0] === rowName)
  return column < 0 || !row ? '' : row[column]
}

export async function checkHousingWorkspace({ browser, url, output, observeContext, record }) {
  const origin = new URL(url).origin, context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true,
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  observeContext(context)
  const page = await context.newPage(), requests = [], pageErrors = [], assertionIds = []
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }))
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(url + '#shop')
  await expect(page.locator('#housing-root')).toBeEmpty()
  const tableBeforeHousing = await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => entry.name.includes('agentic-base-data-view.js')))
  assert.equal(tableBeforeHousing, false, 'shared table adapter must stay unloaded outside Housing')
  await chooseDropdown(page.locator('#workspace-role-switcher'), 'housing')
  await expect(page).toHaveURL(/#housing$/u)
  await expect(page.locator('#housing-root h1')).toHaveText('Multi-dimensional Table')
  await page.evaluate(() => {
    window.__housingShellIdentity = ['#workspace-shell', '[data-workspace-header].topbar', '#workspace-footer']
      .map(selector => document.querySelector(selector))
  })
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()
  await expect(page.locator('[data-housing-workflow]')).toBeAttached()
  assert.equal(await page.locator('#housing-root h1').count(), 1, 'Housing is one consolidated workspace route')
  assert.equal(await page.locator('[data-housing-workflow]').count(), 1, 'Housing has one workflow input section')
  const initialTable = await comparisonTable(page)
  assert(initialTable?.multiDimensional, 'Housing must mount the shared Base Multi-dimensional Table')
  assert.deepEqual(initialTable.headers.slice(1), [
    'Cedar Study Lofts · sample', 'Harborline Rooms · sample', 'Garden Court Studios · sample',
  ])
  assert.equal(initialTable.rows.length - 1, 19, 'all shared facts appear as rows in the listing-columns pivot')
  assertionIds.push('HU-V01', 'HU-V02')

  const pivot = page.locator('[data-housing-table-host] .base-multi-dimensional-table-pivot')
  await expect(pivot).toBeVisible()
  await expect(pivot).toContainText('Pivot: columns as records')
  await pivot.click()
  await expect(page.locator('[data-housing-table-host] .base-multi-dimensional-table-pivot')).toContainText('Pivot: rows as records')
  let pivotedTable = await comparisonTable(page)
  assert(pivotedTable.headers.includes('Listing'), 'row pivot exposes listing facts as columns')
  assert.equal(pivotedTable.rows.length - 1, 3, 'row pivot places each selected listing in one record row')
  const cedarRow = pivotedTable.rows.find(row => row.includes('Cedar Study Lofts · sample'))
  assert(cedarRow, 'the row pivot preserves the first selected listing')
  assert.match(cedarRow[pivotedTable.headers.indexOf('Advertised rent')], /SGD 1,450/u)
  await page.locator('[data-housing-table-host] .base-multi-dimensional-table-pivot').click()
  await expect(page.locator('[data-housing-table-host] .base-multi-dimensional-table-pivot')).toContainText('Pivot: columns as records')
  assertionIds.push('HU-V03')

  const adapterAfterHousing = await page.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => entry.name.includes('agentic-base-data-view.js')))
  assert.equal(adapterAfterHousing, true, 'shared table adapter loads when the Housing workflow opens')
  await page.locator('[data-housing-workflow] > summary').click()
  const cedar = listingCard(page, 'Cedar Study Lofts')
  await cedar.getByRole('button', { name: /Save listing:/u }).click()
  await page.getByLabel('Saved only').check()
  await expect(page.getByText('Showing 1 of 3 local listings.')).toBeVisible()
  await expect(page.locator('[name="listing"]:checked')).toHaveCount(3)
  assert.deepEqual((await comparisonTable(page)).headers.slice(1), initialTable.headers.slice(1), 'filters do not remove selected table columns')
  await page.getByLabel('Find an option').fill('Harborline')
  await expect(page.getByText('Showing 0 of 3 local listings.')).toBeVisible()
  await page.getByLabel('Saved only').uncheck()
  await page.getByLabel('Find an option').fill('')
  await expect(page.locator('[data-form="profile"]')).toBeVisible()
  const profileInputNames = await page.locator('[data-form="profile"] input').evaluateAll(nodes => nodes.map(node => node.name))
  assert(profileInputNames.every(name => !['name', 'email', 'passport', 'birthDate', 'document'].includes(name)))
  await page.getByLabel('Arrival date').fill('2027-01-05')
  await page.getByLabel('Departure date').fill('2027-05-31')
  await page.getByLabel('Monthly budget').fill('1650')
  await page.getByRole('button', { name: 'Apply context' }).click()
  await expect(page.locator('[data-form="profile"] [name="budget"]')).toHaveValue('1650')
  await page.getByRole('button', { name: 'Use sample profile' }).click()
  await expect(page.locator('[data-form="profile"]')).toBeVisible()
  await expect(page.locator('[data-form="profile"] [name="budget"]')).toHaveValue('1900')
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()
  let sampleTable = await comparisonTable(page)
  assert.equal(sampleTable.multiDimensional, true)
  assert.match(valueAt(sampleTable, 'Known monthly subtotal', 'Cedar Study Lofts · sample'), /SGD 1,630/u)
  assert.match(valueAt(sampleTable, 'Known monthly subtotal', 'Harborline Rooms · sample'), /recurring charges unknown/u)
  assert.match(valueAt(sampleTable, 'Known monthly subtotal', 'Garden Court Studios · sample'), /SGD 1,840/u)
  assert.match(valueAt(sampleTable, 'Known move-in cash', 'Garden Court Studios · sample'), /SGD 3,520/u)
  assert.match(valueAt(sampleTable, 'Rent after planned stay', 'Garden Court Studios · sample'), /3 extra month/u)
  assert.match(valueAt(sampleTable, 'Headline status', 'Garden Court Studios · sample'), /Pause and verify/u)
  const persistent = await page.evaluate(key => ({ keys: Object.keys(localStorage), ids: JSON.parse(localStorage.getItem(key) || '[]') }), housingSavedKey)
  assert.deepEqual(persistent.keys, [housingSavedKey], 'only saved listing IDs persist')
  assert(persistent.ids.includes('cedar-study-lofts'))
  assertionIds.push('HU-V04', 'HU-V05', 'HU-V06', 'HU-V13', 'HU-V14')

  const fourthId = await addManualListing(page, { label: 'Fourth test option', rent: 900 })
  const fourth = page.locator(`[data-listing-item][data-id="${fourthId}"]`)
  await fourth.locator('[name="listing"]').click()
  await expect(fourth.locator('[name="listing"]')).not.toBeChecked()
  await expect(page.locator('[data-housing-global-status]')).toContainText('Compare up to three listings at a time.')
  await expect(page.locator('[name="listing"]:checked')).toHaveCount(3)
  await fourth.locator('[data-action="remove-listing"]').click()
  await expect(page.locator('[data-listing-item]')).toHaveCount(3)

  const reportRequestsBeforePlan = requests.length
  const harborline = page.locator('.housing-option-action').filter({ hasText: 'Harborline Rooms' })
  await harborline.getByRole('button', { name: 'Open plan' }).click()
  const plan = page.getByRole('dialog', { name: /Harborline Rooms/u })
  await expect(plan).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Questions to ask' })).toBeVisible()
  const draft = plan.getByLabel('Editable message draft')
  await draft.fill('Please confirm the written lease dates and all recurring charges.')
  await plan.getByRole('button', { name: 'Copy message' }).click()
  await expect(plan.locator('[data-plan-status]')).toContainText('Message copied after your request.')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Please confirm the written lease dates and all recurring charges.')
  await plan.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(100)
  assert.equal(requests.length, reportRequestsBeforePlan)
  assertionIds.push('HU-V09')
  await page.getByText('Import or export comparison data', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export JSON' }).click()
  const download = await downloadPromise, exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'))
  assert.deepEqual(Object.keys(exported).sort(), ['listings', 'schema'])
  assert.equal(exported.schema, 'commerce.housing-comparison/v1')
  assert.deepEqual(exported.listings.map(listing => listing.id), ['cedar-study-lofts', 'harborline-rooms', 'garden-court-studios'])
  assert(!JSON.stringify(exported).includes('North Campus'))
  assert(!JSON.stringify(exported).includes('profile'))
  const invalid = { ...exported, contact: 'must be rejected' }
  await page.locator('[data-action="import"]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) })
  await expect(page.locator('[data-housing-global-status]')).toContainText('not a supported Housing comparison')
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()
  assert.deepEqual((await comparisonTable(page)).headers.slice(1), [
    'Cedar Study Lofts · sample', 'Harborline Rooms · sample', 'Garden Court Studios · sample',
  ])
  await page.locator('[data-action="import"]').setInputFiles({ name: 'housing-comparison.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) })
  await expect(page).toHaveURL(/#housing$/u)
  await expect(page.getByText('Imported 3 listings. Enter stay details to compare.')).toBeVisible()
  const importedGarden = listingCard(page, 'Garden Court Studios')
  const importedGardenId = await importedGarden.getAttribute('data-id')
  await importedGarden.getByRole('button', { name: /Save listing:/u }).click()
  await listingCard(page, 'Garden Court Studios').getByRole('button', { name: 'Edit facts' }).click()
  await page.getByLabel('Monthly rent').fill('1760')
  await page.getByRole('button', { name: 'Update listing facts' }).click()
  await expect(page.locator('.housing-status').last()).toHaveText('Listing facts updated. Existing local photos remain attached.')
  const editedGarden = page.locator(`[data-listing-item][data-id="${importedGardenId}"]`)
  await expect(editedGarden.locator('[name="listing"]')).toBeChecked()
  await expect(editedGarden.locator('.housing-save')).toHaveAttribute('aria-pressed', 'true')
  await expect(editedGarden).toContainText('Garden Court Studios')
  await editedGarden.locator('[data-action="remove-listing"]').click()
  await expect(page.locator(`[data-listing-item][data-id="${importedGardenId}"]`)).toHaveCount(0)
  const savedAfterRemove = await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), housingSavedKey)
  assert(!savedAfterRemove.includes(importedGardenId))
  assert(savedAfterRemove.includes('cedar-study-lofts'))
  assertionIds.push('HU-V10', 'HU-V15')

  const red = pngPixel(230, 20, 30), green = pngPixel(30, 230, 20), blue = pngPixel(20, 30, 230)
  for (const id of ['cedar-study-lofts', 'harborline-rooms']) await page.locator(`[name="listing"][value="${id}"]`).uncheck()
  const redId = await addManualListing(page, { label: 'Crimson Room', rent: 800, photos: [red, green] })
  const blueId = await addManualListing(page, { label: 'Azure Room', rent: 850, photos: [blue] })
  const secondRedId = await addManualListing(page, { label: 'Scarlet Room', rent: 900, photos: [red] })
  await expect(page.locator('.housing-status').last()).toContainText('exact image file is also selected for another option')
  assert.deepEqual(await stateIds(page), [redId, blueId, secondRedId])
  for (const id of [redId, blueId, secondRedId]) {
    await page.locator(`[data-listing-item][data-id="${id}"] .housing-save`).click()
    await expect(page.locator(`[data-listing-item][data-id="${id}"] .housing-save`)).toHaveAttribute('aria-pressed', 'true')
  }
  sampleTable = await comparisonTable(page, table => table?.headers.slice(1).join('\0')
    === ['Crimson Room', 'Azure Room', 'Scarlet Room'].join('\0'))
  assert.deepEqual(sampleTable.headers.slice(1), ['Crimson Room', 'Azure Room', 'Scarlet Room'])
  assert.match(valueAt(sampleTable, 'Selected local images', 'Crimson Room'), /exact file also selected/u)
  assert.doesNotMatch(valueAt(sampleTable, 'Selected local images', 'Azure Room'), /exact file also selected/u)
  assert.match(valueAt(sampleTable, 'Selected local images', 'Scarlet Room'), /exact file also selected/u)
  const redAction = page.locator('.housing-option-action').filter({ hasText: 'Crimson Room' })
  const galleryTrigger = redAction.getByRole('button', { name: 'View 2 local photos' })
  await galleryTrigger.click()
  const gallery = page.getByRole('dialog', { name: 'Photos for Crimson Room' })
  await expect(gallery).toBeVisible()
  await expect(gallery.getByRole('img')).toHaveAttribute('aria-label', 'Photo 1 of 2 for Crimson Room')
  await gallery.getByRole('button', { name: 'Next' }).click()
  await expect(gallery.getByRole('img')).toHaveAttribute('aria-label', 'Photo 2 of 2 for Crimson Room')
  await gallery.getByRole('button', { name: 'Previous' }).click()
  await expect(gallery.getByRole('img')).toHaveAttribute('aria-label', 'Photo 1 of 2 for Crimson Room')
  await page.keyboard.press('Escape')
  await expect(gallery).not.toBeVisible()
  await expect(galleryTrigger).toBeFocused()
  assertionIds.push('HU-V07', 'HU-V12')

  const redCard = page.locator(`[data-listing-item][data-id="${redId}"]`)
  await redCard.getByRole('button', { name: 'Edit facts' }).click()
  await page.getByLabel('Monthly rent').fill('875')
  await page.getByRole('button', { name: 'Update listing facts' }).click()
  await expect(page.locator('.housing-status').last()).toContainText('Existing local photos remain attached.')
  sampleTable = await comparisonTable(page, table => Boolean(table && valueAt(table, 'Selected local images', 'Crimson Room')
    .includes('2 selected · exact file also selected')))
  assert.match(valueAt(sampleTable, 'Selected local images', 'Crimson Room'), /2 selected · exact file also selected/u)
  const editedRed = page.locator(`[data-listing-item][data-id="${redId}"]`)
  await editedRed.locator('[data-action="remove-listing"]').click()
  await expect(page.locator(`[data-listing-item][data-id="${redId}"]`)).toHaveCount(0)
  await expect(page.locator('[name="listing"]:checked')).toHaveCount(2)
  const afterManualRemove = await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), housingSavedKey)
  assert(!afterManualRemove.includes(redId))
  assert(afterManualRemove.includes(blueId) && afterManualRemove.includes(secondRedId))
  assertionIds.push('HU-V15')

  await chooseDropdown(page.locator('#workspace-role-switcher'), 'shop')
  await expect(page).toHaveURL(/#shop$/u)
  await expect(page.locator('#housing-root')).toBeEmpty()
  await chooseDropdown(page.locator('#workspace-role-switcher'), 'housing')
  await expect(page).toHaveURL(/#housing$/u)
  await expect(page.locator('#housing-root h1')).toHaveText('Multi-dimensional Table')
  assert.equal(await page.evaluate(() => window.__housingShellIdentity.every((node, index) => node === [
    document.querySelector('#workspace-shell'), document.querySelector('[data-workspace-header].topbar'), document.querySelector('#workspace-footer'),
  ][index])), true)
  await expect(page.locator('[data-listing-item]')).toHaveCount(3)
  const cleanProfile = await page.evaluate(key => ({
    keys: Object.keys(localStorage), saved: JSON.parse(localStorage.getItem(key) || '[]'),
  }), housingSavedKey)
  assert(cleanProfile.keys.every(key => key === housingSavedKey))
  assert(cleanProfile.saved.includes('cedar-study-lofts'))
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()

  await page.locator('[data-housing-workflow] > summary').click()
  await page.getByRole('button', { name: 'Use sample profile' }).click()
  await expect(page.locator('[data-form="profile"] [name="budget"]')).toHaveValue('1900')
  await page.locator('[name="listing"][value="cedar-study-lofts"]').uncheck()
  await page.locator('[name="listing"][value="harborline-rooms"]').uncheck()
  await expect(page.locator('[name="listing"]:checked')).toHaveCount(1)
  const afterExit = await page.evaluate(key => ({ saved: JSON.parse(localStorage.getItem(key) || '[]'), keys: Object.keys(localStorage) }), housingSavedKey)
  assert(afterExit.saved.includes('cedar-study-lofts'))
  assert(afterExit.keys.every(key => key === housingSavedKey))

  for (const id of ['cedar-study-lofts', 'harborline-rooms', 'garden-court-studios']) {
    const checkbox = page.locator(`[name="listing"][value="${id}"]`)
    if (!(await checkbox.isChecked())) await checkbox.check()
  }
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()
  await page.locator('[data-housing-table-host] .base-multi-dimensional-table-pivot').click()
  await expect(page.locator('[data-housing-table-host] .base-multi-dimensional-table-pivot')).toContainText('Pivot: rows as records')
  const responsive = []
  for (const width of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    const metrics = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }))
    assert.equal(metrics.documentWidth, metrics.width, `page overflow at ${width}px`)
    responsive.push(metrics)
  }
  assertionIds.push('HU-V12')
  await page.setViewportSize({ width: 390, height: 844 })
  const scrollRegion = page.getByRole('region', { name: 'Listing comparison; listings are rows and shared facts are columns.' })
  const dimensionSearch = page.getByRole('searchbox', { name: 'Search table dimensions' })
  const workflowSummary = page.locator('[data-housing-workflow] > summary')
  await page.locator('[data-housing-workflow] > summary').click()
  await page.locator('#housing-root h1').focus()
  await page.keyboard.press('Tab')
  await expect(workflowSummary).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dimensionSearch).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(scrollRegion).toBeFocused()
  const focusOutline = await scrollRegion.evaluate(element => {
    const style = getComputedStyle(element)
    return element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
  })
  assert.equal(focusOutline, true, 'keyboard focus on the table region must remain visible')
  const beforeScroll = await scrollRegion.evaluate(element => {
    const scroller = element.querySelector('[data-housing-table-host]')?.shadowRoot?.querySelector('.agentic-base-data-view')
    return { scrollLeft: scroller?.scrollLeft, clientWidth: scroller?.clientWidth, scrollWidth: scroller?.scrollWidth,
      outerScrollLeft: element.scrollLeft, outerOverflow: getComputedStyle(element).overflow,
      frameOverflow: scroller && getComputedStyle(scroller).overflow, focused: document.activeElement === element }
  })
  assert(beforeScroll.scrollWidth > beforeScroll.clientWidth, `mobile table must overflow its region: ${JSON.stringify(beforeScroll)}`)
  await scrollRegion.press('ArrowRight')
  const scrollMetrics = await page.evaluate(() => {
    const region = document.querySelector('.housing-comparison-table-scroll')
    const scroller = region?.querySelector('[data-housing-table-host]')?.shadowRoot?.querySelector('.agentic-base-data-view')
    return { scrollLeft: scroller?.scrollLeft, clientWidth: scroller?.clientWidth, scrollWidth: scroller?.scrollWidth,
      outerScrollLeft: region?.scrollLeft, outerOverflow: region && getComputedStyle(region).overflow,
      frameOverflow: scroller && getComputedStyle(scroller).overflow, documentWidth: document.documentElement.scrollWidth }
  })
  assert(scrollMetrics.scrollLeft > beforeScroll.scrollLeft,
    `ArrowRight must move the focused comparison region (before ${JSON.stringify(beforeScroll)}, after ${JSON.stringify(scrollMetrics)})`)
  assert.equal(scrollMetrics.outerScrollLeft, 0, 'Housing wrapper must not duplicate Base scrolling')
  assert(!['auto', 'scroll'].includes(scrollMetrics.outerOverflow), 'Housing wrapper must not become a competing scroll owner')
  assert.equal(scrollMetrics.frameOverflow, 'auto')
  assert(scrollMetrics.scrollWidth > scrollMetrics.clientWidth)
  assert.equal(scrollMetrics.documentWidth, 390)
  await page.screenshot({ path: path.join(output, 'housing-comparison-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: path.join(output, 'housing-comparison-wide.png'), fullPage: true })
  assertionIds.push('HU-V08', 'HU-V12')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('link', { name: 'Airvio Commerce home' }).click()
  await expect(page).toHaveURL(/#shop$/u)
  await chooseDropdown(page.locator('#workspace-role-switcher'), 'housing')
  await expect(page).toHaveURL(/#housing$/u)
  await page.evaluate(async () => { await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await page.waitForFunction(async () => {
    const module = performance.getEntriesByType('resource').find(entry => /\/housing-comparison\.js(?:\?|$)/u.test(entry.name))
    if (!module) return false
    const base = new URL(module.name).pathname.replace(/housing-comparison\.js$/u, '')
    const targets = ['housing-comparison.js', 'housing-engine.js', 'housing-sample.js', 'housing-comparison.css']
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      const entries = await Promise.all(targets.map(file => cache.match(new URL(base + file, location.origin))))
      if (entries.every(Boolean)) return true
    }
    return false
  })
  await expect(page.locator('#offline-ready')).toHaveText('Housing comparison is ready for offline use.')
  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('#housing-root h1')).toHaveText('Multi-dimensional Table')
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()
  const networkBlocked = await page.evaluate(async () => {
    try { const response = await fetch(new URL(`assets/local-unreleased/offline-probe-${Date.now()}`, location.href), { cache: 'no-store' }); return !response.ok }
    catch { return true }
  })
  assert.equal(networkBlocked, true, 'offline mode must block uncached network requests')
  await page.locator('[data-housing-workflow] > summary').click()
  await page.getByLabel('Saved only').check()
  await expect(listingCard(page, 'Cedar Study Lofts')).toBeVisible()
  await expect(listingCard(page, 'Garden Court Studios')).toBeHidden()
  await page.getByLabel('Saved only').uncheck()
  await page.getByRole('button', { name: 'Use sample profile' }).click()
  await expect(page.locator('[data-housing-table-host] table')).toBeVisible()
  await page.locator('.housing-option-action').filter({ hasText: 'Harborline Rooms' })
    .getByRole('button', { name: 'Open plan' }).click()
  await expect(page.getByRole('dialog', { name: /Harborline Rooms/u })).toBeVisible()
  assert.equal(pageErrors.length, 0)
  assert(requests.every(request => request.method === 'GET' && new URL(request.url).origin === origin))
  assertionIds.push('HU-V11')
  const housingProof = {
    schema: 'commerce.housing-workspace-browser-proof/v1', origin, route: 'housing',
    acceptanceIds: [...new Set(assertionIds)].sort(), responsive,
    table: { mobileWidth: 390, documentWidth: scrollMetrics.documentWidth, scrollLeftAfterArrowRight: scrollMetrics.scrollLeft,
      scrollRegionWidth: scrollMetrics.clientWidth, tableScrollWidth: scrollMetrics.scrollWidth },
    offline: { networkBlocked, serviceWorkerControlled: true, route: page.url().split(origin).at(-1),
      routesCovered: ['#housing'],
      localSaveRead: true, pageErrors: 0, thirdPartyOrWriteRequests: 0 },
    lazySharedTableAdapter: !tableBeforeHousing && adapterAfterHousing,
    onlySavedIdsPersisted: true,
    requestCount: requests.length,
    verifiedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(output, 'housing-workspace-browser-proof.json'), JSON.stringify(housingProof, null, 2) + '\n')
  record(BROWSER_CHECKS.housing)
  await context.setOffline(false)
  await context.close()
  return housingProof
}
