import { WEBMCP_CLIENT_RUNTIME } from './webmcp-runtime.js'

export const STOREFRONT_CLIENT_MODULE = String.raw`
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

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('agentic-commerce-storefront', 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('completed-sync')) {
      database.createObjectStore('completed-sync', { keyPath: 'scope' });
    }
    if (!database.objectStoreNames.contains('pending-changes')) {
      database.createObjectStore('pending-changes', { keyPath: 'sequence', autoIncrement: true });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
});

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error('indexeddb_transaction_failed'));
  transaction.onabort = () => reject(transaction.error || new Error('indexeddb_transaction_aborted'));
});

const readSnapshot = async () => {
  const database = await openDatabase();
  const transaction = database.transaction('completed-sync', 'readonly');
  const snapshot = await requestResult(transaction.objectStore('completed-sync').get('storefront'));
  await transactionDone(transaction);
  database.close();
  return snapshot || null;
};

const saveSnapshot = async value => {
  const database = await openDatabase();
  const transaction = database.transaction('completed-sync', 'readwrite');
  transaction.objectStore('completed-sync').put({ scope: 'storefront', value, completedAtMs: Date.now() });
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
    offers: Array.isArray(value.offers) ? value.offers : []
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

const actions = Object.freeze({
  async searchCatalog({ query, limit }) {
    if (!navigator.onLine) {
      await showOffline();
      throw new Error('connectivity_absent');
    }
    const url = new URL(catalogPath, location.href);
    url.searchParams.set('query', String(query).slice(0, 280));
    url.searchParams.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 20))));
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin' });
    } catch (error) {
      await showOffline();
      throw error;
    }
    if (!response.ok) throw new Error('catalog_unavailable');
    const allListings = parseCatalog(await response.json());
    const normalizedQuery = String(query).toLocaleLowerCase('en-US');
    const scoped = allListings.filter(listing => !normalizedQuery || [
      listing.title, listing.summary, listing.category, listing.agentId
    ].some(value => value.toLocaleLowerCase('en-US').includes(normalizedQuery))).slice(0, limit);
    catalog = await discoverOffers(scoped, query);
    const page = { ok: true, query, limit, listings: catalog };
    await saveSnapshot(page);
    showOnline();
    return page;
  },
  async selectOffer({ listingId, offerId }) {
    const listing = catalog.find(value => value.listingId === listingId);
    const offer = listing?.offers.find(value => value.offerId === offerId);
    if (!offer) throw new Error('offer_not_found');
    const recorded = await recordLocalEvent({ type: 'offer_selected', listingId, offerId });
    if (!recorded.ok) return recorded;
    selectedOffer = offer;
    selectedListingId = listingId;
    preparedConfirmation = null;
    confirmationRegion.hidden = true;
    checkoutButton.disabled = !navigator.onLine;
    return {
      ok: true,
      listingId,
      offerId,
      amountMinor: offer.amountMinor,
      currency: offer.currency
    };
  },
  async initiateCheckout({ offerId, amountMinor, currency }) {
    if (!navigator.onLine) return { ok: false, code: 'connectivity_absent' };
    if (!selectedOffer || selectedListingId === null || selectedOffer.offerId !== offerId) {
      return { ok: false, code: 'offer_selection_required' };
    }
    if (selectedOffer.amountMinor !== amountMinor || selectedOffer.currency !== currency) {
      return { ok: false, code: 'offer_selection_drift' };
    }
    if (!await establishSession()) return { ok: false, code: 'storefront_session_unavailable' };
    const checkoutId = 'checkout-' + crypto.randomUUID();
    const response = await fetch(runtimePath('/v1/checkouts/' + encodeURIComponent(checkoutId) + '/prepare'), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        checkoutId,
        intentId: selectedOffer.intentId,
        agentId: selectedOffer.agentId,
        offerId: selectedOffer.offerId,
        offerReceiptDigest: selectedOffer.offerReceiptDigest,
        amountMinor: selectedOffer.amountMinor,
        budgetMinor: selectedOffer.budgetMinor || selectedOffer.amountMinor,
        currency: selectedOffer.currency
      })
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) return { ok: false, code: payload?.code || 'checkout_prepare_failed' };
    if (typeof payload?.humanConfirmation?.csrfToken !== 'string'
      || typeof payload?.humanConfirmation?.expiresAt !== 'string'
      || typeof payload?.humanConfirmation?.challenge !== 'string'
      || typeof payload?.humanConfirmation?.sessionNonceDigest !== 'string'
      || typeof payload?.humanConfirmation?.blockerDigest !== 'string'
      || payload?.humanConfirmation?.audience !== 'agentic-graph-commerce-checkout'
      || payload?.humanConfirmation?.relyingPartyOrigin !== globalThis.location.origin
      || typeof payload?.humanConfirmation?.verificationMode !== 'string') {
      return { ok: false, code: 'human_confirmation_proof_unavailable' };
    }
    preparedConfirmation = {
      checkoutId,
      csrfToken: payload.humanConfirmation.csrfToken,
      expiresAt: payload.humanConfirmation.expiresAt,
      offerId: selectedOffer.offerId,
      amountMinor: selectedOffer.amountMinor,
      currency: selectedOffer.currency,
      blockerDigest: payload.humanConfirmation.blockerDigest,
      audience: payload.humanConfirmation.audience,
      relyingPartyOrigin: payload.humanConfirmation.relyingPartyOrigin,
      blockers: Array.isArray(payload.humanConfirmation.blockers) ? payload.humanConfirmation.blockers : [],
      challenge: payload.humanConfirmation.challenge,
      sessionNonceDigest: payload.humanConfirmation.sessionNonceDigest,
      verificationMode: payload.humanConfirmation.verificationMode,
      presenceIssuer: payload.humanConfirmation.presenceIssuer || null
    };
    renderHumanConfirmation();
    return { ok: true, checkoutId, state: 'awaiting-human-confirmation' };
  }
});

const renderCatalog = listings => {
  resultsRegion.replaceChildren();
  if (!listings.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No matching listings.';
    resultsRegion.append(empty);
    return;
  }
  for (const listing of listings) {
    const article = document.createElement('article');
    article.className = 'listing';
    const heading = document.createElement('h3');
    heading.textContent = listing.title;
    const summary = document.createElement('p');
    summary.textContent = listing.summary;
    article.append(heading, summary);
    if (!listing.offers.length) {
      const unavailable = document.createElement('p');
      unavailable.className = 'hint';
      unavailable.textContent = 'Checkout unavailable: no verified offer is reachable within this storefront scope.';
      article.append(unavailable);
    }
    for (const offer of listing.offers) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Select ' + offer.offerId;
      button.setAttribute('aria-label', 'Select offer ' + offer.offerId + ' from ' + listing.title);
      button.addEventListener('click', async () => {
        const selection = await actions.selectOffer({ listingId: listing.listingId, offerId: offer.offerId });
        if (!selection.ok) {
          resultsRegion.setAttribute('data-selection-error', selection.code);
          return;
        }
        resultsRegion.querySelectorAll('button').forEach(candidate => candidate.removeAttribute('aria-pressed'));
        button.setAttribute('aria-pressed', 'true');
      });
      article.append(button);
    }
    resultsRegion.append(article);
  }
};

searchForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const page = await actions.searchCatalog({ query: searchInput.value.trim(), limit: 20 });
    renderCatalog(page.listings);
  } catch (error) {
    if (navigator.onLine) resultsRegion.textContent = 'Catalog is temporarily unavailable.';
  }
});

const formatMinorCurrency = (amountMinor, currency) => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('currency_amount_invalid');
  }
  const currencyFormatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });
  const resolved = currencyFormatter.resolvedOptions();
  const exponent = resolved.maximumFractionDigits;
  if (resolved.minimumFractionDigits !== exponent || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error('currency_exponent_unsupported');
  }
  const scale = 10n ** BigInt(exponent);
  const amount = BigInt(amountMinor);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(exponent, '0');
  const integerParts = new Intl.NumberFormat(undefined, {
    useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 0
  }).formatToParts(whole).filter(part => part.type === 'integer' || part.type === 'group');
  const templateValue = exponent === 0 ? 1 : 1 + (1 / Number(scale));
  const template = currencyFormatter.formatToParts(templateValue);
  let insertedInteger = false;
  return template.flatMap(part => {
    if (part.type === 'integer' || part.type === 'group') {
      if (insertedInteger) return [];
      insertedInteger = true;
      return integerParts;
    }
    if (part.type === 'fraction') return [{ ...part, value: fraction }];
    return [part];
  }).map(part => part.value).join('');
};

const readableEvidenceValue = value => {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return String(rendered ?? 'unknown').slice(0, 160);
};

const blockerSummary = blockers => blockers.map(blocker => {
  const evidence = blocker && typeof blocker.evidence === 'object' ? blocker.evidence : {};
  if (blocker?.eventType === 'offer_changed') {
    return String(evidence.attribute || 'offer') + ' changed from '
      + readableEvidenceValue(evidence.recordedValue) + ' to ' + readableEvidenceValue(evidence.observedValue) + '.';
  }
  if (blocker?.eventType === 'offer_observation_suspended') {
    return 'Offer monitoring was suspended after ' + readableEvidenceValue(evidence.attempts) + ' failed observations.';
  }
  if (blocker?.eventType === 'offer_agent_inactive') return 'The originating offer agent is inactive.';
  return 'A checkout blocker changed and requires a fresh review.';
}).join(' ');

const requestHumanPresenceReceipt = async proof => {
  if (proof.verificationMode === 'development-visual-only') return undefined;
  const adapter = globalThis.agenticGraphHumanPresence;
  if (!adapter || typeof adapter.authorize !== 'function') return null;
  const receipt = await adapter.authorize(Object.freeze({
    schema: 'agentic-graph-human-presence-request/v2',
    issuer: proof.presenceIssuer,
    audience: proof.audience,
    relyingPartyOrigin: proof.relyingPartyOrigin,
    challenge: proof.challenge,
    sessionNonceDigest: proof.sessionNonceDigest,
    checkoutId: proof.checkoutId,
    offerId: proof.offerId,
    amountMinor: proof.amountMinor,
    currency: proof.currency,
    blockerDigest: proof.blockerDigest,
    blockers: Object.freeze([...proof.blockers]),
    expiresAt: proof.expiresAt
  }));
  return receipt && typeof receipt === 'object' ? receipt : null;
};

checkoutButton.addEventListener('click', async () => {
  if (!selectedOffer) return;
  const result = await actions.initiateCheckout({
    offerId: selectedOffer.offerId,
    amountMinor: selectedOffer.amountMinor,
    currency: selectedOffer.currency
  });
  checkoutButton.textContent = result.ok ? 'Awaiting human confirmation' : 'Checkout unavailable';
  checkoutButton.disabled = true;
});

const renderHumanConfirmation = () => {
  if (!preparedConfirmation) {
    confirmationRegion.hidden = true;
    return;
  }
  confirmationOffer.textContent = preparedConfirmation.offerId;
  confirmationTotal.textContent = formatMinorCurrency(
    preparedConfirmation.amountMinor,
    preparedConfirmation.currency
  );
  confirmationExpiry.textContent = new Date(preparedConfirmation.expiresAt).toLocaleString();
  confirmationSummary.textContent = preparedConfirmation.blockers.length
    ? blockerSummary(preparedConfirmation.blockers)
    : 'This action can settle the checkout. Review the offer and total before confirming.';
  confirmButton.textContent = preparedConfirmation.blockers.length
    ? 'Confirm changed offer'
    : 'Confirm checkout';
  confirmButton.disabled = !navigator.onLine;
  confirmationRegion.hidden = false;
  confirmationRegion.focus?.();
};

const confirmPreparedCheckout = async () => {
  if (!preparedConfirmation || !navigator.onLine) return { ok: false, code: 'connectivity_absent' };
  const proof = preparedConfirmation;
  const presenceReceipt = await requestHumanPresenceReceipt(proof).catch(() => null);
  if (proof.verificationMode !== 'development-visual-only' && !presenceReceipt) {
    return { ok: false, code: 'human_presence_adapter_unavailable' };
  }
  const response = await fetch(runtimePath('/v1/human/checkouts/' + encodeURIComponent(proof.checkoutId) + '/confirm'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-human-confirmation-csrf': proof.csrfToken
    },
    body: JSON.stringify({
      checkoutId: proof.checkoutId,
      offerId: proof.offerId,
      amountMinor: proof.amountMinor,
      currency: proof.currency,
      blockerDigest: proof.blockerDigest,
      ...(presenceReceipt ? { presenceReceipt } : {})
    })
  });
  const payload = await response.json().catch(() => ({ ok: false, code: 'checkout_confirmation_failed' }));
  if (payload?.code === 'offer_reconfirmation_required'
    && typeof payload?.humanConfirmation?.csrfToken === 'string'
    && typeof payload?.humanConfirmation?.expiresAt === 'string'
    && typeof payload?.humanConfirmation?.challenge === 'string'
    && typeof payload?.humanConfirmation?.sessionNonceDigest === 'string'
    && typeof payload?.humanConfirmation?.blockerDigest === 'string'
    && payload?.humanConfirmation?.audience === 'agentic-graph-commerce-checkout'
    && payload?.humanConfirmation?.relyingPartyOrigin === globalThis.location.origin
    && Array.isArray(payload?.humanConfirmation?.blockers)) {
    preparedConfirmation = {
      ...proof,
      csrfToken: payload.humanConfirmation.csrfToken,
      expiresAt: payload.humanConfirmation.expiresAt,
      challenge: payload.humanConfirmation.challenge,
      sessionNonceDigest: payload.humanConfirmation.sessionNonceDigest,
      blockerDigest: payload.humanConfirmation.blockerDigest,
      audience: payload.humanConfirmation.audience,
      relyingPartyOrigin: payload.humanConfirmation.relyingPartyOrigin,
      blockers: payload.humanConfirmation.blockers,
      verificationMode: payload.humanConfirmation.verificationMode,
      presenceIssuer: payload.humanConfirmation.presenceIssuer || proof.presenceIssuer
    };
    renderHumanConfirmation();
    return { ok: false, code: payload.code };
  }
  if (!response.ok || payload?.ok !== true) return { ok: false, code: payload?.code || 'checkout_confirmation_failed' };
  preparedConfirmation = null;
  confirmationSummary.textContent = 'Checkout confirmed.';
  confirmationOffer.textContent = '';
  confirmationTotal.textContent = '';
  confirmationExpiry.textContent = '';
  confirmButton.disabled = true;
  confirmButton.textContent = 'Confirmed';
  return { ok: true };
};

confirmButton.addEventListener('click', async () => {
  confirmButton.disabled = true;
  const result = await confirmPreparedCheckout();
  if (!result.ok && preparedConfirmation) {
    if (result.code === 'offer_reconfirmation_required') renderHumanConfirmation();
    else confirmationSummary.textContent = result.code === 'human_presence_adapter_unavailable'
        ? 'A trusted human-presence adapter is required before this checkout can settle.'
        : 'Confirmation unavailable. No settlement was accepted.';
    confirmButton.disabled = !navigator.onLine;
  }
});

${WEBMCP_CLIENT_RUNTIME}

window.addEventListener('offline', () => void showOffline());
window.addEventListener('online', () => {
  showOnline();
  void replayPendingChanges();
});
if (!navigator.onLine) void showOffline();
else void replayPendingChanges();
void registerWebMcp();
`
