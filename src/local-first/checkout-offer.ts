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

export function renderStorefrontTemplate(template: string, revision: string): string {
  return template.replaceAll('__RELEASE__', revision).replaceAll('__OFFER_TITLE__', CHECKOUT_OFFER.title)
    .replaceAll('__OFFER_PRICE__', new Intl.NumberFormat('en-SG', { style: 'currency',
      currency: CHECKOUT_OFFER.currency, currencyDisplay: 'code' }).format(CHECKOUT_OFFER.amountMinor / 100));
}
export const STRIPE_ACCOUNT = 'acct_1TKGGUGzH0w0k4VU';
