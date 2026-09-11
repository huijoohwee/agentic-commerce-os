const actions = Object.freeze({
  async searchCatalog({ query, limit }, options = {}) {
    options.signal?.throwIfAborted();
    if (checkoutPreparing || checkoutConfirming) throw new Error('checkout_preparation_in_progress');
    const generation = ++searchGeneration;
    limit = Math.max(1, Math.min(100, Number(limit) || 20));
    if (!navigator.onLine) {
      await showOffline();
      throw new Error('connectivity_absent');
    }
    const url = new URL(catalogPath, location.href);
    url.searchParams.set('query', String(query).slice(0, 280));
    url.searchParams.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 20))));
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', signal: options.signal });
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
    const discovered = options.discover === false ? scoped : await discoverOffers(scoped, query);
    options.signal?.throwIfAborted();
    if (generation !== searchGeneration || checkoutPreparing || checkoutConfirming) throw new Error('catalog_search_superseded');
    catalog = discovered;
    selectedOffer = null; selectedListingId = null; preparedConfirmation = null;
    confirmationRegion.hidden = true;
    checkoutButton.textContent = 'Review checkout';
    document.querySelector('#offer-selection').textContent = 'Choose an offer to review its total.';
    const page = { ok: true, query, limit, listings: catalog };
    await saveSnapshot(page);
    showOnline();
    renderCatalog(catalog);
    return page;
  },
  async selectOffer({ listingId, offerId }, options = {}) {
    options.signal?.throwIfAborted();
    if (checkoutPreparing || checkoutConfirming) throw new Error('checkout_preparation_in_progress');
    const generation = searchGeneration;
    const listing = catalog.find(value => value.listingId === listingId);
    const offer = listing?.offers.find(value => value.offerId === offerId);
    if (!offer) throw new Error('offer_not_found');
    const recorded = await recordLocalEvent({ type: 'offer_selected', listingId, offerId });
    if (!recorded.ok) return recorded;
    options.signal?.throwIfAborted();
    if (generation !== searchGeneration || checkoutPreparing || checkoutConfirming) throw new Error('offer_selection_drift');
    selectedOffer = offer;
    selectedListingId = listingId;
    preparedConfirmation = null;
    confirmationRegion.hidden = true;
    checkoutButton.disabled = !navigator.onLine;
    document.querySelector('#offer-selection').textContent = listing.title + ' · ' + formatMinorCurrency(offer.amountMinor, offer.currency);
    resultsRegion.querySelectorAll('button[data-offer]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.offer === offerId && button.dataset.listing === listingId));
    });
    return {
      ok: true,
      listingId,
      offerId,
      amountMinor: offer.amountMinor,
      currency: offer.currency
    };
  },
  async initiateCheckout({ offerId, amountMinor, currency }, options = {}) {
    options.signal?.throwIfAborted();
    if (checkoutPreparing || checkoutConfirming || preparedConfirmation) return { ok: false, code: 'checkout_already_prepared' };
    checkoutPreparing = true;
    try {
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
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, signal: options.signal,
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
    } finally { checkoutPreparing = false; }
  }
});
