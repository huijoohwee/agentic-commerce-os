import { LIVE_CHECKOUT_PROFILE_SHA256 } from './checkout-offer.ts';
import type { Session } from './session.ts';
const SCHEMA = 'commerce.live-checkout-recovery/v1';
const TTL = 365 * 86400000;
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw Error('recovery_encoding_invalid');
  const bytes = Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
  if (encode(bytes) !== value) throw Error('recovery_encoding_invalid');
  return bytes;
}
async function key(secret: string) {
  if (secret.length < 32) throw Error('recovery_secret_required');
  return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
/** A private bearer capability, never a URL or proof that payment succeeded. */
export async function createCheckoutRecovery(session: Session, secret: string) {
  if (!/^cs_live_[A-Za-z0-9]{16,200}$/u.test(session.paymentId ?? '')) throw Error('recovery_order_required');
  const issuedAt = Date.now(), expiresAt = issuedAt + TTL;
  const payload = encode(encoder.encode(JSON.stringify({schema:SCHEMA,profileDigest:LIVE_CHECKOUT_PROFILE_SHA256,
    paymentId:session.paymentId,nonce:session.nonce,issuedAt,expiresAt})));
  const signature = await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(SCHEMA + '.' + payload));
  return {schema:SCHEMA,recoveryToken:payload + '.' + encode(new Uint8Array(signature)),expiresAt,
    offerProfile:LIVE_CHECKOUT_PROFILE_SHA256};
}
export async function readCheckoutRecovery(value: unknown, secret: string): Promise<Session | null> {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const [payload,signature,extra] = value.split('.');
    if (!payload || !signature || extra || !await crypto.subtle.verify('HMAC',await key(secret),decode(signature),
      encoder.encode(SCHEMA + '.' + payload))) return null;
    const item = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(payload)));
    if (!item || Array.isArray(item) || Object.keys(item).sort().join() !== 'expiresAt,issuedAt,nonce,paymentId,profileDigest,schema'
      || item.schema !== SCHEMA || item.profileDigest !== LIVE_CHECKOUT_PROFILE_SHA256
      || typeof item.paymentId !== 'string' || !/^cs_live_[A-Za-z0-9]{16,200}$/u.test(item.paymentId)
      || typeof item.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(item.nonce)
      || !Number.isSafeInteger(item.issuedAt) || !Number.isSafeInteger(item.expiresAt)
      || item.issuedAt > Date.now() + 5000 || item.expiresAt - item.issuedAt !== TTL || item.expiresAt <= Date.now()) return null;
    return {nonce:item.nonce,paymentId:item.paymentId,issuedAt:Date.now()};
  } catch { return null; }
}
