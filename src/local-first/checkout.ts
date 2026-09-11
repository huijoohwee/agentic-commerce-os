import { stripeClient, stripeTestKey, type PaymentFetch, type StripeSession } from './stripe-checkout.ts';
import { CHECKOUT_OFFER } from './checkout-offer.ts';
import { isHttpFailure, readJsonObject } from '../shared/http.ts';

type Service = { fetch(request: Request): Promise<Response> };
export type CheckoutEnv = Readonly<{
  CHECKOUT_MODE?: string;
  STOREFRONT_SESSION_SECRET?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  ASSETS: Service;
}>;
type Session = { nonce: string; issuedAt: number; paymentId?: string };
const PREFIX = '/agentic-commerce-os';
const COOKIE = '__Host-airvio_sandbox';
const MAX_AGE = 7 * 86400;
const encoder = new TextEncoder();
const json = (status: number, body: unknown, cookie?: string) => Response.json(body,
  { status, ...(cookie ? { headers: { 'set-cookie': cookie } } : {}) });
const fail = (status: number, code: string) => json(status, { ok: false, mode: 'sandbox', realMoney: false, code });
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw Error('invalid_encoding');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (base64(bytes) !== value) throw Error('noncanonical_encoding');
  return bytes;
}
async function key(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signature(value: string, secret: string) {
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(value))));
}
async function readSession(request: Request, secret: string): Promise<Session | null> {
  const values = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const raw = values[0]!.slice(COOKIE.length + 1);
  if (raw.length > 2048) return null;
  try {
    const [payload, mac, extra] = raw.split('.');
    if (!payload || !mac || extra || !await crypto.subtle.verify('HMAC', await key(secret), decode(mac), encoder.encode(payload))) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(item.nonce)
      || typeof item.issuedAt !== 'number' || !Number.isSafeInteger(item.issuedAt)
      || item.issuedAt > Date.now() + 5000 || Date.now() - item.issuedAt > MAX_AGE * 1000
      || Object.keys(item).some(k => !['nonce', 'issuedAt', 'paymentId'].includes(k))
      || item.paymentId !== undefined && (typeof item.paymentId !== 'string' || !/^cs_test_[A-Za-z0-9]{16,200}$/u.test(item.paymentId))) return null;
    return item as Session;
  } catch { return null; }
}
const newSession = (): Session => ({ nonce: base64(crypto.getRandomValues(new Uint8Array(32))), issuedAt: Date.now() });
async function cookie(session: Session, secret: string) {
  const payload = base64(encoder.encode(JSON.stringify(session)));
  return `${COOKIE}=${payload}.${await signature(payload, secret)}; Path=/; Max-Age=${MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
}
async function csrf(session: Session, secret: string) { return signature('sandbox-checkout:' + session.nonce, secret); }
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
    checkoutUrl: payment.url };
}
export async function handleCheckout(request: Request, env: CheckoutEnv, transport?: PaymentFetch): Promise<Response | null> {
  const url = new URL(request.url), relative = url.pathname.slice(PREFIX.length);
  if (!['/checkout', '/checkout/start', '/checkout/cancel', '/checkout/reset', '/checkout/status', '/checkout/receipt', '/checkout/download'].includes(relative)) return null;
  if (!checkoutConfigured(env)) return fail(503, 'sandbox_unavailable');
  if (url.search) return fail(400, 'unexpected_query');
  const secret = env.STOREFRONT_SESSION_SECRET!;
  let session = await readSession(request, secret);
  const stripe = stripeClient(env.STRIPE_TEST_SECRET_KEY!, transport);
  const readPayment = () => session?.paymentId ? stripe.read(session.paymentId, session.nonce) : Promise.resolve(null);
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
      if (Object.keys(body).sort().join() !== 'confirmed,offerId' || body.confirmed !== true || body.offerId !== CHECKOUT_OFFER.id) return fail(400, 'offer_confirmation_mismatch');
      let payment = await readPayment();
      if (relative === '/checkout/start') {
        if (!payment) {
          if (Date.now() - session.issuedAt >= 23 * 3600000) return fail(409, 'checkout_session_expired');
          payment = await stripe.create(session.nonce, url.origin);
          session = { ...session, paymentId: payment.id };
        }
      } else if (relative === '/checkout/cancel') {
        if (!payment) return fail(409, 'checkout_not_started');
        if (payment.status === 'open') payment = await stripe.expire(payment.id, session.nonce);
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
      return new Response(asset.body, { headers: { 'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="airvio-education-materials.md"' } });
    }
    return fail(405, 'method_not_allowed');
  } catch { return fail(503, 'sandbox_unavailable'); }
}
