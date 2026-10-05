import { fetchLocalFirst, type LocalFirstEnv } from '../../src/local-first/worker.ts';
import { checkoutOffer, checkoutProfile, LIVE_CHECKOUT_OFFER, STRIPE_ACCOUNT, type CheckoutMode } from '../../src/local-first/checkout-offer.ts';
import { stripeClient, type PaymentFetch } from '../../src/local-first/stripe-checkout.ts';
import { newSession } from '../../src/local-first/session.ts';
import { createCheckoutRecovery } from '../../src/local-first/checkout-recovery.ts';
export function stripeFixture(mode: CheckoutMode = 'sandbox') {
  const offer = checkoutOffer(mode), profile = mode === 'sandbox' ? null : checkoutProfile(mode), live = mode === 'live';
  const account = {id:STRIPE_ACCOUNT,charges_enabled:true};
  const price = {id:offer.id,product:profile?.product ?? LIVE_CHECKOUT_OFFER.productId,active:true,livemode:live,type:'one_time',unit_amount:800,currency:'sgd'};
  const lineItems = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, string>();
  const calls: Request[] = [];
  const transport: PaymentFetch = async request => {
    calls.push(request); const url = new URL(request.url);
    if (url.origin !== 'https://api.stripe.com') throw Error('Unexpected origin');
    if (url.pathname === '/v1/account') return Response.json(account);
    if (url.pathname === '/v1/prices/' + offer.id) return Response.json(price);
    if (url.pathname === '/v1/checkout/sessions' && request.method === 'POST') {
      const params = new URLSearchParams(await request.clone().text()), key = request.headers.get('idempotency-key')!;
      const existing = byKey.get(key); if (existing) return Response.json(sessions.get(existing));
      const id = (live ? 'cs_live_' : 'cs_test_') + crypto.randomUUID().replaceAll('-', '');
      const session = { id, object: 'checkout.session', mode: 'payment', livemode: live, amount_total: 800, currency: 'sgd',
        status: 'open', payment_status: 'unpaid', client_reference_id: params.get('client_reference_id'),
        metadata: Object.fromEntries([...params].filter(([key]) => /^metadata\[[a-z_]+\]$/u.test(key)).map(([key,value]) => [key.slice(9,-1),value])),
        url: 'https://checkout.stripe.com/c/pay/' + id, customer_details: { email: 'private@example.test' } };
      lineItems.set(id,{object:'list',has_more:false,data:[{quantity:1,amount_total:800,amount_subtotal:800,currency:'sgd',price:{...price}}]});
      sessions.set(id, session); byKey.set(key, id); return Response.json(session);
    }
    const [, , , , id, operation] = url.pathname.split('/');
    const session = id ? sessions.get(id) : undefined;
    if (!session) return Response.json({ error: 'not found' }, { status: 404 });
    if (operation === 'line_items') return Response.json(lineItems.get(id!));
    if (request.method === 'POST' && !operation) {
      const params = new URLSearchParams(await request.clone().text());
      const metadata = session.metadata as Record<string,unknown>;
      metadata.entitlement_digest = params.get('metadata[entitlement_digest]');
    }
    if (operation === 'expire') { session.status = 'expired'; session.url = null; }
    return Response.json(session);
  };
  return { transport, sessions, calls, account, price, lineItems,
    complete(id: string) { const session = sessions.get(id); if (!session) throw Error('missing fixture');
      session.status = 'complete'; session.payment_status = 'paid'; session.url = null; },
  };
}
const fixtures = { sandbox: stripeFixture(), test: stripeFixture('test'), live: stripeFixture('live') };
async function completeThroughWebhook(id: string, request: Request, env: LocalFirstEnv,
  fixture: ReturnType<typeof stripeFixture>, mode: 'test' | 'live') {
  fixture.complete(id);
  const profile = checkoutProfile(mode), timestamp = String(Math.floor(Date.now()/1000));
  const body = JSON.stringify({id:'evt_'+crypto.randomUUID().replaceAll('-',''),type:'checkout.session.completed',
    livemode:mode === 'live',api_version:profile.webhookApiVersion,data:{object:fixture.sessions.get(id)}});
  const secret = mode === 'live' ? env.STRIPE_LIVE_WEBHOOK_SECRET : env.STRIPE_TEST_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+body)))]
    .map(value => value.toString(16).padStart(2,'0')).join('');
  const response = await fetchLocalFirst(new Request(new URL('/agentic-commerce-os/checkout/webhook',request.url),{
    method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${timestamp},v1=${signature}`},body}),env,fixture.transport);
  const result = await response.json() as {code?:string};
  if (response.status !== 200 || result.code !== 'stripe_entitlement_verified') throw Error('Signed fixture webhook did not verify entitlement');
  return {webhookVerified:true,provider:'local-stripe-contract-fixture'};
}
// Only the loopback test entrypoint exposes fixture control. Production uses worker.ts directly.
export default { async fetch(request: Request, env: LocalFirstEnv) {
  const url = new URL(request.url), mode = ['live','live-reader'].includes(env.CHECKOUT_MODE ?? '') ? 'live'
    : env.CHECKOUT_MODE === 'test' ? 'test' : 'sandbox';
  const fixture = fixtures[mode];
  if (url.pathname.startsWith('/__stripe-fixture/')) {
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)
      || request.headers.has('origin') && request.headers.get('origin') !== url.origin
      || request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Fixture controls require loopback same-origin requests',{status:403});
    if (request.method !== 'POST') return new Response('Fixture controls require POST',{status:405});
  }
  if (url.pathname === '/__stripe-fixture/complete' && request.method === 'POST') {
    const body = await request.text(), id = body.startsWith('{') ? JSON.parse(body).id : body;
    if (mode === 'sandbox') {fixture.complete(id);return Response.json({ok:true,provider:'local-stripe-contract-fixture'});}
    return Response.json({ok:true,...await completeThroughWebhook(id,request,env,fixture,mode)});
  }
  if (url.pathname === '/__stripe-fixture/seed-paid' && request.method === 'POST' && mode !== 'sandbox') {
    const secret = mode === 'live' ? env.STRIPE_LIVE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY;
    const recoverySecret = mode === 'live' ? env.CHECKOUT_RECOVERY_SECRET : env.CHECKOUT_TEST_RECOVERY_SECRET;
    const session = newSession(), stripe = stripeClient(secret!,fixture.transport,mode);
    const payment = await stripe.create(session.nonce,url.origin);
    const proof = await completeThroughWebhook(payment.id,request,env,fixture,mode);
    return Response.json({orderId:payment.id,recovery:await createCheckoutRecovery({...session,paymentId:payment.id},recoverySecret!,mode),...proof});
  }
  return fetchLocalFirst(request, env, fixture.transport);
} };
