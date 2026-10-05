import { STRIPE_ACCOUNT, LIVE_CHECKOUT_OFFER, LIVE_CHECKOUT_PROFILE_SHA256, checkoutOffer, type CheckoutMode } from './checkout-offer.ts';
import { isHttpFailure, isRecord, readJsonResponse } from '../shared/http.ts';
import type { FulfillmentBinding } from './fulfillment-contract.ts';
export type PaymentFetch = (request: Request) => Promise<Response>;
export type StripeSession = { id: string; url: string | null; status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required'; amount_total: number; currency: string; livemode: boolean; entitlementReady?: boolean;
  fulfillment?: FulfillmentBinding };
export const stripeTestKey = (value: unknown): value is string => typeof value === 'string' && /^(?:sk|rk)_test_[A-Za-z0-9]{20,}$/u.test(value);
export const stripeLiveKey = (value: unknown): value is string => typeof value === 'string' && /^(?:sk|rk)_live_[A-Za-z0-9]{20,}$/u.test(value);
export function hostedUrl(value: unknown, id: string): value is string {
  if (typeof value !== 'string' || value.length > 1800) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
    && !url.port && !url.username && !url.password && !url.search && ['/c/pay/' + id, '/g/pay/' + id].includes(url.pathname); }
  catch { return false; }
}
export function stripeClient(secret: string, transport: PaymentFetch = fetch, mode: CheckoutMode = 'sandbox') {
  const live = mode === 'live', offer = checkoutOffer(mode);
  if (!(live ? stripeLiveKey(secret) : stripeTestKey(secret))) throw Error('stripe_mode_key_required');
  async function request(path: string, body?: URLSearchParams, idempotencyKey?: string) {
    const headers = new Headers({ authorization: 'Bearer ' + secret, 'stripe-version': '2026-06-24.dahlia' });
    if (body) headers.set('content-type', 'application/x-www-form-urlencoded');
    if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
    const response = await transport(new Request('https://api.stripe.com/v1/' + path, {
      method: body ? 'POST' : 'GET', headers, ...(body ? { body: body.toString() } : {}),
      signal: AbortSignal.timeout(15000), redirect: 'manual',
    }));
    const value = await readJsonResponse(response, 65536);
    if (!response.ok || isHttpFailure(value) || !isRecord(value)) throw Error('stripe_test_unavailable');
    return value;
  }
  function validate(value: Record<string, unknown>, nonce: string, id?: string, fulfillment?: FulfillmentBinding): StripeSession {
    if (typeof value.id !== 'string' || !(live ? /^cs_live_[A-Za-z0-9]{16,200}$/u : /^cs_test_[A-Za-z0-9]{16,200}$/u).test(value.id) || id && value.id !== id
      || value.livemode !== live || value.mode !== 'payment' || value.client_reference_id !== nonce
      || !isRecord(value.metadata) || value.metadata.offer_id !== offer.id || value.metadata.owner !== 'agentic-commerce-os'
      || value.metadata.fulfillment_run !== fulfillment?.runId || value.metadata.fulfillment_digest !== fulfillment?.outputDigest
      || value.amount_total !== offer.amountMinor || value.currency !== offer.currency
      || !['open', 'complete', 'expired'].includes(String(value.status))
      || !['paid', 'unpaid', 'no_payment_required'].includes(String(value.payment_status))
      || value.status === 'open' && !hostedUrl(value.url, value.id)) throw Error('stripe_test_identity_mismatch');
    if (live && (fulfillment || value.metadata.mode !== 'live' || value.metadata.profile_digest !== LIVE_CHECKOUT_PROFILE_SHA256
      || value.metadata.asset_digest !== LIVE_CHECKOUT_OFFER.assetDigest || value.metadata.product_id !== LIVE_CHECKOUT_OFFER.productId
      || value.metadata.account_id !== STRIPE_ACCOUNT || value.metadata.fulfillment_run !== undefined
      || value.metadata.fulfillment_digest !== undefined)) throw Error('stripe_live_identity_mismatch');
    return { id: value.id, livemode: live, amount_total: offer.amountMinor, currency: offer.currency,
      url: value.status === 'open' ? String(value.url) : null, status: value.status as StripeSession['status'],
      payment_status: value.payment_status as StripeSession['payment_status'],
      ...(live ? { entitlementReady: value.metadata.entitlement_digest === LIVE_CHECKOUT_OFFER.assetDigest } : {}), ...(fulfillment ? { fulfillment } : {}) };
  }
  async function accountReady(requireSales: boolean) {
    const account = await request('account');
    if (account.id !== STRIPE_ACCOUNT || live && requireSales && account.charges_enabled !== true) throw Error('stripe_account_unavailable');
    return account;
  }
  async function liveRead(id: string, nonce?: string) {
    if (!/^cs_live_[A-Za-z0-9]{16,200}$/u.test(id)) throw Error('stripe_live_session_invalid');
    await accountReady(false);
    const raw = await request('checkout/sessions/' + id);
    const owner = nonce ?? raw.client_reference_id;
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(owner)) throw Error('stripe_live_owner_invalid');
    const session = validate(raw, owner, id);
    const lines = await request('checkout/sessions/' + id + '/line_items?limit=2');
    const line = Array.isArray(lines.data) && lines.data.length === 1 ? lines.data[0] : null;
    if (lines.has_more !== false || !isRecord(line) || line.quantity !== 1 || line.amount_total !== offer.amountMinor
      || line.amount_subtotal !== offer.amountMinor || line.currency !== offer.currency || !isRecord(line.price)
      || line.price.id !== offer.id || line.price.product !== LIVE_CHECKOUT_OFFER.productId || line.price.livemode !== true
      || line.price.unit_amount !== offer.amountMinor || line.price.currency !== offer.currency)
      throw Error('stripe_live_line_item_mismatch');
    return { session, nonce: owner };
  }
  return {
    async verifyOffer(requireSales = true) {
      const [account, price] = await Promise.all([accountReady(requireSales), request('prices/' + offer.id)]);
      if (price.id !== offer.id || price.livemode !== live || requireSales && price.active !== true || price.unit_amount !== offer.amountMinor
        || price.currency !== offer.currency || price.type !== 'one_time'
        || live && price.product !== LIVE_CHECKOUT_OFFER.productId) throw Error('stripe_offer_mismatch');
      return { accountId: account.id, priceId: price.id, amountMinor: price.unit_amount, currency: price.currency, livemode: live,
        ...(live ? {salesCapable:account.charges_enabled === true && price.active === true} : {}) };
    },
    async fulfill(id: string) {
      if (!live) throw Error('live_entitlement_required');
      const { session, nonce } = await liveRead(id);
      if (session.status !== 'complete' || session.payment_status !== 'paid') throw Error('stripe_paid_required');
      if (session.entitlementReady) return session;
      // Stripe owns entitlement; retries write the same verified asset digest.
      const form = new URLSearchParams({ 'metadata[entitlement_digest]': LIVE_CHECKOUT_OFFER.assetDigest });
      const updated = validate(await request('checkout/sessions/' + id, form,
        'commerce-live-entitlement:' + id + ':' + LIVE_CHECKOUT_OFFER.assetDigest), nonce, id);
      if (!updated.entitlementReady || updated.status !== 'complete' || updated.payment_status !== 'paid')
        throw Error('stripe_entitlement_unavailable');
      return updated;
    },
    async create(nonce: string, origin: string, fulfillment?: FulfillmentBinding, separateOrder = false) {
      if (live && (fulfillment || separateOrder)) throw Error('live_education_only');
      if (separateOrder && !fulfillment) throw Error('separate_order_requires_fulfillment');
      // Re-read the exact account and price before creating Checkout.
      const [account, price] = await Promise.all([accountReady(true), request('prices/' + offer.id)]);
      if (account.id !== STRIPE_ACCOUNT || price.id !== offer.id || price.livemode !== live || price.active !== true
        || price.unit_amount !== offer.amountMinor || price.currency !== offer.currency || price.type !== 'one_time'
        || live && price.product !== LIVE_CHECKOUT_OFFER.productId) throw Error('stripe_test_offer_mismatch');
      const back = origin + '/agentic-commerce-os/?checkout=return#checkout';
      const form = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': offer.id,
        'line_items[0][quantity]': '1', 'payment_method_types[0]': 'card',
        'adaptive_pricing[enabled]': 'false', success_url: back, cancel_url: back,
        client_reference_id: nonce, 'metadata[offer_id]': offer.id, 'metadata[owner]': 'agentic-commerce-os',
        'metadata[mode]': mode, 'custom_text[submit][message]': live
          ? 'One-time SGD 8 purchase of education materials. Keep your saved recovery file to retrieve your download.'
          : 'Sandbox only. Use Stripe test card details; no real money moves.' });
      if (live) {
        form.set('metadata[profile_digest]', LIVE_CHECKOUT_PROFILE_SHA256);
        form.set('metadata[asset_digest]', LIVE_CHECKOUT_OFFER.assetDigest);
        form.set('metadata[product_id]', LIVE_CHECKOUT_OFFER.productId);
        form.set('metadata[account_id]', STRIPE_ACCOUNT);
      }
      if (fulfillment) {
        form.set('metadata[fulfillment_run]', fulfillment.runId);
        form.set('metadata[fulfillment_digest]', fulfillment.outputDigest);
      }
      // Keep the original key for first orders and interrupted pre-upgrade requests.
      // Replacing a verified terminal order uses the reviewed job as a stable key;
      // a lost response replays it while retaining the browser's job principal.
      const suffix = separateOrder ? ':' + fulfillment!.runId + ':' + fulfillment!.outputDigest : '';
      return validate(await request('checkout/sessions', form, (live ? 'commerce-live:' : 'commerce-test:') + nonce + suffix), nonce, undefined, fulfillment);
    },
    async read(id: string, nonce: string, fulfillment?: FulfillmentBinding) {
      return live ? (await liveRead(id, nonce)).session : validate(await request('checkout/sessions/' + id), nonce, id, fulfillment);
    },
    async expire(id: string, nonce: string, fulfillment?: FulfillmentBinding) {
      return validate(await request('checkout/sessions/' + id + '/expire', new URLSearchParams(), (live ? 'commerce-live-expire:' : 'commerce-test-expire:') + nonce), nonce, id, fulfillment);
    },
  };
}
