import { installModelContextHarness, type WebMcpHarness } from './model-context'
import { expect, test, type Page } from '@playwright/test'

test('capable Chromium contract registers the bounded tool set and refuses drift', async ({ browser, page }) => {
  expect(browser.browserType().name()).toBe('chromium')
  expect(Number.parseInt((await browser.version()).split('.')[0] ?? '0', 10)).toBeGreaterThanOrEqual(151)
  await installModelContextHarness(page)
  let catalogCalls = 0
  await page.route('**/v1/public/agents?**', async (route) => {
    catalogCalls += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"agents":[]}' })
  })
  await page.goto('/', { waitUntil: 'load' })

  await expect.poll(() => page.evaluate(() => (
    Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness | undefined
  )?.definitions.length ?? 0)).toBe(3)
  const proof = await page.evaluate(() => ({
    completedAt: (Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness | undefined)
      ?.completedAt ?? Number.POSITIVE_INFINITY,
    names: (Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness | undefined)
      ?.definitions.map(({ name }) => name) ?? [],
    toolCount: (Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness | undefined)
      ?.definitions.length ?? 0,
    loadAt: performance.getEntriesByType('navigation')[0]?.duration ?? 0,
  }))
  expect(proof.names).toEqual([
    'commerce.catalog.search',
    'commerce.offer.select',
    'commerce.checkout.initiate',
  ])
  expect(proof.toolCount).toBeLessThanOrEqual(16)
  expect(Math.max(0, proof.completedAt - proof.loadAt)).toBeLessThan(2_000)

  const refusal = await page.evaluate(async () => {
    const harness = Reflect.get(globalThis, '__webMcpHarness') as WebMcpHarness | undefined
    if (!harness) throw new Error('webmcp_harness_missing')
    harness.live.push({ name: 'commerce.catalog.changed', inputSchema: { type: 'object' } })
    const execute = harness.definitions[0]?.execute
    if (typeof execute !== 'function') throw new Error('webmcp_execute_missing')
    return await execute({ query: '', limit: 10 }, { signal: new AbortController().signal })
  })
  expect(refusal).toMatchObject({ ok: false, code: 'webmcp_registration_drift' })
  expect(catalogCalls).toBe(0)
  await expect.poll(() => pendingEventTypes(page)).toContain('webmcp_registration_drift')
})

test('incapable Chromium keeps the complete visual preparation flow silent and operable', async ({ page }) => {
  await page.route('**/v1/public/agents?**', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      agents: [{
        agentId: 'agent-incapable-engine',
        category: 'travel',
        title: 'Visual path proof',
        summary: 'Available without a model-context API.',
        offers: [{
          offerId: 'offer-incapable-engine',
          intentId: 'intent-incapable-engine',
          agentId: 'agent-incapable-engine',
          offerReceiptDigest: 'a'.repeat(64),
          amountMinor: 1_000,
          budgetMinor: 1_000,
          currency: 'USD',
        }],
      }],
    }),
  }))
  await page.route('**/v1/session', async (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: '{"ok":true}',
  }))
  await page.route('**/v1/checkouts/*/prepare', async (route) => {
    const input = JSON.parse(route.request().postData() ?? '{}') as Readonly<Record<string, unknown>>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checkoutId: input.checkoutId,
        confirmationExpiresAt: Date.now() + 90_000,
        humanConfirmation: {
          csrfToken: crypto.randomUUID().repeat(2),
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
          challenge: 'A'.repeat(43),
          sessionNonceDigest: 'b'.repeat(64),
          blockerDigest: 'c'.repeat(64),
          audience: 'agentic-graph-commerce-checkout',
          relyingPartyOrigin: new URL(route.request().url()).origin,
          blockers: [],
          verificationMode: 'development-visual-only',
        },
      }),
    })
  })

  await page.goto('/', { waitUntil: 'load' })
  expect(await page.evaluate(() => Reflect.get(Reflect.get(globalThis, 'document'), 'modelContext'))).toBeUndefined()
  await expect.poll(() => pendingEventTypes(page)).toContain('webmcp_surface_unavailable')
  await expect(page.locator('body')).not.toContainText(/webmcp|model context/iu)

  await page.getByRole('button', { name: 'Search catalog' }).click()
  await page.getByRole('button', { name: /offer-incapable-engine/u }).click()
  await page.getByRole('button', { name: 'Review checkout' }).click()
  await expect(page.getByRole('heading', { name: 'Review and confirm' })).toBeVisible()
  await expect(page.locator('#confirmation-offer')).toHaveText('offer-incapable-engine')
})

test('two incapable tabs atomically preserve the shared 500-change ceiling', async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('browser_base_url_required')
  const context = await browser.newContext({ baseURL, viewport: { width: 360, height: 800 } })
  await context.route('**/v1/session', async (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: '{"ok":false}',
  }))
  const setup = await context.newPage()
  await setup.goto('/', { waitUntil: 'load' })
  await seedPendingChanges(setup, 499)
  await setup.close()

  const left = await context.newPage()
  const right = await context.newPage()
  await Promise.all([
    left.goto('/', { waitUntil: 'load' }),
    right.goto('/', { waitUntil: 'load' }),
  ])
  await expect.poll(() => pendingEventTypes(left)).toContain('webmcp_surface_unavailable')
  await expect.poll(() => pendingChangeCount(left)).toBe(500)
  expect((await pendingEventTypes(left)).filter((type) => type === 'webmcp_surface_unavailable')).toHaveLength(1)
  await context.close()
})

async function pendingEventTypes(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('pending-changes', 'readonly')
    const rows = await new Promise<Array<Readonly<{ payload?: Readonly<{ type?: unknown }> }>>>((resolve, reject) => {
      const request = transaction.objectStore('pending-changes').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return rows.map(({ payload }) => payload?.type).filter((value): value is string => typeof value === 'string')
  })
}

async function seedPendingChanges(page: Page, count: number): Promise<void> {
  await page.evaluate(async (targetCount) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('pending-changes', 'readwrite')
    const store = transaction.objectStore('pending-changes')
    store.clear()
    for (let index = 0; index < targetCount; index += 1) {
      store.add({ scope: 'storefront', payload: { type: 'seed', index }, recordedAtMs: index })
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  }, count)
}

async function pendingChangeCount(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('pending-changes', 'readonly')
    const count = await new Promise<number>((resolve, reject) => {
      const request = transaction.objectStore('pending-changes').count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return count
  })
}
