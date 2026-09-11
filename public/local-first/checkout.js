const $ = selector => document.querySelector(selector);
const base = '/agentic-commerce-os/checkout';
let intent, busy = false;
function message(text) { $('#checkout-status').textContent = text; }
function enabled() {
  const offline = !navigator.onLine;
  $('#checkout-start').disabled = busy || !intent || !!intent.order || !$('#checkout-confirm').checked || offline;
  for (const id of ['checkout-cancel', 'checkout-reset', 'checkout-refresh']) $('#' + id).disabled = busy || offline;
}
async function api(path = '', body) {
  let response;
  try { response = await fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'content-type': 'application/json', 'x-commerce-csrf': intent.csrfToken } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
  catch { throw Error('Connect to the internet and refresh checkout. Your drafts remain available offline.'); }
  const value = await response.json();
  if (!response.ok || value.ok !== true || value.mode !== 'sandbox' || value.realMoney !== false) throw Error(
    value.code === 'checkout_session_required' ? 'This test session has ended. Reopen checkout to start again.'
      : 'Stripe test checkout could not be verified. Refresh before trying again. No real payment is available.');
  return value;
}
function render() {
  const order = intent?.order, state = order?.status;
  $('#checkout-order').textContent = order ? 'Stripe test session ' + order.orderId : '';
  $('#checkout-download').hidden = !order?.downloadReady;
  $('#checkout-receipt').hidden = !order || state === 'pending';
  $('#checkout-reset').hidden = state !== 'expired';
  $('#checkout-cancel').hidden = state !== 'pending';
  const link = $('#checkout-continue'); link.hidden = true; link.removeAttribute('href');
  if (state === 'pending' && order.checkoutUrl) {
    const target = new URL(order.checkoutUrl);
    if (target.origin !== 'https://checkout.stripe.com' || !/^\/(?:c|g)\/pay\/cs_test_[A-Za-z0-9]+$/u.test(target.pathname)) throw Error('Invalid Stripe test destination.');
    link.href = target.href; link.hidden = false;
  }
  message(({ succeeded: 'Stripe test payment verified. No real money moved. Your sample download and test receipt are ready.',
    pending: 'Test checkout is ready. Continue to Stripe and use test card details. Return here to verify payment.',
    expired: 'Stripe test checkout expired or was cancelled. No real money moved. You can start a new test.' })[state]
    || 'Review the example offer, then continue to Stripe test checkout. No real money will move.');
  enabled();
}
export async function openCheckout() {
  intent = null; $('#checkout-confirm').checked = false; render();
  if (!navigator.onLine) { message('Connect to use Stripe test checkout. Your private drafts remain available offline.'); return; }
  busy = true; enabled();
  try { intent = await api();
    $('#checkout-title').textContent = intent.offer.title;
    $('#checkout-price').textContent = new Intl.NumberFormat('en-SG', { style: 'currency', currency: intent.offer.currency, currencyDisplay: 'code' }).format(intent.offer.amountMinor / 100) + ' · Test mode';
    $('#checkout-description').textContent = intent.offer.description; render();
  } catch (error) { message(error.message); }
  finally { busy = false; enabled(); }
}
async function mutate(path) {
  if (busy || !intent || !navigator.onLine || path === '/start' && !$('#checkout-confirm').checked) return;
  busy = true; enabled();
  try {
    const write = () => api(path, { confirmed: true, offerId: intent.offer.id });
    const value = navigator.locks ? await navigator.locks.request('airvio-stripe-test-checkout', write) : await write();
    if (path === '/reset') await openCheckout();
    else { intent.order = value.order; render(); }
  } catch (error) { message(error.message); }
  finally { busy = false; enabled(); }
}
$('#checkout-confirm').addEventListener('change', enabled);
for (const [id, path] of [['checkout-start', '/start'], ['checkout-cancel', '/cancel'], ['checkout-reset', '/reset']]) {
  $('#' + id).addEventListener('click', () => void mutate(path));
}
$('#checkout-refresh').addEventListener('click', async () => {
  if (busy) return; busy = true; enabled();
  try { if (!intent) { await openCheckout(); return; } intent.order = (await api('/status')).order; render(); }
  catch (error) { message(error.message); } finally { busy = false; enabled(); }
});
window.addEventListener('offline', () => { enabled(); if (!$('#checkout').hidden) message('Stripe test checkout needs a connection. Private drafts remain available offline.'); });
window.addEventListener('online', enabled);
