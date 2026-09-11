import { fetchLocalFirst, type LocalFirstEnv } from '../../src/local-first/worker.ts';
import { CHECKOUT_OFFER, STRIPE_ACCOUNT } from '../../src/local-first/checkout-offer.ts';
import type { PaymentFetch } from '../../src/local-first/stripe-checkout.ts';
export function stripeFixture() {
  const sessions = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, string>();
  const calls: Request[] = [];
  const transport: PaymentFetch = async request => {
    calls.push(request); const url = new URL(request.url);
    if (url.origin !== 'https://api.stripe.com') throw Error('Unexpected origin');
    if (url.pathname === '/v1/account') return Response.json({ id: STRIPE_ACCOUNT });
    if (url.pathname === '/v1/prices/' + CHECKOUT_OFFER.id) return Response.json({ id: CHECKOUT_OFFER.id,
      active: true, livemode: false, type: 'one_time', unit_amount: 800, currency: 'sgd' });
    if (url.pathname === '/v1/checkout/sessions' && request.method === 'POST') {
      const params = new URLSearchParams(await request.clone().text()), key = request.headers.get('idempotency-key')!;
      const existing = byKey.get(key); if (existing) return Response.json(sessions.get(existing));
      const id = 'cs_test_' + crypto.randomUUID().replaceAll('-', '');
      const session = { id, object: 'checkout.session', mode: 'payment', livemode: false, amount_total: 800, currency: 'sgd',
        status: 'open', payment_status: 'unpaid', client_reference_id: params.get('client_reference_id'),
        metadata: { offer_id: params.get('metadata[offer_id]'), owner: params.get('metadata[owner]') },
        url: 'https://checkout.stripe.com/c/pay/' + id, customer_details: { email: 'private@example.test' } };
      sessions.set(id, session); byKey.set(key, id); return Response.json(session);
    }
    const [, , , , id, operation] = url.pathname.split('/');
    const session = id ? sessions.get(id) : undefined;
    if (!session) return Response.json({ error: 'not found' }, { status: 404 });
    if (operation === 'expire') { session.status = 'expired'; session.url = null; }
    return Response.json(session);
  };
  return { transport, sessions, calls,
    complete(id: string) { const session = sessions.get(id); if (!session) throw Error('missing fixture');
      session.status = 'complete'; session.payment_status = 'paid'; session.url = null; },
  };
}
const fixture = stripeFixture();
// Only the local test entrypoint exposes fixture control. Production uses worker.ts directly.
export default { async fetch(request: Request, env: LocalFirstEnv) {
  const url = new URL(request.url);
  if (url.pathname === '/__stripe-fixture/complete' && request.method === 'POST') {
    fixture.complete(await request.text()); return Response.json({ ok: true });
  }
  return fetchLocalFirst(request, env, fixture.transport);
} };
