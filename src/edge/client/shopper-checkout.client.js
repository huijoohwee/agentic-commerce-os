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
  if (!selectedOffer || checkoutPreparing || checkoutConfirming) return;
  checkoutButton.disabled = true; checkoutButton.textContent = 'Preparing your review…';
  try {
    const result = await actions.initiateCheckout({ offerId: selectedOffer.offerId, amountMinor: selectedOffer.amountMinor, currency: selectedOffer.currency });
    checkoutButton.textContent = result.ok ? 'Awaiting human confirmation' : 'Try checkout again';
    if (!result.ok) document.querySelector('#offer-selection').textContent = 'Checkout unavailable. ' + result.code;
    checkoutButton.disabled = result.ok || !navigator.onLine;
  } catch {
    checkoutButton.textContent = 'Try checkout again'; checkoutButton.disabled = !navigator.onLine;
    document.querySelector('#offer-selection').textContent = 'We couldn’t prepare checkout. Please try again.';
  }
});

const renderHumanConfirmation = () => {
  if (!preparedConfirmation) {
    confirmationRegion.hidden = true;
    return;
  }
  document.querySelector('#confirmation-reference').hidden = true;
  document.querySelector('#confirmation-expiry-label').textContent = 'Review expires';
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
  selectedOffer = null; selectedListingId = null;
  confirmationSummary.textContent = 'Checkout confirmed.';
  const reference = document.querySelector('#confirmation-reference');
  reference.textContent = 'Reference: ' + proof.checkoutId; reference.hidden = false;
  document.querySelector('#confirmation-expiry-label').textContent = 'Review status';
  resultsRegion.querySelectorAll('button[data-offer]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  confirmationExpiry.textContent = 'Completed';
  checkoutButton.disabled = true;
  document.querySelector('#offer-selection').textContent = 'Checkout confirmed. Choose another offer to start a new checkout.';
  confirmButton.disabled = true;
  confirmButton.textContent = 'Confirmed';
  return { ok: true };
};

confirmButton.addEventListener('click', async () => {
  if (checkoutConfirming) return;
  checkoutConfirming = true; confirmButton.disabled = true;
  const selectionControls = [...searchForm.querySelectorAll('input, button'), ...resultsRegion.querySelectorAll('button[data-offer]')];
  selectionControls.forEach(control => { control.disabled = true; });
  try {
    const result = await confirmPreparedCheckout();
    if (!result.ok && preparedConfirmation) {
      if (result.code === 'offer_reconfirmation_required') renderHumanConfirmation();
      else confirmationSummary.textContent = result.code === 'human_presence_adapter_unavailable'
        ? 'A trusted human-presence adapter is required before this checkout can settle.'
        : 'Confirmation unavailable. Review this checkout before trying again.';
    }
  } catch {
    confirmationSummary.textContent = 'We couldn’t verify the result. You can retry this same checkout to confirm its outcome.';
  } finally {
    checkoutConfirming = false;
    selectionControls.forEach(control => { control.disabled = false; });
    confirmButton.disabled = !navigator.onLine || !preparedConfirmation;
  }
});
