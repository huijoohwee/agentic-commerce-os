import { expect, test } from '@playwright/test'

const listings = Array.from({ length: 15 }, (_, index) => ({
  agentId: `provider-${index}`, title: `Outcome ${String(index + 1).padStart(2, '0')}`,
  category: index % 2 ? 'research' : 'operations', summary: 'A useful outcome for an independent business.',
  offers: [{ offerId: `offer-${index}`, amountMinor: 2500 + index * 100, currency: 'USD' }],
}))

test('marketplace browse, filters, pagination and keyboard details work without eager agent discovery', async ({ page }) => {
  const discoveries: string[] = []
  page.on('request', request => { if (request.url().includes('/v1/intents/route')) discoveries.push(request.url()) })
  await page.route('**/v1/public/agents?**', route => route.fulfill({ json: { ok: true, agents: listings } }))
  await page.route('**/v1/session', route => route.fulfill({ json: { ok: true } }))
  await page.goto('/agentic-commerce-os/')
  await expect(page.locator('#catalog-count')).toHaveText('15 listings')
  expect(discoveries).toEqual([])
  await expect(page.locator('#catalog-results .listing')).toHaveCount(12)
  await page.locator('#catalog-next').click()
  await expect(page.locator('#catalog-page')).toHaveText('Page 2 of 2')
  await expect(page.locator('#catalog-results .listing')).toHaveCount(3)
  await page.getByLabel('Category', { exact: true }).selectOption('research')
  await expect(page.locator('#catalog-count')).toHaveText('7 listings')
  await expect(page.locator('#catalog-page')).toHaveText('Page 1 of 1')
  await page.getByLabel('Sort listings').selectOption('title')
  await expect(page.locator('#catalog-results h3').first()).toHaveText('Outcome 02')
  const detail = page.getByRole('button', { name: 'View details for Outcome 02', exact: true })
  await detail.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('provider-1')
  await page.keyboard.press('Escape')
  await expect(detail).toBeFocused()
  await detail.click()
  await page.getByRole('dialog').getByRole('button', { name: /Select offer offer-1 /u }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.locator('#offer-selection')).toContainText('26.00')
  await expect(page.getByRole('button', { name: 'Review checkout', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Reset filters' }).click()
  await expect(page.locator('#catalog-count')).toHaveText('15 listings')
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  await page.screenshot({ path: test.info().outputPath('shopper-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: test.info().outputPath('shopper-desktop.png'), fullPage: true })
  await page.context().setOffline(true)
  await expect(page.locator('#catalog-count')).toContainText('saved on this device')
  await expect(page.getByRole('button', { name: 'Review checkout', exact: true })).toBeDisabled()
  // A snapshot from another store must not be offered as this store's offline catalog.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
    })
    await new Promise<void>(resolve => {
      const tx = db.transaction('completed-sync', 'readwrite'), store = tx.objectStore('completed-sync')
      const request = store.get('storefront')
      request.onsuccess = () => store.put({ ...request.result, catalogPath: '/v1/public/merchants/another/catalog' })
      tx.oncomplete = () => resolve()
    })
    db.close()
    globalThis.dispatchEvent(new Event('offline'))
  })
  await expect(page.locator('#offline-indicator')).toContainText('no saved catalog for this storefront')
})

test('vendor preview, catalog and filtered proposals are connected and safe on mobile', async ({ page }) => {
  await page.route('**/v1/public/merchants/*/catalog', route => route.fulfill({ json: {
    ok: true, merchantId: 'solo-store', manifestDigest: 'a'.repeat(64), listings: [
      { listingId: 'brief', owningAgentId: 'solo-agent', title: 'Customer research brief', category: 'research' },
    ],
  } }))
  await page.goto('/vendor')
  const fields = { merchantId: 'solo-store', agentId: 'solo-agent', brand: 'First customer studio',
    headline: 'Find the customers who need your work', subhead: 'Practical research for independent founders.' }
  for (const [name, value] of Object.entries(fields)) await page.locator(`[name="${name}"]`).fill(value)
  await expect(page.locator('#preview-headline')).toHaveText(fields.headline)
  await page.screenshot({ path: test.info().outputPath('vendor-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: test.info().outputPath('vendor-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Stage for review' }).click()
  await expect(page.locator('#merchant-status')).toContainText('Saved for human review')
  await page.getByRole('navigation', { name: 'vendor workspace' }).getByRole('link', { name: 'Catalog' }).click()
  await expect(page.locator('#merchant-editor')).not.toBeVisible()
  await expect(page.locator('#workspace-heading')).toBeFocused()
  await page.getByRole('button', { name: 'Load catalog' }).click()
  await expect(page.locator('#vendor-catalog')).toContainText('Customer research brief')
  await expect(page.locator('#vendor-catalog').getByRole('link', { name: 'Open store' })).toHaveAttribute('href', '/s/solo-store')
  await page.getByRole('navigation', { name: 'vendor workspace' }).getByRole('link', { name: 'Proposals' }).click()
  await page.getByLabel('Filter proposal status').selectOption('applied')
  await expect(page.locator('#merchant-proposals')).toContainText('No matching proposals')
  await page.getByLabel('Filter proposal status').selectOption('pending')
  await expect(page.locator('#merchant-proposals')).toContainText(fields.brand)
  await expect(page.getByRole('button', { name: 'Approve and publish' })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('#workspace-heading')).toHaveText('Proposals')
  await expect(page.locator('#merchant-proposals')).toContainText(fields.brand)
})

test('admin registry search, state filter, pagination and details use the connected registry', async ({ page }) => {
  const privateFixture = crypto.randomUUID()
  const agents = Array.from({ length: 14 }, (_, i) => ({ agentId: `studio-${String(i + 1).padStart(2, '0')}`,
    declaredCategory: i % 2 ? 'research' : 'operations', registrationState: i % 2 ? 'active' : 'pending',
    bearerToken: privateFixture, endpoint: 'https://private.example/' }))
  await page.route('**/v1/operator/agents', route => route.fulfill({ json: { ok: true, agents } }))
  await page.goto('/agentic-commerce-os/admin')
  await expect(page.locator('#stat-agents')).toHaveText('—')
  await page.getByLabel('Operator credential').fill(crypto.randomUUID())
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('#stat-agents')).toHaveText('14')
  await page.getByRole('navigation', { name: 'admin workspace' }).getByRole('link', { name: 'Agents', exact: true }).click()
  await expect(page.locator('#operator-agents tbody tr')).toHaveCount(10)
  await page.locator('#registry-next').click()
  await expect(page.locator('#operator-agents tbody tr')).toHaveCount(4)
  await page.getByLabel('Search agents').fill('studio-02')
  await expect(page.locator('#operator-agents tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: 'View agent studio-02', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('research')
  await expect(page.getByRole('dialog')).not.toContainText(privateFixture)
  await page.keyboard.press('Escape')
  await page.getByLabel('Search agents').fill('')
  await page.getByLabel('Filter agent state').selectOption('active')
  await expect(page.locator('#operator-agents tbody tr')).toHaveCount(7)
  await page.screenshot({ path: test.info().outputPath('admin-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: test.info().outputPath('admin-desktop.png'), fullPage: true })
  await expect(page.locator('body')).not.toContainText(privateFixture)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.locator('#operator-agents')).toContainText('Connect an operator session')
  await expect(page.locator('#stat-agents')).toHaveText('—')
})
