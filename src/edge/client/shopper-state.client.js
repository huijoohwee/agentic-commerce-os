const catalogPath = document.querySelector('meta[name="ag-catalog-path"]')?.content || '/v1/public/agents';
const runtimeBasePath = document.querySelector('meta[name="ag-runtime-base-path"]')?.content || '';
const runtimePath = path => runtimeBasePath + path;
const searchForm = document.querySelector('#catalog-search');
const searchInput = document.querySelector('#catalog-query');
const resultsRegion = document.querySelector('#catalog-results');
const checkoutButton = document.querySelector('#initiate-checkout');
const confirmationRegion = document.querySelector('#checkout-confirmation');
const confirmationSummary = document.querySelector('#checkout-confirmation-summary');
const confirmationOffer = document.querySelector('#confirmation-offer');
const confirmationTotal = document.querySelector('#confirmation-total');
const confirmationExpiry = document.querySelector('#confirmation-expiry');
const confirmButton = document.querySelector('#confirm-checkout');
const offlineIndicator = document.querySelector('#offline-indicator');
const merchantMatch = catalogPath.match(/\/v1\/public\/merchants\/([^/?]+)\/catalog(?:\?|$)/);
const merchantId = merchantMatch ? decodeURIComponent(merchantMatch[1]) : null;
let catalog = [];
let selectedOffer = null;
let selectedListingId = null;
let preparedConfirmation = null;
let replayInFlight = null;
let checkoutPreparing = false;
let checkoutConfirming = false;
let searchGeneration = 0;

const deviceId = (() => {
  try {
    const key = 'agentic-commerce-device-id';
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
})();



const readSnapshot = async () => {
  const database = await openDatabase();
  const transaction = database.transaction('completed-sync', 'readonly');
  const snapshot = await requestResult(transaction.objectStore('completed-sync').get('storefront'));
  await transactionDone(transaction);
  database.close();
  return snapshot?.catalogPath === catalogPath ? snapshot : null;
};

const saveSnapshot = async value => {
  const database = await openDatabase();
  const transaction = database.transaction('completed-sync', 'readwrite');
  transaction.objectStore('completed-sync').put({ scope: 'storefront', catalogPath, value, completedAtMs: Date.now() });
  await transactionDone(transaction);
  database.close();
};

const recordLocalEvent = async payload => {
  const database = await openDatabase();
  const transaction = database.transaction('pending-changes', 'readwrite');
  const store = transaction.objectStore('pending-changes');
  const count = await requestResult(store.count());
  if (count >= 500) {
    await transactionDone(transaction);
    database.close();
    return { ok: false, code: 'local_change_capacity_reached', retained: count };
  }
  const sequence = await requestResult(store.add({
    scope: 'storefront', payload, recordedAtMs: Date.now()
  }));
  await transactionDone(transaction);
  database.close();
  return { ok: true, sequence };
};

const readPendingChanges = async () => {
  const database = await openDatabase();
  const transaction = database.transaction('pending-changes', 'readonly');
  const changes = await requestResult(transaction.objectStore('pending-changes').getAll());
  await transactionDone(transaction);
  database.close();
  return changes.sort((left, right) => left.sequence - right.sequence);
};

const deletePendingChange = async sequence => {
  const database = await openDatabase();
  const transaction = database.transaction('pending-changes', 'readwrite');
  transaction.objectStore('pending-changes').delete(sequence);
  await transactionDone(transaction);
  database.close();
};

const replayPendingChanges = () => {
  if (replayInFlight) return replayInFlight;
  replayInFlight = (async () => {
    if (!navigator.onLine || !await establishSession()) return;
    const changes = await readPendingChanges();
    for (const change of changes) {
      const response = await fetch(runtimePath('/v1/sync/merge'), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base: { fields: [], eventLog: [] },
          left: [{
            scope: change.scope,
            field: 'event/' + change.sequence,
            value: change.payload,
            origin: { deviceId, sequence: change.sequence, recordedAtMs: change.recordedAtMs }
          }],
          right: []
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !acceptedMerge(payload, change)) break;
      await deletePendingChange(change.sequence);
    }
  })().catch(() => undefined).finally(() => { replayInFlight = null; });
  return replayInFlight;
};

const showOffline = async () => {
  offlineIndicator.hidden = false;
  checkoutButton.disabled = true;
  confirmButton.disabled = true;
  const snapshot = await readSnapshot().catch(() => null);
  offlineIndicator.textContent = snapshot ? 'Offline — showing the last completed synchronization. Settlement is unavailable.' : 'Offline — no saved catalog for this storefront. Connect to load offers.';
  if (snapshot?.value?.listings) {
    catalog = snapshot.value.listings;
    renderCatalog(catalog);
  }
};

const showOnline = () => {
  offlineIndicator.hidden = true;
  checkoutButton.disabled = !selectedOffer;
  confirmButton.disabled = !preparedConfirmation;
};

const validChangeOrigin = value => value && typeof value === 'object'
  && Object.keys(value).sort().join(',') === 'deviceId,recordedAtMs,sequence'
  && typeof value.deviceId === 'string'
  && Number.isSafeInteger(value.sequence) && value.sequence >= 0
  && Number.isSafeInteger(value.recordedAtMs) && value.recordedAtMs >= 0;

const validFieldChange = value => value && typeof value === 'object'
  && Object.keys(value).sort().join(',') === 'field,origin,scope,value'
  && typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 256
  && typeof value.field === 'string' && value.field.length > 0 && value.field.length <= 256
  && validChangeOrigin(value.origin);

const acceptedMerge = (payload, change) => {
  if (payload?.ok !== true || !payload.state || typeof payload.state !== 'object'
    || Object.keys(payload.state).sort().join(',') !== 'eventLog,fields'
    || !Array.isArray(payload.state.fields) || !payload.state.fields.every(validFieldChange)
    || !Array.isArray(payload.state.eventLog) || !payload.state.eventLog.every(validFieldChange)) return false;
  return payload.state.eventLog.some(entry => entry.scope === change.scope
    && entry.field === 'event/' + change.sequence
    && entry.origin.deviceId === deviceId
    && entry.origin.sequence === change.sequence
    && entry.origin.recordedAtMs === change.recordedAtMs
    && canonical(entry.value) === canonical(change.payload));
};

const parseCatalog = payload => {
  const values = Array.isArray(payload?.listings) ? payload.listings : Array.isArray(payload?.agents) ? payload.agents : [];
  return values.map(value => ({
    listingId: String(value.listingId || value.agentId || ''),
    agentId: String(value.owningAgentId || value.agentId || ''),
    category: String(value.category || value.declaredCategory || ''),
    title: String(value.title || value.agentId || value.owningAgentId || ''),
    summary: String(value.summary || ''),
    offers: Array.isArray(value.offers) ? value.offers.filter(offer => offer && typeof offer.offerId === 'string'
      && Number.isSafeInteger(offer.amountMinor) && offer.amountMinor >= 0 && /^[A-Z]{3}$/.test(offer.currency)) : []
  })).filter(value => value.listingId && value.agentId && value.category);
};

const establishSession = async () => {
  const session = await fetch(runtimePath('/v1/session'), {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'storefront-checkout-preparation' })
  });
  return session.ok;
};

const discoveredUnavailability = (scoped, code) => scoped.map(listing => ({
  ...listing,
  offers: [],
  checkoutAvailability: { ok: false, code }
}));

const discoverOffers = async (scoped, query) => {
  if (scoped.some(listing => listing.offers.length > 0)) return scoped;
  const target = scoped[0];
  if (!target || !await establishSession()) return discoveredUnavailability(scoped, 'offer_discovery_unavailable');
  const intentId = 'intent-' + crypto.randomUUID();
  const response = await fetch(runtimePath('/v1/intents/route'), {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId, category: target.category, constraints: { query },
      ...(merchantId ? { merchantId, listingId: target.listingId } : {})
    })
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || typeof payload.agentId !== 'string') {
    return discoveredUnavailability(scoped, 'offer_discovery_unavailable');
  }
  const listing = scoped.find(value => value.agentId === payload.agentId);
  const offers = Array.isArray(payload?.result?.offers) ? payload.result.offers : [];
  if (!listing || !offers.length) return discoveredUnavailability(scoped, 'routed_agent_outside_catalog');
  const validated = offers.filter(offer => offer.intentId === intentId && offer.agentId === listing.agentId)
    .map(offer => ({
      offerId: offer.offerId,
      intentId,
      agentId: listing.agentId,
      offerReceiptDigest: offer.receiptDigest,
      amountMinor: offer.amountMinor,
      budgetMinor: offer.amountMinor,
      currency: offer.currency
    }));
  return validated.length
    ? scoped.map(value => value.listingId === listing.listingId ? { ...value, offers: validated } : value)
    : discoveredUnavailability(scoped, 'offer_discovery_invalid');
};
