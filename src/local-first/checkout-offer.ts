/** Sandbox example only. Draft estimates never become payment authority. */
export const CHECKOUT_OFFER = Object.freeze({
  id: 'price_1UEcrJGzH0w0k4VU6HbApj39',
  title: 'Education materials — sandbox',
  merchant: 'airvio.co',
  amountMinor: 800,
  currency: 'sgd',
  description: 'A practical launch guide and reusable worksheets for your first agentic commerce offer.',
  delivery: 'Use Stripe test checkout, then download the education materials. No real money moves.',
  asset: '/education-materials.md',
});
export const CHECKOUT_MODE = 'sandbox' as const;
export type CheckoutMode = 'sandbox' | 'live';
export const LIVE_CHECKOUT_OFFER = Object.freeze({
  ...CHECKOUT_OFFER, id: 'price_1TeXU4GzH0w0k4VUqOmX4aTn', productId: 'prod_Udp8wzZHVOFgQv',
  title: 'Education materials',
  delivery: 'Pay SGD 8 once through Stripe, then download the education materials. Save your recovery file before payment.',
  assetDigest: '174f3f3253c4c87cd665d8f8ad5c75510038d825bca372e8bbeb61a03cbb033e',
});
export const LIVE_CHECKOUT_PROFILE = Object.freeze({ schema: 'commerce.stripe-live-profile/v1',
  account: 'acct_1TKGGUGzH0w0k4VU', product: LIVE_CHECKOUT_OFFER.productId, price: LIVE_CHECKOUT_OFFER.id,
  amountMinor: LIVE_CHECKOUT_OFFER.amountMinor, currency: LIVE_CHECKOUT_OFFER.currency,
  assetDigest: LIVE_CHECKOUT_OFFER.assetDigest, recoveryDays: 365, webhookApiVersion: '2026-06-24.dahlia' });
export const LIVE_CHECKOUT_PROFILE_SHA256 = 'b809cda2e0c3adff95b3acc9cd6fe3f5797b3b2da05ebdda2c54648ebd36233e';
export const checkoutOffer = (mode: CheckoutMode) => mode === 'live' ? LIVE_CHECKOUT_OFFER : CHECKOUT_OFFER;
/** Only this immutable edition may satisfy the paid entitlement. */
export async function readLiveEducationAsset(assets: { fetch(request: Request): Promise<Response> }, origin: string) {
  const response = await assets.fetch(new Request(new URL(LIVE_CHECKOUT_OFFER.asset, origin)));
  if (!response.ok || !response.body) throw Error('education_asset_unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const {done, value} = await reader.read(); if (done) break;
    size += value.byteLength; if (size >= 500000) throw Error('education_asset_too_large'); chunks.push(value);
  } } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join('');
  if (hash !== LIVE_CHECKOUT_OFFER.assetDigest) throw Error('education_asset_changed');
  return bytes;
}

export function renderStorefrontTemplate(template: string, revision: string, configuredMode = 'sandbox'): string {
  const mode = ['live','live-reader'].includes(configuredMode) ? configuredMode : 'sandbox';
  const offer = checkoutOffer(mode === 'sandbox' ? 'sandbox' : 'live');
  return template.replaceAll('__RELEASE__', revision).replaceAll('__CHECKOUT_MODE__', mode).replaceAll('__OFFER_TITLE__', offer.title)
    .replaceAll('__OFFER_PRICE__', new Intl.NumberFormat('en-SG', { style: 'currency',
      currency: offer.currency, currencyDisplay: 'code' }).format(offer.amountMinor / 100));
}
export const STRIPE_ACCOUNT = 'acct_1TKGGUGzH0w0k4VU';
