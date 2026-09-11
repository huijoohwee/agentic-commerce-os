import { CHECKOUT_OFFER, STRIPE_ACCOUNT } from './checkout-offer.ts';
import { isHttpFailure, isRecord, readJsonResponse } from '../shared/http.ts';
export type PaymentFetch = (request: Request) => Promise<Response>;
export type StripeSession = { id: string; url: string | null; status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required'; amount_total: number; currency: string; livemode: false };
export const stripeTestKey = (value: unknown): value is string => typeof value === 'string' && /^(?:sk|rk)_test_[A-Za-z0-9]{20,}$/u.test(value);
export function hostedUrl(value: unknown, id: string): value is string {
  if (typeof value !== 'string' || value.length > 1800) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
    && !url.port && !url.username && !url.password && !url.search && ['/c/pay/' + id, '/g/pay/' + id].includes(url.pathname); }
  catch { return false; }
}
export function stripeClient(secret: string, transport: PaymentFetch = fetch) {
  if (!stripeTestKey(secret)) throw Error('stripe_test_key_required');
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
  function validate(value: Record<string, unknown>, nonce: string, id?: string): StripeSession {
    if (typeof value.id !== 'string' || !/^cs_test_[A-Za-z0-9]{16,200}$/u.test(value.id) || id && value.id !== id
      || value.livemode !== false || value.mode !== 'payment' || value.client_reference_id !== nonce
      || !isRecord(value.metadata) || value.metadata.offer_id !== CHECKOUT_OFFER.id || value.metadata.owner !== 'agentic-commerce-os'
      || value.amount_total !== CHECKOUT_OFFER.amountMinor || value.currency !== CHECKOUT_OFFER.currency
      || !['open', 'complete', 'expired'].includes(String(value.status))
      || !['paid', 'unpaid', 'no_payment_required'].includes(String(value.payment_status))
      || value.status === 'open' && !hostedUrl(value.url, value.id)) throw Error('stripe_test_identity_mismatch');
    return { id: value.id, livemode: false, amount_total: CHECKOUT_OFFER.amountMinor, currency: CHECKOUT_OFFER.currency,
      url: value.status === 'open' ? String(value.url) : null, status: value.status as StripeSession['status'],
      payment_status: value.payment_status as StripeSession['payment_status'] };
  }
  return {
    async create(nonce: string, origin: string) {
      // Account and Price readbacks prevent a wrong-account or changed-price test from being presented as this offer.
      const [account, price] = await Promise.all([request('account'), request('prices/' + CHECKOUT_OFFER.id)]);
      if (account.id !== STRIPE_ACCOUNT || price.id !== CHECKOUT_OFFER.id || price.livemode !== false || price.active !== true
        || price.unit_amount !== CHECKOUT_OFFER.amountMinor || price.currency !== CHECKOUT_OFFER.currency || price.type !== 'one_time') throw Error('stripe_test_offer_mismatch');
      const back = origin + '/agentic-commerce-os/?checkout=return#checkout';
      const form = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': CHECKOUT_OFFER.id,
        'line_items[0][quantity]': '1', 'payment_method_types[0]': 'card',
        'adaptive_pricing[enabled]': 'false', success_url: back, cancel_url: back,
        client_reference_id: nonce, 'metadata[offer_id]': CHECKOUT_OFFER.id, 'metadata[owner]': 'agentic-commerce-os',
        'metadata[mode]': 'sandbox', 'custom_text[submit][message]': 'Sandbox only. Use Stripe test card details; no real money moves.' });
      return validate(await request('checkout/sessions', form, 'commerce-test:' + nonce), nonce);
    },
    async read(id: string, nonce: string) { return validate(await request('checkout/sessions/' + id), nonce, id); },
    async expire(id: string, nonce: string) {
      return validate(await request('checkout/sessions/' + id + '/expire', new URLSearchParams(), 'commerce-test-expire:' + nonce), nonce, id);
    },
  };
}
