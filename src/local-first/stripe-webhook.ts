import { checkoutProfile } from './checkout-offer.ts';
import { isRecord } from '../shared/http.ts';
const encoder = new TextEncoder();
const json = (status: number, code: string) => Response.json({ok:status === 200,code},
  {status,headers:{'cache-control':'no-store'}});
/** Only authenticated events in the selected mode may establish this product's entitlement. */
export async function handleStripeWebhook(request: Request, secret: string,
  fulfill: (sessionId: string) => Promise<unknown>, mode: 'test' | 'live' = 'live'): Promise<Response> {
  const live = mode === 'live';
  if (request.method !== 'POST' || new URL(request.url).search || request.headers.has('origin') || request.headers.has('cookie')
    || request.headers.has('content-encoding') || request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return json(400,'stripe_webhook_request_invalid');
  if (!/^whsec_[A-Za-z0-9]{20,}$/u.test(secret)) return json(503,'stripe_webhook_unavailable');
  const header = request.headers.get('stripe-signature') ?? '';
  if (header.length > 1024) return json(400,'stripe_signature_invalid');
  const parts = header.split(',').map(part => part.trim()), timestamps = parts.filter(part => part.startsWith('t='));
  const signatures = parts.filter(part => /^v1=[a-f0-9]{64}$/u.test(part)).map(part => part.slice(3));
  if (timestamps.length !== 1 || !/^t=[1-9][0-9]{9,12}$/u.test(timestamps[0]!) || !signatures.length || signatures.length > 4)
    return json(400,'stripe_signature_invalid');
  const timestamp = timestamps[0]!.slice(2);
  if (Math.abs(Date.now()/1000 - Number(timestamp)) > 300) return json(400,'stripe_signature_expired');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > 65536)) return json(413,'stripe_webhook_too_large');
  const reader = request.body?.getReader(); if (!reader) return json(400,'stripe_webhook_payload_invalid');
  const chunks: Uint8Array[] = []; let length = 0, cancel: () => void = () => {};
  const stopped = new Promise<never>((_,reject) => {cancel = () => reject(Error('webhook_body_stopped'));});
  const timer = setTimeout(cancel,5000);
  request.signal.addEventListener('abort',cancel,{once:true});
  if (request.signal.aborted) cancel();
  try { while (true) { const {done,value} = await Promise.race([reader.read(),stopped]); if (done) break;
    length += value.byteLength; if (length > 65536 || chunks.length >= 1024) return json(413,'stripe_webhook_too_large'); chunks.push(value);
  } } catch { return json(400,'stripe_webhook_payload_invalid'); }
  finally { clearTimeout(timer);request.signal.removeEventListener('abort',cancel);void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.byteLength;}
  const prefix = encoder.encode(timestamp + '.'), signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);signed.set(bytes,prefix.length);
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  let valid = false;
  for (const signature of signatures) valid = await crypto.subtle.verify('HMAC',key,
    Uint8Array.from(signature.match(/../gu)!,part => parseInt(part,16)),signed) || valid;
  if (!valid) return json(400,'stripe_signature_invalid');
  let event: unknown; try {event = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {return json(400,'stripe_webhook_payload_invalid');}
  if (!isRecord(event) || event.livemode !== live || event.api_version !== checkoutProfile(mode).webhookApiVersion
    || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]{8,200}$/u.test(event.id)) return json(400,'stripe_webhook_identity_invalid');
  if (!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(String(event.type)))
    return json(200,'stripe_event_ignored');
  const session = isRecord(event.data) && isRecord(event.data.object) ? event.data.object : null;
  if (!session || !isRecord(session.metadata)) return json(400,'stripe_webhook_session_invalid');
  if (session.metadata.owner !== 'agentic-commerce-os' || session.metadata.mode !== mode) return json(200,'stripe_event_ignored');
  if (session.object !== 'checkout.session' || session.livemode !== live || typeof session.id !== 'string'
    || !(live ? /^cs_live_[A-Za-z0-9]{16,200}$/u : /^cs_test_[A-Za-z0-9]{16,200}$/u).test(session.id)) return json(400,'stripe_webhook_session_invalid');
  // Event data is a wakeup only. Re-read exact account, session and line items;
  // Stripe's idempotent metadata update owns entitlement even without a browser return.
  try {await fulfill(session.id);return json(200,'stripe_entitlement_verified');}
  catch {return json(503,'stripe_entitlement_unavailable');}
}
