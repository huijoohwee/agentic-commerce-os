// Only the listing build disables live checkout; unbundled and Worker owners retain it.
import { stripeClient, stripeTestKey, stripeLiveKey, type PaymentFetch, type StripeSession } from './stripe-checkout.ts';
import { checkoutOffer, LIVE_CHECKOUT_PROFILE_SHA256, TEST_CHECKOUT_PROFILE_SHA256, readLiveEducationAsset, type CheckoutMode } from './checkout-offer.ts';
import { createCheckoutRecovery, readCheckoutRecovery } from './checkout-recovery.ts';
import { handleStripeWebhook } from './stripe-webhook.ts';
import { readSession, newSession, cookie, csrf } from './session.ts';
import { isHttpFailure, readJsonObject } from '../shared/http.ts';
import { readFulfillment } from './fulfillment.ts';
import { FulfillmentFailure, sameBinding, validBinding, type FulfillmentBinding, type FulfillmentRuntime } from './fulfillment-contract.ts';

type Service = { fetch(request: Request): Promise<Response> };
export type CheckoutEnv = Readonly<{
  CHECKOUT_MODE?: string;
  STOREFRONT_SESSION_SECRET?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  STRIPE_TEST_WEBHOOK_SECRET?: string;
  CHECKOUT_TEST_RECOVERY_SECRET?: string;
  CHECKOUT_TEST_PROFILE_SHA256?: string;
  STRIPE_LIVE_SECRET_KEY?: string;
  STRIPE_LIVE_WEBHOOK_SECRET?: string;
  CHECKOUT_RECOVERY_SECRET?: string;
  CHECKOUT_LIVE_PROFILE_SHA256?: string;
  ASSETS: Service;
}>;
const PREFIX = '/agentic-commerce-os';
const json = (status: number, body: unknown, cookie?: string) => Response.json(body,
  { status, ...(cookie ? { headers: { 'set-cookie': cookie } } : {}) });
export const checkoutMode = (env: CheckoutEnv): CheckoutMode => ['live','live-reader'].includes(env.CHECKOUT_MODE ?? '') ? 'live' : (import.meta.commerceLiveCheckout !== false) && env.CHECKOUT_MODE === 'test' ? 'test' : 'sandbox';
export function checkoutConfigured(env: CheckoutEnv) {
  if (typeof env.STOREFRONT_SESSION_SECRET !== 'string' || env.STOREFRONT_SESSION_SECRET.length < 32) return false;
  if (env.CHECKOUT_MODE === 'sandbox') return stripeTestKey(env.STRIPE_TEST_SECRET_KEY);
  if (!(import.meta.commerceLiveCheckout !== false)) return false;
  if (env.CHECKOUT_MODE === 'test') {
    const secrets = [env.STOREFRONT_SESSION_SECRET,env.STRIPE_TEST_SECRET_KEY,env.STRIPE_TEST_WEBHOOK_SECRET,env.CHECKOUT_TEST_RECOVERY_SECRET];
    return stripeTestKey(env.STRIPE_TEST_SECRET_KEY) && /^whsec_[A-Za-z0-9]{20,}$/u.test(env.STRIPE_TEST_WEBHOOK_SECRET ?? '')
      && typeof env.CHECKOUT_TEST_RECOVERY_SECRET === 'string' && env.CHECKOUT_TEST_RECOVERY_SECRET.length >= 32
      && new Set(secrets).size === secrets.length && env.CHECKOUT_TEST_PROFILE_SHA256 === TEST_CHECKOUT_PROFILE_SHA256;
  }
  const secrets = [env.STOREFRONT_SESSION_SECRET, env.STRIPE_LIVE_SECRET_KEY, env.STRIPE_LIVE_WEBHOOK_SECRET, env.CHECKOUT_RECOVERY_SECRET];
  return ['live','live-reader'].includes(env.CHECKOUT_MODE ?? '') && stripeLiveKey(env.STRIPE_LIVE_SECRET_KEY)
    && /^whsec_[A-Za-z0-9]{20,}$/u.test(env.STRIPE_LIVE_WEBHOOK_SECRET ?? '')
    && typeof env.CHECKOUT_RECOVERY_SECRET === 'string' && env.CHECKOUT_RECOVERY_SECRET.length >= 32
    && new Set(secrets).size === secrets.length && env.CHECKOUT_LIVE_PROFILE_SHA256 === LIVE_CHECKOUT_PROFILE_SHA256;
}
function receipt(payment: StripeSession | null, mode: CheckoutMode) {
  if (!payment) return null;
  const offer = checkoutOffer(mode);
  const success = payment.status === 'complete' && payment.payment_status === 'paid';
  return { schema: ((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? 'commerce.stripe-live-receipt/v1' : 'commerce.stripe-test-receipt/v1', mode, provider: 'stripe',
    realMoney: ((import.meta.commerceLiveCheckout !== false) && mode === 'live'), chargeMinor: ((import.meta.commerceLiveCheckout !== false) && mode === 'live') && success ? offer.amountMinor : 0,
    orderId: payment.id, offerId: offer.id, status: success ? 'succeeded' : payment.status === 'expired' ? 'expired' : 'pending',
    ...(((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? { amountMinor: offer.amountMinor, entitlementReady: success && payment.entitlementReady === true,
      profileDigest: LIVE_CHECKOUT_PROFILE_SHA256 } : { testAmountMinor: offer.amountMinor,
      ...((import.meta.commerceLiveCheckout !== false) && mode === 'test' ? {entitlementReady: success && payment.entitlementReady === true,profileDigest:TEST_CHECKOUT_PROFILE_SHA256} : {}) }),
    currency: offer.currency, downloadReady: success && (!((import.meta.commerceLiveCheckout !== false) && mode !== 'sandbox') || payment.entitlementReady === true),
    checkoutUrl: payment.url, ...(payment.fulfillment ? { fulfillment: { ...payment.fulfillment,
      status: success ? 'available' : 'awaiting_sandbox_payment' } } : {}) };
}
export async function handleCheckout(request: Request, env: CheckoutEnv, transport?: PaymentFetch,
  runtime?: FulfillmentRuntime): Promise<Response | null> {
  const url = new URL(request.url), relative = url.pathname.slice(PREFIX.length), mode = checkoutMode(env);
  const offer = checkoutOffer(mode), salesEnabled = env.CHECKOUT_MODE !== 'live-reader';
  const envelope = {mode,realMoney:((import.meta.commerceLiveCheckout !== false) && mode === 'live'),salesEnabled};
  const fail = (status: number, code: string) => json(status, {ok:false,...envelope,code});
  if (!['/checkout', '/checkout/start', '/checkout/cancel', '/checkout/reset', '/checkout/status', '/checkout/receipt', '/checkout/download', '/checkout/recovery', '/checkout/recover', '/checkout/webhook'].includes(relative)) return null;
  if (!checkoutConfigured(env)) return fail(503, ((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? 'live_checkout_unavailable' : 'sandbox_unavailable');
  if (!(import.meta.commerceLiveCheckout !== false) && ['/checkout/webhook','/checkout/recovery','/checkout/recover'].includes(relative)) return fail(404,'not_found');
  if (url.search) return fail(400, 'unexpected_query');
  const secret = env.STOREFRONT_SESSION_SECRET!;
  let session = await readSession(request, secret, mode);
  const stripe = stripeClient((((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? env.STRIPE_LIVE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY)!, transport, mode);
  if ((import.meta.commerceLiveCheckout !== false) && relative === '/checkout/webhook') {
    if (mode === 'sandbox') return fail(404,'not_found');
    return handleStripeWebhook(request,(mode === 'test' ? env.STRIPE_TEST_WEBHOOK_SECRET : env.STRIPE_LIVE_WEBHOOK_SECRET)!,async id => {
      await readLiveEducationAsset(env.ASSETS,url.origin);return stripe.fulfill(id);
    },mode);
  }
  const confirmedRequest = () => request.headers.get('origin') === url.origin
    && request.headers.get('sec-fetch-site') !== 'cross-site' && !request.headers.has('content-encoding')
    && request.headers.get('content-type')?.split(';')[0] === 'application/json';
  const readPayment = () => session?.paymentId ? stripe.read(session.paymentId, session.nonce, session.fulfillment) : Promise.resolve(null);
  try {
    if ((import.meta.commerceLiveCheckout !== false) && relative === '/checkout/recover') {
      if (mode === 'sandbox') return fail(404,'not_found');
      if (request.method !== 'POST' || !confirmedRequest()) return fail(403,'checkout_recovery_confirmation_required');
      const body = await readJsonObject(request,4096);
      if (isHttpFailure(body) || Object.keys(body).join() !== 'recoveryToken') return fail(400,'checkout_recovery_invalid');
      const recovered = await readCheckoutRecovery(body.recoveryToken,(mode === 'test' ? env.CHECKOUT_TEST_RECOVERY_SECRET : env.CHECKOUT_RECOVERY_SECRET)!,mode);
      if (!recovered) return fail(403,'checkout_recovery_invalid');
      const payment = await stripe.read(recovered.paymentId!,recovered.nonce);
      if (payment.status !== 'complete' || payment.payment_status !== 'paid') return fail(409,'checkout_paid_required');
      return json(200,{ok:true,...envelope,order:receipt(payment,mode),csrfToken:await csrf(recovered,secret,mode)},
        await cookie(recovered,secret,mode));
    }
    if (relative === '/checkout' && request.method === 'GET') {
      session ??= newSession();
      const {asset: _asset, ...publicOffer} = offer;
      return json(200, {ok:true,...envelope,offer:publicOffer,
        csrfToken:await csrf(session,secret,mode),order:receipt(await readPayment(),mode)},await cookie(session,secret,mode));
    }
    if (!session) return fail(401, 'checkout_session_required');
    if ((import.meta.commerceLiveCheckout !== false) && relative === '/checkout/recovery') {
      if (mode === 'sandbox') return fail(404,'not_found');
      if (request.method !== 'POST' || !confirmedRequest()
        || request.headers.get('x-commerce-csrf') !== await csrf(session,secret,mode)) return fail(403,'checkout_confirmation_required');
      const body = await readJsonObject(request,1024);
      if (isHttpFailure(body) || Object.keys(body).sort().join() !== 'confirmed,offerId'
        || body.confirmed !== true || body.offerId !== offer.id) return fail(400,'offer_confirmation_mismatch');
      if (!session.paymentId) return fail(409,'checkout_not_started');
      await readPayment();
      return json(200,{ok:true,...envelope,...await createCheckoutRecovery(session,(mode === 'test' ? env.CHECKOUT_TEST_RECOVERY_SECRET : env.CHECKOUT_RECOVERY_SECRET)!,mode === 'test' ? 'test' : 'live')});
    }
    if (['/checkout/start', '/checkout/cancel', '/checkout/reset'].includes(relative) && request.method === 'POST') {
      if (!confirmedRequest() || request.headers.get('x-commerce-csrf') !== await csrf(session, secret, mode))
        return fail(403, 'checkout_confirmation_required');
      const body = await readJsonObject(request, 1024);
      if (isHttpFailure(body)) return fail(body.code === 'body_too_large' ? 413 : 400, body.code);
      const keys = Object.keys(body).sort().join();
      if (!['confirmed,offerId', 'confirmed,fulfillment,offerId,reviewed'].includes(keys)
        || body.confirmed !== true || body.offerId !== offer.id) return fail(400, 'offer_confirmation_mismatch');
      if (((import.meta.commerceLiveCheckout !== false) && mode !== 'sandbox') && keys !== 'confirmed,offerId') return fail(400,'live_education_only');
      let fulfillment: FulfillmentBinding | undefined;
      if (keys !== 'confirmed,offerId') {
        if (relative !== '/checkout/start' || body.reviewed !== true || !validBinding(body.fulfillment))
          return fail(400, 'fulfillment_review_required');
        fulfillment = body.fulfillment;
      }
      if (((import.meta.commerceLiveCheckout !== false) && mode === 'live') && !salesEnabled && relative === '/checkout/start') return fail(409,'checkout_sales_disabled');
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
          if (((import.meta.commerceLiveCheckout !== false) && mode !== 'sandbox')) await readLiveEducationAsset(env.ASSETS,url.origin);
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
      return json(200,{ok:true,...envelope,order:receipt(payment,mode),
        ...(((import.meta.commerceLiveCheckout !== false) && mode !== 'sandbox') && session.paymentId ? {recovery:await createCheckoutRecovery(session,(mode === 'test' ? env.CHECKOUT_TEST_RECOVERY_SECRET : env.CHECKOUT_RECOVERY_SECRET)!,mode === 'test' ? 'test' : 'live')} : {})},
        await cookie(session,secret,mode));
    }
    if (request.method !== 'GET') return fail(405, 'method_not_allowed');
    const order = receipt(await readPayment(),mode);
    if (relative === '/checkout/status') return json(200, {ok:true,...envelope,order});
    if (relative === '/checkout/receipt') {
      if (!order || order.status === 'pending') return fail(409, ((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? 'checkout_receipt_not_ready' : 'sandbox_receipt_not_ready');
      return new Response(JSON.stringify(order, null, 2) + '\n', { headers: { 'content-type': 'application/json',
        'content-disposition': 'attachment; filename="airvio-' + (((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? 'live' : 'sandbox') + '-receipt.json"' } });
    }
    if (relative === '/checkout/download') {
      if (!order?.downloadReady) return fail(409, ((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? 'checkout_entitlement_required' : 'sandbox_success_required');
      if (((import.meta.commerceLiveCheckout !== false) && mode !== 'sandbox')) return new Response(await readLiveEducationAsset(env.ASSETS,url.origin),{headers:{
        'content-type':'text/markdown; charset=utf-8','content-disposition':'attachment; filename="airvio-education-materials.md"'}});
      const asset = await env.ASSETS.fetch(new Request(new URL(offer.asset, url.origin)));
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
  } catch (error) { return error instanceof FulfillmentFailure ? fail(error.status, error.code) : fail(503, ((import.meta.commerceLiveCheckout !== false) && mode === 'live') ? 'live_checkout_unavailable' : 'sandbox_unavailable'); }
}
