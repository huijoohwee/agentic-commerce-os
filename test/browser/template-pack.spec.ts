import { expect, test, type Browser, type Page } from '@playwright/test'
import { consoleResponse } from '../../src/edge/dashboard.ts'
import { THEME_MANIFEST_DEFAULTS } from '../../src/shared/theme-manifest.ts'

const NETWORK_BYTES_PER_SECOND = 1_600_000 / 8

test('mobile storefront paints within the declared network budget', async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('browser_base_url_required')
  const paints: number[] = []
  for (let index = 0; index < 5; index += 1) {
    paints.push(await coldFirstContentfulPaint(browser, baseURL))
  }
  paints.sort((left, right) => left - right)
  expect(paints[2]).toBeLessThan(2_000)
})

test('default and themed storefronts keep semantic controls and touch targets', async ({ page }) => {
  const themed = Object.freeze({
    ...THEME_MANIFEST_DEFAULTS,
    merchantId: 'merchant-fixture',
    palette: Object.freeze({ ...THEME_MANIFEST_DEFAULTS.palette, accent: '#76e6ff' }),
    copy: Object.freeze({ ...THEME_MANIFEST_DEFAULTS.copy, brand: 'Merchant Fixture' }),
  })
  for (const manifest of [THEME_MANIFEST_DEFAULTS, themed]) {
    const response = consoleResponse({
      lane: 'Dev',
      releaseCandidateSha: 'dev-unreleased',
      version: Object.freeze({ id: 'local' }),
    }, manifest)
    await page.setContent(await response.text())
    await expect(page.locator('main')).toBeVisible()
    const controls = page.locator('a:visible, button:visible, input:visible, select:visible, textarea:visible')
    expect(await controls.count()).toBeGreaterThan(0)
    for (let index = 0; index < await controls.count(); index += 1) {
      const control = controls.nth(index)
      const accessibleName = await control.getAttribute('aria-label')
        ?? await control.textContent()
        ?? await control.getAttribute('placeholder')
        ?? ''
      expect(accessibleName.trim()).not.toBe('')
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
  }
})

test('mobile canvas navigation opens a separate workspace without eager loading', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  const response = consoleResponse({ lane: 'Production', releaseCandidateSha: 'a'.repeat(40),
    version: { id: 'browser-fixture' } }, THEME_MANIFEST_DEFAULTS,
  { graphWorkspaceUrl: 'https://canvas.example/agentic-graph/' })
  await page.setContent(await response.text())
  const link = page.getByRole('link', { name: 'Open in canvas (new tab)' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://canvas.example/agentic-graph/?openEditorWorkspace=1')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  expect(requests.filter(url => url.includes('canvas.example'))).toEqual([])
  await page.context().route('https://canvas.example/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>Canvas fixture</title>',
  }))
  const popupPromise = page.waitForEvent('popup')
  await link.click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  expect(await popup.evaluate('window.opener === null')).toBe(true)
  await expect(page.locator('#catalog-search')).toBeVisible()
  await popup.close()
})

test('shipped WebMCP registration has explicit count and two-second bounds', async ({ request }) => {
  const asset = await request.get('/assets/storefront.js')
  expect(asset.ok()).toBe(true)
  const STOREFRONT_CLIENT_MODULE = await asset.text()
  expect(STOREFRONT_CLIENT_MODULE).toContain('const MAXIMUM_REGISTERED_TOOLS = 16;')
  expect(STOREFRONT_CLIENT_MODULE).toContain('const WEBMCP_REGISTRATION_LIMIT_MS = 2000;')
  expect(STOREFRONT_CLIENT_MODULE).toContain('await Promise.race([')
  expect(STOREFRONT_CLIENT_MODULE).toContain('clearTimeout(registrationTimeout)')
  expect(STOREFRONT_CLIENT_MODULE).toContain('document.modelContext.getTools()')
  expect(STOREFRONT_CLIENT_MODULE).toContain('{ signal: registrationController.signal }')
  expect(STOREFRONT_CLIENT_MODULE).toContain("registrationController.abort(new Error('webmcp_registration_drift'))")
  expect(STOREFRONT_CLIENT_MODULE).not.toContain("name: 'commerce.checkout.confirm'")
})

test('an online event begins FIFO replay and deletes acknowledged IndexedDB changes', async ({ page }) => {
  const submitted: Array<Readonly<Record<string, unknown>>> = []
  await page.route('**/v1/session', async (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }))
  await page.route('**/v1/sync/merge', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Readonly<Record<string, unknown>>
    submitted.push(body)
    const accepted = Array.isArray(body.left) ? body.left : []
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, state: { fields: accepted, eventLog: accepted } }),
    })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await addPendingChange(page, { type: 'browser-replay-proof' })

  const startedAt = Date.now()
  await page.evaluate(() => globalThis.dispatchEvent(new Event('online')))
  await expect.poll(() => submitted.length, { timeout: 5_000 }).toBeGreaterThan(0)
  expect(Date.now() - startedAt).toBeLessThan(5_000)
  await expect.poll(() => pendingChangeCount(page)).toBe(0)

  const changes = submitted.flatMap((body) => Array.isArray(body.left) ? body.left : [])
  expect(changes.some((change) => (
    typeof change === 'object'
    && change !== null
    && 'value' in change
    && (change.value as Readonly<Record<string, unknown>>).type === 'browser-replay-proof'
  ))).toBe(true)
})

test('sync replay retains a change when an ok response omits its typed acceptance evidence', async ({ page }) => {
  let submitted = 0
  await page.route('**/v1/session', async (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }))
  await page.route('**/v1/sync/merge', async (route) => {
    submitted += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, state: { fields: [], eventLog: [] } }),
    })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => pendingChangeCount(page)).toBeGreaterThanOrEqual(1)
  const retainedBefore = await pendingChangeCount(page)
  await addPendingChange(page, { type: 'must-remain-unacknowledged' })
  await page.evaluate(() => globalThis.dispatchEvent(new Event('online')))
  await expect.poll(() => submitted).toBeGreaterThan(0)
  await expect.poll(() => pendingChangeCount(page)).toBe(retainedBefore + 1)
})

test('visual checkout requires explicit human confirmation and never persists its proof', async ({ page }) => {
  const csrfToken = crypto.randomUUID().repeat(2)
  const digest = 'a'.repeat(64)
  const confirmations: Array<Readonly<Record<string, unknown>>> = []
  let finishConfirmation = () => {}
  const confirmationGate = new Promise<void>(resolve => { finishConfirmation = resolve })
  await page.route('**/v1/public/agents?**', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      agents: [{
        agentId: 'agent-browser-human',
        category: 'travel',
        title: 'Human-reviewed trip',
        summary: 'A verified offer requiring an explicit final confirmation.',
        offers: [{
          offerId: 'offer-browser-human',
          intentId: 'intent-browser-human',
          agentId: 'agent-browser-human',
          offerReceiptDigest: digest,
          amountMinor: 1_250,
          budgetMinor: 1_250,
          currency: 'USD',
        }],
      }],
    }),
  }))
  await page.route('**/v1/session', async (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }))
  await page.route('**/v1/checkouts/*/prepare', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Readonly<Record<string, unknown>>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checkoutId: body.checkoutId,
        confirmationExpiresAt: Date.now() + 90_000,
        humanConfirmation: {
          csrfToken,
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
  await page.route('**/v1/human/checkouts/*/confirm', async (route) => {
    confirmations.push(JSON.parse(route.request().postData() ?? '{}') as Readonly<Record<string, unknown>>)
    expect(route.request().headers()['x-human-confirmation-csrf']).toBe(csrfToken)
    await confirmationGate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, status: 'settled' }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Search catalog' }).click()
  await page.getByRole('button', { name: /offer-browser-human/u }).click()
  await page.getByRole('button', { name: 'Review checkout' }).click()
  await expect(page.getByRole('heading', { name: 'Review and confirm' })).toBeVisible()
  await expect(page.locator('#confirmation-offer')).toHaveText('offer-browser-human')
  await expect(page.locator('#confirmation-total')).toContainText('12.50')
  expect(confirmations).toHaveLength(0)

  await page.getByRole('button', { name: 'Confirm checkout after reviewing the total' }).click()
  try {
    await expect.poll(() => confirmations.length).toBe(1)
    await expect(page.getByRole('button', { name: 'Search catalog' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Select offer offer-browser-human/u })).toBeDisabled()
    await expect(page.locator('#confirmation-total')).toContainText('12.50')
  } finally { finishConfirmation() }
  await expect(page.locator('#checkout-confirmation-summary')).toHaveText('Checkout confirmed.')
  await expect(page.locator('#confirmation-reference')).toContainText(String(confirmations[0]?.checkoutId))
  await expect(page.locator('#confirmation-total')).toContainText('12.50')
  const persisted = await pendingChangePayloads(page)
  expect(JSON.stringify(persisted)).not.toContain(csrfToken)
  expect(confirmations[0]).not.toHaveProperty('confirmationToken')
})

test('checkout totals render ISO minor-unit exponents without floating-point drift', async ({ page }) => {
  let active = { currency: 'JPY', amountMinor: 1_250 }
  await page.route('**/v1/public/agents?**', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      agents: [{
        agentId: 'agent-currency',
        category: 'travel',
        title: 'Currency-safe offer',
        summary: 'Exact minor units.',
        offers: [{
          offerId: 'offer-currency',
          intentId: 'intent-currency',
          agentId: 'agent-currency',
          offerReceiptDigest: 'a'.repeat(64),
          budgetMinor: active.amountMinor,
          ...active,
        }],
      }],
    }),
  }))
  await page.route('**/v1/session', async (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }))
  await page.route('**/v1/checkouts/*/prepare', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
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
  }))

  for (const currencyCase of [
    { currency: 'JPY', amountMinor: 1_250 },
    { currency: 'KWD', amountMinor: 1_250 },
    { currency: 'USD', amountMinor: Number.MAX_SAFE_INTEGER },
  ]) {
    active = currencyCase
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Search catalog' }).click()
    await page.getByRole('button', { name: /offer-currency/u }).click()
    await page.getByRole('button', { name: 'Review checkout' }).click()
    await expect(page.getByRole('heading', { name: 'Review and confirm' })).toBeVisible()
    const renderedDigits = (await page.locator('#confirmation-total').textContent())?.replace(/\D/gu, '')
    expect(renderedDigits).toBe(String(currencyCase.amountMinor))
  }
})

test('reconfirmation renders and binds the exact changed-offer blocker set', async ({ page }) => {
  const initialCsrf = crypto.randomUUID().repeat(2)
  const replacementCsrf = crypto.randomUUID().repeat(2)
  let confirmationCalls = 0
  await page.route('**/v1/public/agents?**', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, agents: [{
      agentId: 'agent-change', category: 'travel', title: 'Changing offer', summary: 'Watched offer.',
      offers: [{
        offerId: 'offer-change', intentId: 'intent-change', agentId: 'agent-change',
        offerReceiptDigest: 'a'.repeat(64), amountMinor: 1_250, budgetMinor: 1_250, currency: 'USD',
      }],
    }] }),
  }))
  await page.route('**/v1/session', async (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }))
  await page.route('**/v1/checkouts/*/prepare', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      humanConfirmation: {
        csrfToken: initialCsrf,
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
  }))
  await page.route('**/v1/human/checkouts/*/confirm', async (route) => {
    confirmationCalls += 1
    const body = JSON.parse(route.request().postData() ?? '{}') as Readonly<Record<string, unknown>>
    if (confirmationCalls === 1) {
      expect(body.blockerDigest).toBe('c'.repeat(64))
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'offer_reconfirmation_required',
          humanConfirmation: {
            csrfToken: replacementCsrf,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            challenge: 'D'.repeat(43),
            sessionNonceDigest: 'b'.repeat(64),
            blockerDigest: 'e'.repeat(64),
            audience: 'agentic-graph-commerce-checkout',
            relyingPartyOrigin: new URL(route.request().url()).origin,
            blockers: [{
              sequence: 7,
              eventType: 'offer_changed',
              evidence: { attribute: 'priceMinor', recordedValue: 1_250, observedValue: 1_300 },
            }],
            verificationMode: 'development-visual-only',
          },
        }),
      })
      return
    }
    expect(route.request().headers()['x-human-confirmation-csrf']).toBe(replacementCsrf)
    expect(body.blockerDigest).toBe('e'.repeat(64))
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'settled' }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Search catalog' }).click()
  await page.getByRole('button', { name: /offer-change/u }).click()
  await page.getByRole('button', { name: 'Review checkout' }).click()
  await page.getByRole('button', { name: 'Confirm checkout after reviewing the total' }).click()
  await expect(page.locator('#checkout-confirmation-summary'))
    .toContainText('priceMinor changed from 1250 to 1300')
  await page.getByRole('button', { name: 'Confirm checkout after reviewing the total' }).click()
  await expect.poll(() => confirmationCalls).toBe(2)
  await expect(page.locator('#checkout-confirmation-summary')).toHaveText('Checkout confirmed.')
})

async function coldFirstContentfulPaint(browser: Browser, baseURL: string): Promise<number> {
  const context = await browser.newContext({ baseURL, viewport: { width: 360, height: 800 } })
  const page = await context.newPage()
  await applyNetworkProfile(page)
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => (
    performance.getEntriesByName('first-contentful-paint').length
  )), { timeout: 5_000 }).toBeGreaterThan(0)
  const paint = await page.evaluate(() => (
    performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? Number.POSITIVE_INFINITY
  ))
  await context.close()
  return paint
}

async function applyNetworkProfile(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: NETWORK_BYTES_PER_SECOND,
    uploadThroughput: NETWORK_BYTES_PER_SECOND,
    connectionType: 'cellular4g',
  })
}

async function addPendingChange(page: Page, payload: Readonly<Record<string, unknown>>): Promise<void> {
  await page.evaluate(async (value) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('pending-changes', 'readwrite')
      transaction.objectStore('pending-changes').add({
        scope: 'storefront', payload: value, recordedAtMs: Date.now(),
      })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  }, payload)
}

async function pendingChangeCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const count = await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction('pending-changes', 'readonly')
      const request = transaction.objectStore('pending-changes').count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return count
  })
}

async function pendingChangePayloads(page: Page): Promise<readonly unknown[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('agentic-commerce-storefront', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const rows = await new Promise<Array<{ payload: unknown }>>((resolve, reject) => {
      const transaction = database.transaction('pending-changes', 'readonly')
      const request = transaction.objectStore('pending-changes').getAll()
      request.onsuccess = () => resolve(request.result as Array<{ payload: unknown }>)
      request.onerror = () => reject(request.error)
    })
    database.close()
    return rows.map(({ payload }) => payload)
  })
}
