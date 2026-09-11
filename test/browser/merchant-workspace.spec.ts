import { expect, test, type Page } from '@playwright/test'
import { installModelContextHarness, type WebMcpHarness } from './model-context'

const proposal = { merchantId: 'solo-shop', agentId: 'solo-agent', brand: 'Solo shop',
  headline: '<img src=x onerror=alert(1)>', subhead: 'One useful outcome for a busy founder' }

async function invoke(page: Page, name: string, input: unknown, aborted = false): Promise<unknown> {
  return page.evaluate(async ({ name, input, aborted }) => {
    const harness = Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness
    const execute = harness.definitions.find(tool => tool.name === name)?.execute
    if (typeof execute !== 'function') throw new Error('tool_missing')
    const controller = new AbortController()
    if (aborted) controller.abort(new Error('cancelled'))
    try { return await execute(input, { signal: controller.signal }) }
    catch (error) { return { error: String(error) } }
  }, { name, input, aborted })
}

test('merchant agents stage bounded visible proposals without publication authority', async ({ page }) => {
  const writes: string[] = [], assets: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST') writes.push(request.url())
    if (request.url().includes('/assets/')) assets.push(request.url())
  })
  await installModelContextHarness(page)
  await page.route('**/v1/public/merchants/*/catalog', route => route.fulfill({ status: 404,
    contentType: 'application/json', body: '{"ok":false,"code":"theme_deployment_not_found"}' }))
  await page.goto('/agentic-commerce-os/vendor')
  await expect.poll(() => page.evaluate(() => (Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness)?.definitions.length)).toBe(3)
  expect(await invoke(page, 'commerce.merchant.theme.stage', proposal, true)).toMatchObject({ error: expect.stringContaining('cancelled') })
  await expect(page.locator('#merchant-proposals')).toContainText('No proposals yet')
  const staged = await invoke(page, 'commerce.merchant.theme.stage', proposal)
  expect(staged).toMatchObject({ ok: true, status: 'pending' })
  expect(await invoke(page, 'commerce.merchant.theme.stage', proposal)).toEqual(staged)
  await expect(page.locator('#merchant-proposals .listing')).toHaveCount(1)
  await expect(page.locator('#merchant-proposals')).toContainText(proposal.headline)
  await expect(page.locator('#merchant-proposals img')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve and publish' })).toHaveCount(0)
  expect(writes).toEqual([])
  expect(assets.some(url => url.endsWith('/storefront.js'))).toBe(false)
  const names = await page.evaluate(() => (Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness).definitions.map(tool => tool.name))
  expect(names).toEqual(['commerce.merchant.catalog', 'commerce.merchant.theme.stage', 'commerce.merchant.proposals.read'])
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveAttribute('href', '/agentic-commerce-os/admin')
  await page.reload()
  await expect(page.locator('#merchant-proposals .listing')).toHaveCount(1)
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  await page.screenshot({ path: test.info().outputPath('vendor-mobile.png'), fullPage: true })
})

test('two admin tabs consume one reviewed write and never persist the operator credential', async ({ page, context }) => {
  const token = 'browser-fixture-secret', publications: unknown[] = []
  await context.route('**/v1/public/merchants/*/catalog', route => route.fulfill({ status: 404,
    contentType: 'application/json', body: '{"ok":false,"code":"theme_deployment_not_found"}' }))
  await context.route('**/v1/operator/**', async route => {
    expect(route.request().headers().authorization).toBe('Bearer ' + token)
    if (route.request().url().endsWith('/theme')) publications.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, agents: [{ agentId: 'solo-agent' }], manifestDigest: 'a'.repeat(64) }) })
  })
  await page.goto('/vendor')
  for (const [name, value] of Object.entries(proposal)) await page.locator(`[name="${name}"]`).fill(value)
  await page.getByRole('button', { name: 'Stage for review' }).click()
  await expect(page.locator('#merchant-proposals')).toContainText('pending')
  expect(publications).toHaveLength(0)
  const other = await context.newPage()
  for (const admin of [page, other]) {
    await admin.goto('/admin')
    await expect(admin.getByRole('button', { name: 'Approve and publish' })).toBeDisabled()
    await admin.getByLabel('Operator credential').fill(token)
    await admin.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(admin.locator('#operator-overview')).toContainText('1 registered agents')
    await expect(admin.getByLabel('Operator credential')).toHaveValue('')
  }
  await Promise.allSettled([page, other].map(admin => admin.getByRole('button', { name: 'Approve and publish' }).click({ force: true, timeout: 1500 })))
  await expect.poll(() => publications.length).toBe(1)
  await expect(page.locator('#merchant-proposals')).toContainText('applied')
  await expect(other.locator('#merchant-proposals')).toContainText('applied')
  expect(publications[0]).toMatchObject({ expectedPreviousManifestDigest: null,
    manifest: { merchantId: 'solo-shop', catalogScope: ['solo-agent'] } })
  const persisted = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const request = database.transaction('completed-sync').objectStore('completed-sync').getAll()
    const rows = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
    database.close()
    return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, rows })
  })
  expect(persisted).not.toContain(token)
  await page.reload()
  await expect(page.locator('#operator-overview')).toHaveText('Disconnected.')
  await other.close()
})

test('shopper agent actions render prices and selection in the human view', async ({ page }) => {
  await installModelContextHarness(page)
  await page.route('**/v1/public/agents?**', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, agents: [{ agentId: 'solo-agent', category: 'shopping', title: 'Research brief',
      offers: [{ offerId: 'brief', amountMinor: 2500, currency: 'USD' }] }] }) }))
  await page.route('**/v1/session', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"ok":true}' }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => (Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness)?.definitions.length)).toBe(3)
  expect(await invoke(page, 'commerce.catalog.search', { query: '', limit: 10 })).toMatchObject({ ok: true })
  const offer = page.getByRole('button', { name: /Select offer brief from Research brief/u })
  await expect(offer).toContainText('25.00')
  expect(await invoke(page, 'commerce.offer.select', { listingId: 'solo-agent', offerId: 'brief' })).toMatchObject({ ok: true })
  await expect(offer).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#offer-selection')).toContainText('Research brief')
  await expect(page.locator('#offer-selection')).toContainText('25.00')
})
