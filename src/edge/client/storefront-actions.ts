import { isRecord } from '../../shared/http'
import { recordChange, recordCompletedSync, settlementBlockedOffline, type LocalStore } from './local-store'

const MAXIMUM_QUERY_LENGTH = 280
const MAXIMUM_SEARCH_LIMIT = 100
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u

export type CatalogOffer = Readonly<{
  offerId: string
  intentId: string
  agentId: string
  offerReceiptDigest: string
  amountMinor: number
  budgetMinor: number
  currency: string
}>

export type CatalogListing = Readonly<{
  listingId: string
  agentId: string
  category: string
  title: string
  summary: string
  offers: readonly CatalogOffer[]
  checkoutAvailability?: Readonly<{ ok: false; code: string }>
}>

export type CatalogPage = Readonly<{
  ok: true
  query: string
  limit: number
  listings: readonly CatalogListing[]
}>

export type SelectedOffer =
  | Readonly<{
    ok: true
    listingId: string
    offerId: string
    amountMinor: number
    currency: string
  }>
  | Readonly<{ ok: false; code: 'local_change_capacity_reached'; retained: number }>

export type CheckoutPrepared =
  | Readonly<{
    ok: true
    checkoutId: string
    state: 'awaiting-human-confirmation'
  }>
  | Readonly<{ ok: false; code: string }>

export type StorefrontActions = Readonly<{
  searchCatalog(input: Readonly<{ query: string; limit: number }>): Promise<CatalogPage>
  selectOffer(input: Readonly<{ listingId: string; offerId: string }>): Promise<SelectedOffer>
  initiateCheckout(input: Readonly<{
    offerId: string
    amountMinor: number
    currency: string
  }>): Promise<CheckoutPrepared>
}>

export type StorefrontDeps = Readonly<{
  fetcher?: typeof fetch
  catalogPath?: string
  sessionPath?: string
  checkoutPath?: (checkoutId: string) => string
  online?: () => boolean
  localStore?: Partial<Pick<LocalStore, 'recordChange' | 'recordCompletedSync'>>
  now?: () => number
  createId?: () => string
}>

export function createStorefrontActions(deps: StorefrontDeps = {}): StorefrontActions {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis)
  const catalogPath = deps.catalogPath ?? '/v1/public/agents'
  const sessionPath = deps.sessionPath ?? '/v1/session'
  const checkoutPath = deps.checkoutPath ?? ((checkoutId) => `/v1/checkouts/${encodeURIComponent(checkoutId)}/prepare`)
  const online = deps.online ?? (() => Reflect.get(globalThis, 'navigator')
    ? Reflect.get(Reflect.get(globalThis, 'navigator') as object, 'onLine') !== false
    : true)
  const now = deps.now ?? Date.now
  const createId = deps.createId ?? (() => crypto.randomUUID())
  const saveSnapshot = deps.localStore?.recordCompletedSync ?? recordCompletedSync
  const saveChange = deps.localStore?.recordChange ?? recordChange
  const merchantId = merchantIdFromCatalogPath(catalogPath)
  let catalog: readonly CatalogListing[] = Object.freeze([])
  let selected: CatalogOffer | null = null
  let selectedListingId: string | null = null

  return Object.freeze({
    async searchCatalog({ query, limit }) {
      const normalizedQuery = boundedQuery(query)
      if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_SEARCH_LIMIT) {
        throw new Error('catalog_limit_invalid')
      }
      if (!online()) throw Object.assign(new Error('connectivity_absent'), settlementBlockedOffline())
      const url = new URL(catalogPath, locationBase())
      url.searchParams.set('query', normalizedQuery)
      url.searchParams.set('limit', String(limit))
      const response = await fetcher(relativeWhenSameOrigin(url), { credentials: 'same-origin' })
      const payload: unknown = await response.json()
      if (!response.ok) throw new Error(readFailureCode(payload, 'catalog_unavailable'))
      const scoped = readListings(payload)
        .filter((listing) => matchesQuery(listing, normalizedQuery))
        .slice(0, limit)
      if (scoped.length === 0) catalog = Object.freeze([])
      else if (scoped.some((listing) => listing.offers.length > 0)) catalog = Object.freeze(scoped)
      else {
        if (!await establishSession(fetcher, sessionPath)) throw new Error('storefront_session_unavailable')
        const target = scoped[0]
        if (!target) throw new Error('catalog_listing_unavailable')
        const intentId = `intent-${createId()}`
        const routeResponse = await fetcher('/v1/intents/route', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intentId,
            category: target.category,
            constraints: { query: normalizedQuery },
            ...(merchantId ? { merchantId, listingId: target.listingId } : {}),
          }),
        })
        const routePayload: unknown = await routeResponse.json()
        if (!routeResponse.ok) throw new Error(readFailureCode(routePayload, 'offer_discovery_failed'))
        catalog = readDiscoveredOffers(routePayload, scoped, intentId)
      }
      const page = Object.freeze({ ok: true as const, query: normalizedQuery, limit, listings: catalog })
      await saveSnapshot(Object.freeze({ scope: 'storefront', value: page, completedAtMs: now() }))
      return page
    },

    async selectOffer({ listingId, offerId }) {
      const listing = catalog.find((entry) => entry.listingId === listingId)
      const offer = listing?.offers.find((entry) => entry.offerId === offerId)
      if (!offer) throw new Error('offer_not_found')
      const recorded = await saveChange(Object.freeze({
        scope: 'storefront',
        payload: Object.freeze({ type: 'offer_selected', listingId, offerId }),
        recordedAtMs: now(),
      }))
      if (!recorded.ok) return recorded
      selected = offer
      selectedListingId = listingId
      return Object.freeze({
        ok: true,
        listingId,
        offerId,
        amountMinor: offer.amountMinor,
        currency: offer.currency,
      })
    },

    async initiateCheckout(input) {
      if (!selected || selectedListingId === null || input.offerId !== selected.offerId) {
        return Object.freeze({ ok: false, code: 'offer_selection_required' })
      }
      if (input.amountMinor !== selected.amountMinor || input.currency !== selected.currency) {
        return Object.freeze({ ok: false, code: 'offer_selection_drift' })
      }
      if (!online()) return settlementBlockedOffline()
      if (!await establishSession(fetcher, sessionPath)) {
        return Object.freeze({ ok: false, code: 'storefront_session_unavailable' })
      }
      const checkoutId = `checkout-${createId()}`
      const response = await fetcher(checkoutPath(checkoutId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          checkoutId,
          intentId: selected.intentId,
          agentId: selected.agentId,
          offerId: selected.offerId,
          offerReceiptDigest: selected.offerReceiptDigest,
          amountMinor: selected.amountMinor,
          budgetMinor: selected.budgetMinor,
          currency: selected.currency,
        }),
      })
      const payload: unknown = await response.json()
      if (!response.ok || (isRecord(payload) && payload.ok === false)) {
        return Object.freeze({ ok: false, code: readFailureCode(payload, 'checkout_prepare_failed') })
      }
      // Confirmation material stays outside this action surface. A human-authorized operator flow owns settlement.
      return Object.freeze({ ok: true, checkoutId, state: 'awaiting-human-confirmation' })
    },
  })
}

function boundedQuery(value: string): string {
  if (value !== value.trim() || value.length > MAXIMUM_QUERY_LENGTH) throw new Error('catalog_query_invalid')
  return value
}

function readListings(payload: unknown): readonly CatalogListing[] {
  if (!isRecord(payload)) throw new Error('catalog_response_invalid')
  const candidates = Array.isArray(payload.listings)
    ? payload.listings
    : Array.isArray(payload.agents) ? payload.agents : []
  return Object.freeze(candidates.map(readListing))
}

function readListing(value: unknown): CatalogListing {
  if (!isRecord(value)) throw new Error('catalog_listing_invalid')
  const listingId = readIdentifier(value.listingId ?? value.agentId)
  const agentId = readIdentifier(value.owningAgentId ?? value.agentId)
  const category = readBoundedText(value.category ?? value.declaredCategory, 64)
  const title = readBoundedText(value.title ?? value.agentId ?? value.owningAgentId, 280)
  const summary = readBoundedText(value.summary ?? '', 280, true)
  const offers = Array.isArray(value.offers) ? value.offers.map(readOffer) : []
  return Object.freeze({ listingId, agentId, category, title, summary, offers: Object.freeze(offers) })
}

function readOffer(value: unknown): CatalogOffer {
  if (!isRecord(value)) throw new Error('catalog_offer_invalid')
  const amountMinor = readPositiveInteger(value.amountMinor)
  const budgetMinor = readPositiveInteger(value.budgetMinor ?? value.amountMinor)
  const offerReceiptDigest = readBoundedText(value.offerReceiptDigest, 64)
  if (!DIGEST_PATTERN.test(offerReceiptDigest)) throw new Error('catalog_offer_digest_invalid')
  const currency = readBoundedText(value.currency, 3)
  if (!/^[A-Z]{3}$/u.test(currency)) throw new Error('catalog_offer_currency_invalid')
  return Object.freeze({
    offerId: readIdentifier(value.offerId),
    intentId: readIdentifier(value.intentId),
    agentId: readIdentifier(value.agentId),
    offerReceiptDigest,
    amountMinor,
    budgetMinor,
    currency,
  })
}

function readDiscoveredOffers(
  payload: unknown,
  scoped: readonly CatalogListing[],
  intentId: string,
): readonly CatalogListing[] {
  if (!isRecord(payload) || payload.ok !== true || typeof payload.agentId !== 'string') {
    throw new Error('offer_discovery_invalid')
  }
  const listing = scoped.find((entry) => entry.agentId === payload.agentId)
  if (!listing) return merchantScopeUnavailable(scoped, 'routed_agent_outside_catalog')
  const receipt = isRecord(payload.result) ? payload.result : null
  const offers = receipt && Array.isArray(receipt.offers)
    ? receipt.offers.map((offer) => readDiscoveredOffer(offer, intentId, listing.agentId))
    : []
  if (offers.length === 0) return merchantScopeUnavailable(scoped, 'offer_discovery_unavailable')
  return Object.freeze(scoped.map((entry) => entry.listingId === listing.listingId
    ? Object.freeze({ ...entry, offers: Object.freeze(offers) })
    : unavailableListing(entry, 'offer_not_selected_by_router')))
}

function merchantScopeUnavailable(
  listings: readonly CatalogListing[],
  code = 'merchant_scoped_offer_unavailable',
): readonly CatalogListing[] {
  return Object.freeze(listings.map((listing) => unavailableListing(listing, code)))
}

function unavailableListing(listing: CatalogListing, code: string): CatalogListing {
  return Object.freeze({
    ...listing,
    offers: Object.freeze([]),
    checkoutAvailability: Object.freeze({ ok: false as const, code }),
  })
}

function readDiscoveredOffer(value: unknown, intentId: string, agentId: string): CatalogOffer {
  if (!isRecord(value) || value.intentId !== intentId || value.agentId !== agentId) {
    throw new Error('discovery_offer_invalid')
  }
  const receiptDigest = readBoundedText(value.receiptDigest, 64)
  if (!DIGEST_PATTERN.test(receiptDigest)) throw new Error('discovery_offer_digest_invalid')
  const amountMinor = readPositiveInteger(value.amountMinor)
  const currency = readBoundedText(value.currency, 3)
  if (!/^[A-Z]{3}$/u.test(currency)) throw new Error('discovery_offer_currency_invalid')
  return Object.freeze({
    offerId: readIdentifier(value.offerId),
    intentId,
    agentId,
    offerReceiptDigest: receiptDigest,
    amountMinor,
    budgetMinor: amountMinor,
    currency,
  })
}

function matchesQuery(listing: CatalogListing, query: string): boolean {
  if (!query) return true
  const needle = query.toLocaleLowerCase('en-US')
  return [listing.title, listing.summary, listing.category, listing.agentId]
    .some((value) => value.toLocaleLowerCase('en-US').includes(needle))
}

async function establishSession(fetcher: typeof fetch, sessionPath: string): Promise<boolean> {
  const session = await fetcher(sessionPath, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'storefront-checkout-preparation' }),
  })
  return session.ok
}

function readIdentifier(value: unknown): string {
  const text = readBoundedText(value, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(text)) throw new Error('catalog_identifier_invalid')
  return text
}

function readBoundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string'
    || value !== value.trim()
    || value.length > maximum
    || (!allowEmpty && value.length === 0)) throw new Error('catalog_text_invalid')
  return value
}

function readPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('catalog_amount_invalid')
  return Number(value)
}

function readFailureCode(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.code === 'string' && /^[a-z0-9_:-]{1,128}$/u.test(value.code)
    ? value.code
    : fallback
}

function locationBase(): string {
  const location = Reflect.get(globalThis, 'location')
  return location && typeof location === 'object' && typeof Reflect.get(location, 'href') === 'string'
    ? String(Reflect.get(location, 'href'))
    : 'https://storefront.invalid/'
}

function relativeWhenSameOrigin(url: URL): string {
  const base = new URL(locationBase())
  return url.origin === base.origin ? `${url.pathname}${url.search}` : url.toString()
}

function merchantIdFromCatalogPath(path: string): string | null {
  const match = new URL(path, locationBase()).pathname.match(/^\/v1\/public\/merchants\/([^/]+)\/catalog$/u)
  if (!match?.[1]) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}
