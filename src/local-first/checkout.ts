import { stripeClient, stripeTestKey, type PaymentFetch, type StripeSession } from './stripe-checkout.ts';
import { CHECKOUT_OFFER } from './checkout-offer.ts';
import { readSession, newSession, cookie, csrf } from './session.ts';
import { isHttpFailure, readJsonObject } from '../shared/http.ts';
import { readFulfillment } from './fulfillment.ts';
import { FulfillmentFailure, sameBinding, validBinding, type FulfillmentBinding, type FulfillmentRuntime } from './fulfillment-contract.ts';

type Service = { fetch(request: Request): Promise<Response> };
export type CheckoutEnv = Readonly<{
  CHECKOUT_MODE?: string;
  STOREFRONT_SESSION_SECRET?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  ASSETS: Service;
}>;
const PREFIX = '/agentic-commerce-os';
const json = (status: number, body: unknown, cookie?: string) => Response.json(body,
  { status, ...(cookie ? { headers: { 'set-cookie': cookie } } : {}) });
const fail = (status: number, code: string) => json(status, { ok: false, mode: 'sandbox', realMoney: false, code });
function publicOffer() { const { asset: _asset, ...offer } = CHECKOUT_OFFER; return offer; }
export function checkoutConfigured(env: CheckoutEnv) {
  return env.CHECKOUT_MODE === 'sandbox' && stripeTestKey(env.STRIPE_TEST_SECRET_KEY) && typeof env.STOREFRONT_SESSION_SECRET === 'string'
    && env.STOREFRONT_SESSION_SECRET.length >= 32;
}
function receipt(payment: StripeSession | null) {
  if (!payment) return null;
  const success = payment.status === 'complete' && payment.payment_status === 'paid';
  return { schema: 'commerce.stripe-test-receipt/v1', mode: 'sandbox', provider: 'stripe', realMoney: false, chargeMinor: 0,
    orderId: payment.id, offerId: CHECKOUT_OFFER.id, status: success ? 'succeeded' : payment.status === 'expired' ? 'expired' : 'pending',
    testAmountMinor: CHECKOUT_OFFER.amountMinor, currency: CHECKOUT_OFFER.currency, downloadReady: success,
    checkoutUrl: payment.url, ...(payment.fulfillment ? { fulfillment: { ...payment.fulfillment,
      status: success ? 'available' : 'awaiting_sandbox_payment' } } : {}) };
}
export async function handleCheckout(request: Request, env: CheckoutEnv, transport?: PaymentFetch,
  runtime?: FulfillmentRuntime): Promise<Response | null> {
  const url = new URL(request.url), relative = url.pathname.slice(PREFIX.length);
  if (!['/checkout', '/checkout/start', '/checkout/cancel', '/checkout/reset', '/checkout/status', '/checkout/receipt', '/checkout/download'].includes(relative)) return null;
  if (!checkoutConfigured(env)) return fail(503, 'sandbox_unavailable');
  if (url.search) return fail(400, 'unexpected_query');
  const secret = env.STOREFRONT_SESSION_SECRET!;
  let session = await readSession(request, secret);
  const stripe = stripeClient(env.STRIPE_TEST_SECRET_KEY!, transport);
  const readPayment = () => session?.paymentId ? stripe.read(session.paymentId, session.nonce, session.fulfillment) : Promise.resolve(null);
  try {
    if (relative === '/checkout' && request.method === 'GET') {
      session ??= newSession();
      return json(200, { ok: true, mode: 'sandbox', realMoney: false, offer: publicOffer(),
        csrfToken: await csrf(session, secret), order: receipt(await readPayment()) }, await cookie(session, secret));
    }
    if (!session) return fail(401, 'checkout_session_required');
    if (['/checkout/start', '/checkout/cancel', '/checkout/reset'].includes(relative) && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site'
        || request.headers.get('x-commerce-csrf') !== await csrf(session, secret)
        || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return fail(403, 'checkout_confirmation_required');
      const body = await readJsonObject(request, 1024);
      if (isHttpFailure(body)) return fail(body.code === 'body_too_large' ? 413 : 400, body.code);
      const keys = Object.keys(body).sort().join();
      if (!['confirmed,offerId', 'confirmed,fulfillment,offerId,reviewed'].includes(keys)
        || body.confirmed !== true || body.offerId !== CHECKOUT_OFFER.id) return fail(400, 'offer_confirmation_mismatch');
      let fulfillment: FulfillmentBinding | undefined;
      if (keys !== 'confirmed,offerId') {
        if (relative !== '/checkout/start' || body.reviewed !== true || !validBinding(body.fulfillment))
          return fail(400, 'fulfillment_review_required');
        fulfillment = body.fulfillment;
      }
      let payment = await readPayment();
      if (relative === '/checkout/start') {
        const separateOrder = !!payment && !sameBinding(session.fulfillment, fulfillment);
        if (separateOrder && (!fulfillment || !(payment!.status === 'expired'
          || payment!.status === 'complete' && payment!.payment_status === 'paid')))
          return fail(409, 'checkout_fulfillment_mismatch');
        if (!payment || separateOrder) {
          if (!separateOrder && Date.now() - session.issuedAt >= 23 * 3600000) return fail(409, 'checkout_session_expired');
          if (fulfillment) {
            const result = await readFulfillment(runtime, session, fulfillment.runId, separateOrder);
            if (result.status !== 'completed' || result.outputDigest !== fulfillment.outputDigest)
              return fail(409, 'fulfillment_review_stale');
            if (separateOrder && (typeof result.plannedAt !== 'number' || !Number.isSafeInteger(result.plannedAt)
              || result.plannedAt < session.issuedAt || result.plannedAt > Date.now()
              || Date.now() - result.plannedAt >= 23 * 3600000)) return fail(409, 'checkout_session_expired');
          }
          payment = await stripe.create(session.nonce, url.origin, fulfillment, separateOrder);
          session = { ...session, paymentId: payment.id, ...(fulfillment ? { fulfillment } : {}) };
        }
      } else if (relative === '/checkout/cancel') {
        if (!payment) return fail(409, 'checkout_not_started');
        if (payment.status === 'open') payment = await stripe.expire(payment.id, session.nonce, session.fulfillment);
      } else {
        if (payment && payment.status !== 'expired') return fail(409, 'checkout_not_expired');
        session = newSession(); payment = null;
      }
      return json(200, { ok: true, mode: 'sandbox', realMoney: false, order: receipt(payment) }, await cookie(session, secret));
    }
    if (request.method !== 'GET') return fail(405, 'method_not_allowed');
    const order = receipt(await readPayment());
    if (relative === '/checkout/status') return json(200, { ok: true, mode: 'sandbox', realMoney: false, order });
    if (relative === '/checkout/receipt') {
      if (!order || order.status === 'pending') return fail(409, 'sandbox_receipt_not_ready');
      return new Response(JSON.stringify(order, null, 2) + '\n', { headers: { 'content-type': 'application/json',
        'content-disposition': 'attachment; filename="airvio-sandbox-receipt.json"' } });
    }
    if (relative === '/checkout/download') {
      if (!order?.downloadReady) return fail(409, 'sandbox_success_required');
      const asset = await env.ASSETS.fetch(new Request(new URL(CHECKOUT_OFFER.asset, url.origin)));
      if (!asset.ok) return fail(503, 'download_unavailable');
      let content: BodyInit | ReadableStream | null = asset.body;
      if (session.fulfillment) {
        const result = await readFulfillment(runtime, session, session.fulfillment.runId);
        if (result.status !== 'completed' || result.outputDigest !== session.fulfillment.outputDigest)
          return fail(503, 'fulfillment_download_unavailable');
        content = await asset.text() + '\n\n## Your reviewed listing\n\n' + result.text + '\n';
      }
      return new Response(content, { headers: { 'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="airvio-education-materials.md"' } });
    }
    return fail(405, 'method_not_allowed');
  } catch (error) { return error instanceof FulfillmentFailure ? fail(error.status, error.code) : fail(503, 'sandbox_unavailable'); }
}
