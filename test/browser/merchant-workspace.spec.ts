import { expect, test, type Page } from '@playwright/test'
import { canonicalJson, sha256Hex } from '../../src/shared/digest'
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

test('environment observations are bounded, identity matched, cancellable and never authorize writes', async ({ page, context }) => {
  const writes: string[] = []
  let reads = 0
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()) })
  await page.goto('/admin#runtime')
  await expect(page.locator('#environment-badge')).toHaveText('Not checked')
  await context.setOffline(true); await context.setOffline(false)
  await expect(page.locator('#environment-status')).not.toContainText('Offline.')
  const panel = page.locator('#environment-panel')
  const expected = { source: await panel.getAttribute('data-source'), lane: await panel.getAttribute('data-lane'), version: await panel.getAttribute('data-version') }
  const evidence = { ok: true, contract: 'commerce.edge-readiness/v2', lane: expected.lane,
    releaseCandidateSha: expected.source, version: { id: expected.version }, sourceReadiness: { ok: true }, liveReleaseReadiness: { ok: true } }
  let body = JSON.stringify(evidence)
  await page.route('**/readyz', route => { reads++; return route.fulfill({ status: 200, contentType: 'application/json', body }) })
  expect(reads).toBe(0)
  await page.clock.install()
  await page.locator('#environment-refresh').click()
  await expect(page.locator('#environment-badge')).toHaveText('Checks passed')
  await expect(page.locator('#environment-status')).toContainText('No deployment')
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  }
  await page.clock.fastForward(60001)
  await expect(page.locator('#environment-badge')).toHaveText('Stale · Check again')
  expect(reads).toBe(1)
  for (const value of [{ ...evidence, lane: 'other' }, { ...evidence, version: { id: 'other' } },
    { ...evidence, releaseCandidateSha: 'other' }, { ...evidence, profile: 'local-first', contract: 'other' }]) {
    body = JSON.stringify(value)
    await page.locator('#environment-refresh').click()
    await expect(page.locator('#environment-status')).toContainText('does not match')
    await expect(page.locator('#environment-badge')).toHaveText('Unknown')
  }
  body = ' '.repeat(32769)
  await page.locator('#environment-refresh').click()
  await expect(page.locator('#environment-status')).toContainText('exceeded its limit')
  await context.setOffline(true)
  await expect(page.locator('#environment-badge')).toHaveText('Offline')
  await expect(page.locator('#environment-refresh')).toBeDisabled()
  await context.setOffline(false)
  await page.unroute('**/readyz')
  let releaseRead!: () => void
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve })
  await page.route('**/readyz', async route => { await heldRead; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evidence) }) })
  await page.locator('#environment-refresh').click()
  await page.locator('#environment-cancel').click()
  await expect(page.locator('#environment-status')).toContainText('cancelled')
  releaseRead(); await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('#environment-badge')).toHaveText('Unknown')
  let releaseTimeout!: () => void
  const heldTimeout = new Promise<void>(resolve => { releaseTimeout = resolve })
  await page.route('**/readyz', async route => { await heldTimeout; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evidence) }) })
  await page.locator('#environment-refresh').click()
  await page.clock.fastForward(5001)
  await expect(page.locator('#environment-status')).toContainText('timed out')
  releaseTimeout(); await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('#environment-badge')).toHaveText('Unknown')
  expect(writes).toEqual([])
  await page.screenshot({ path: test.info().outputPath('environment-desktop.png'), fullPage: true })
})


test('a lost publication response stays unknown until explicit matching readback', async ({ page }) => {
  let manifestDigest: string | null = null, publications = 0
  await page.route('**/v1/public/merchants/*/catalog', route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ ok: true, manifestDigest, listings: [] }) }))
  await page.route('**/v1/operator/**', async route => {
    if (route.request().url().endsWith('/theme')) {
      publications++
      manifestDigest = await sha256Hex(canonicalJson(route.request().postDataJSON().manifest))
      await route.abort('failed'); return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, agents: [{ agentId: 'solo-agent' }] }) })
  })
  await page.goto('/vendor')
  for (const [name, value] of Object.entries(proposal)) await page.locator(`[name="${name}"]`).fill(value)
  await page.getByRole('button', { name: 'Stage for review' }).click()
  await expect(page.locator('#merchant-proposals')).toContainText('pending')
  await page.goto('/admin')
  await page.getByLabel('Operator credential').fill('recovery-fixture-secret')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('#operator-overview')).toContainText('1 registered agents')
  await page.clock.install()
  await page.getByRole('button', { name: 'Approve and publish' }).click()
  await expect(page.locator('#merchant-proposals')).toContainText('Outcome unknown')
  await expect(page.getByRole('button', { name: 'Approve and publish' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Check publication' }).click()
  await expect(page.locator('#merchant-status')).toContainText('Wait one minute')
  await page.clock.fastForward(60001)
  await page.getByRole('button', { name: 'Check publication' }).click()
  await expect(page.locator('#merchant-proposals')).toContainText('This storefront version was confirmed')
  expect(publications).toBe(1)
})
