/** Signed browser session shared by sandbox checkout and durable fulfillment. */
import { validBinding, type FulfillmentBinding } from './fulfillment-contract.ts';
export type Session = { nonce: string; issuedAt: number; paymentId?: string; fulfillment?: FulfillmentBinding };
const COOKIE = '__Host-airvio_sandbox';
const MAX_AGE = 7 * 86400;
const encoder = new TextEncoder();
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
export async function readSession(request: Request, secret: string): Promise<Session | null> {
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
      || Object.keys(item).some(k => !['nonce', 'issuedAt', 'paymentId', 'fulfillment'].includes(k))
      || item.fulfillment !== undefined && (!item.paymentId || !validBinding(item.fulfillment))
      || item.paymentId !== undefined && (typeof item.paymentId !== 'string' || !/^cs_test_[A-Za-z0-9]{16,200}$/u.test(item.paymentId))) return null;
    return item as Session;
  } catch { return null; }
}
export const newSession = (): Session => ({ nonce: base64(crypto.getRandomValues(new Uint8Array(32))), issuedAt: Date.now() });
export async function cookie(session: Session, secret: string) {
  const payload = base64(encoder.encode(JSON.stringify(session)));
  return `${COOKIE}=${payload}.${await signature(payload, secret)}; Path=/; Max-Age=${MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
}
export async function csrf(session: Session, secret: string) { return signature('sandbox-checkout:' + session.nonce, secret); }

/** A host revalidates this signed, expiring principal after restart. It contains
 * no browser cookie, prompt or payment credential and needs no second job store. */
export async function sealRunContext(context: { principalId: string; principalExpiresAt: number }, secret: string) {
  if (!/^commerce-[a-f0-9]{64}$/u.test(context.principalId) || !Number.isSafeInteger(context.principalExpiresAt)
    || context.principalExpiresAt <= Date.now() || context.principalExpiresAt > Date.now() + MAX_AGE * 1000
    || secret.length < 32) throw Error('run_context_invalid');
  const value = 'job:' + context.principalId + ':' + context.principalExpiresAt;
  return { principalId: value + ':' + await signature('durable-principal:' + value, secret),
    principalExpiresAt: context.principalExpiresAt };
}
export async function readRunContext(principalId: string, secret: string) {
  if (typeof principalId !== 'string' || principalId.length > 256 || secret.length < 32) return null;
  const parts = principalId.split(':');
  if (parts.length !== 4 || parts[0] !== 'job' || !/^commerce-[a-f0-9]{64}$/u.test(parts[1]!)
    || !/^[1-9][0-9]{12}$/u.test(parts[2]!)) return null;
  const expiresAt = Number(parts[2]);
  if (expiresAt <= Date.now() || expiresAt > Date.now() + MAX_AGE * 1000) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(parts[3]!),
      encoder.encode('durable-principal:' + parts.slice(0, 3).join(':')))) return null;
    return { principalId, principalExpiresAt: expiresAt };
  } catch { return null; }
}
