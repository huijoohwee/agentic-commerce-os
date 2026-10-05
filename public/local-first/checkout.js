const $ = selector => document.querySelector(selector);
const base = '/agentic-commerce-os/checkout';
const livePage = ['live', 'live-reader'].includes(document.querySelector('meta[name="commerce-checkout-mode"]')?.content);
let intent, busy = false, verified = false, fulfillment = null, fulfillmentTitle = '', recovery = null, savedOrder = null;
export function selectFulfillment(binding, title) {
  if (livePage) throw Error('Generated listings are sandbox-only. This checkout sells the education materials only.');
  if (!binding || !/^listing-[a-f0-9]{64}$/u.test(binding.runId) || !/^[a-f0-9]{64}$/u.test(binding.outputDigest))
    throw Error('Review a completed listing before checkout.');
  fulfillment = { runId: binding.runId, outputDigest: binding.outputDigest }; fulfillmentTitle = String(title).slice(0, 120);
}
function message(text) { $('#checkout-status').textContent = text; }
function differentOrder() {
  const binding = intent?.order?.fulfillment;
  return !livePage && !!intent?.order && !!fulfillment && (binding?.runId !== fulfillment.runId || binding?.outputDigest !== fulfillment.outputDigest);
}
function enabled() {
  const offline = !navigator.onLine, unavailable = busy || offline || !verified;
  const existingBlocks = !!intent?.order && (!differentOrder() || intent.order.status === 'pending');
  $('#checkout-start').disabled = unavailable || !intent || intent.salesEnabled === false || existingBlocks || !$('#checkout-confirm').checked;
  for (const id of ['checkout-cancel', 'checkout-reset', 'checkout-refresh']) $('#' + id).disabled = busy || offline;
  $('#checkout-save-recovery').disabled = unavailable || !intent?.order;
  $('#checkout-restore-recovery').disabled = busy || offline;
}
function validOrder(order, offer = intent?.offer) {
  if (!order) return;
  const succeeded = order.status === 'succeeded';
  if (!['pending', 'expired', 'succeeded'].includes(order.status) || typeof order.downloadReady !== 'boolean'
    || order.downloadReady && !succeeded || typeof order.orderId !== 'string'
    || (livePage && (order.schema !== 'commerce.stripe-live-receipt/v1' || order.realMoney !== true || order.mode !== 'live'
      || order.provider !== 'stripe' || order.currency !== 'sgd' || order.amountMinor !== 800 || offer && order.offerId !== offer.id
      || order.chargeMinor !== (succeeded ? 800 : 0) || order.downloadReady && order.entitlementReady !== true || order.fulfillment))) throw Error('The order could not be verified. Check its status before continuing.');
}
async function api(path = '', body) {
  let response;
  try { response = await fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: body ? { 'content-type': 'application/json', ...(path !== '/recover' ? { 'x-commerce-csrf': intent?.csrfToken || '' } : {}) } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
  catch { throw Error('Connect to the internet and refresh checkout. Your drafts remain available offline.'); }
  const value = await response.json();
  if (!response.ok || value.ok !== true || value.mode !== (livePage ? 'live' : 'sandbox') || value.realMoney !== livePage || livePage && typeof value.salesEnabled !== 'boolean') throw Error(
    value.code === 'checkout_session_required' ? 'This checkout session has ended. Reopen checkout or restore your recovery file.'
      : livePage ? 'Checkout could not be verified. Check the order or restore your recovery file before trying again.'
        : 'Stripe test checkout could not be verified. Refresh before trying again. No real payment is available.');
  validOrder(value.order, value.offer || intent?.offer);
  return value;
}
function copy() {
  $('#checkout-recovery').hidden = !livePage;
  if (!livePage) return;
  $('#checkout-kind').textContent = 'EDUCATION MATERIALS'; $('#checkout-offer-kind').textContent = 'AIRVIO.CO · DIGITAL DOWNLOAD';
  $('#checkout-heading').textContent = 'Review your purchase.'; $('#checkout-panel-heading').textContent = 'Secure checkout';
  $('#checkout-confirm-copy').textContent = 'I reviewed the education materials and agree to pay SGD 8 once. This is a real payment.';
  $('#checkout-start').textContent = 'Prepare SGD 8 checkout'; $('#checkout-cancel').textContent = 'Cancel checkout';
  $('#checkout-reset').textContent = 'Start a new checkout'; $('#checkout-download').textContent = 'Download education materials ↓';
  $('#checkout-continue').textContent = 'Continue to Stripe · SGD 8 ↗';
  $('#checkout-terms').textContent = 'One-time SGD 8 purchase for the education materials download. The content is open and its source is public. This does not include a hosted agent service or generated listing. Keep the materials and your private recovery file; browser sessions last seven days.';
  $('#checkout-payment-note').textContent = 'Stripe securely collects your payment details. Returning here does not confirm payment: this page verifies the order before enabling its download. Save your recovery file before leaving for Stripe.';
}
function render() {
  const order = intent?.order, state = order?.status, different = differentOrder(), available = verified && navigator.onLine;
  $('#checkout-order').textContent = order ? (livePage ? 'Order ' : 'Stripe test session ') + order.orderId : '';
  $('#checkout-download').hidden = !available || different || !order?.downloadReady;
  $('#checkout-receipt').hidden = !available || !order || state === 'pending';
  $('#checkout-receipt').textContent = livePage ? 'Download payment receipt ↓' : different ? 'Download previous Stripe test receipt ↓' : 'Download Stripe test receipt ↓';
  $('#checkout-reset').hidden = different || state !== 'expired' || intent?.salesEnabled === false;
  $('#checkout-cancel').hidden = state !== 'pending' || intent?.salesEnabled === false;
  $('#checkout-confirm-label').hidden = intent?.salesEnabled === false;
  $('#checkout-start').hidden = intent?.salesEnabled === false;
  const link = $('#checkout-continue'); link.hidden = true; link.removeAttribute('href');
  if (available && !different && state === 'pending' && order.checkoutUrl && (!livePage || intent.salesEnabled && savedOrder === order.orderId)) {
    const target = new URL(order.checkoutUrl), pattern = livePage ? /^\/(?:c|g)\/pay\/cs_live_[A-Za-z0-9]+$/u : /^\/(?:c|g)\/pay\/cs_test_[A-Za-z0-9]+$/u;
    if (target.origin !== 'https://checkout.stripe.com' || !pattern.test(target.pathname) || target.username || target.password) throw Error('Invalid Stripe destination.');
    link.href = target.href; link.hidden = false;
  }
  message(livePage ? intent?.salesEnabled === false
    ? 'New purchases are paused. You can verify an existing order, download paid materials, or restore your recovery file.'
    : ({ succeeded: order?.downloadReady ? 'Payment verified: SGD 8 paid. Your education materials and receipt are ready.' : 'Payment verified: SGD 8 paid. The download is unavailable; keep your recovery file and check again.',
      pending: savedOrder === order?.orderId ? 'Recovery file saved. Continue to Stripe to pay SGD 8, then return here to verify your order.' : 'Checkout prepared. Save your private recovery file below before continuing to Stripe.',
      expired: 'Checkout expired or was cancelled. No payment was verified for this order. You can prepare a new checkout.' })[state]
      || 'Review the education materials, then confirm the one-time SGD 8 payment.'
    : different ? state === 'pending'
      ? 'A different test order is still pending. Check its status or cancel it before preparing checkout for this listing.'
      : 'The previous test receipt belongs to a different order. Save it below, then confirm a separate test checkout for this listing.'
      : ({ succeeded: 'Stripe test payment verified. No real money moved. Your sample download and test receipt are ready.',
        pending: 'Test checkout is ready. Continue to Stripe and use test card details. Return here to verify payment.',
        expired: 'Stripe test checkout expired or was cancelled. No real money moved. You can start a new test.' })[state]
        || 'Review the example offer, then continue to Stripe test checkout. No real money will move.');
  enabled();
}
export async function openCheckout() {
  if (busy) return;
  intent = null; verified = false; $('#checkout-confirm').checked = false; copy(); render();
  if (!navigator.onLine) { message('Connect to use checkout. Your private drafts remain available offline.'); return; }
  busy = true; enabled();
  try {
    const next = await api();
    if (!next.offer || typeof next.csrfToken !== 'string' || (livePage && (next.offer.amountMinor !== 800 || next.offer.currency !== 'sgd' || typeof next.salesEnabled !== 'boolean')))
      throw Error('The offer could not be verified. Reload before continuing.');
    intent = next; verified = true;
    $('#checkout-title').textContent = intent.offer.title;
    $('#checkout-price').textContent = new Intl.NumberFormat('en-SG', { style: 'currency', currency: intent.offer.currency, currencyDisplay: 'code' }).format(intent.offer.amountMinor / 100) + (livePage ? ' · One-time payment' : ' · Test mode');
    $('#checkout-description').textContent = intent.offer.description + (!livePage && fulfillment ? ` Includes your reviewed listing: ${fulfillmentTitle}.` : ''); render(); return true;
  } catch (error) { verified = false; render(); message(error.message); }
  finally { busy = false; enabled(); }
}
async function mutate(path) {
  if (busy || !intent || !verified || !navigator.onLine || path === '/start' && (!$('#checkout-confirm').checked || intent.salesEnabled === false)) return;
  busy = true; enabled();
  try {
    const write = () => api(path, { confirmed: true, offerId: intent.offer.id,
      ...(path === '/start' && fulfillment && !livePage ? { fulfillment, reviewed: true } : {}) });
    const value = navigator.locks ? await navigator.locks.request('airvio-stripe-' + (livePage ? 'live' : 'test') + '-checkout', write) : await write();
    if (path === '/reset') { recovery = null; savedOrder = null; busy = false; await openCheckout(); }
    else {
      Object.assign(intent, value); verified = true;
      if (value.recovery) recovery = { file: value.recovery, orderId: value.order?.orderId };
      render();
    }
  } catch (error) { verified = false; render(); message(error.message); }
  finally { busy = false; enabled(); }
}
$('#checkout-confirm').addEventListener('change', enabled);
for (const [id, path] of [['checkout-start', '/start'], ['checkout-cancel', '/cancel'], ['checkout-reset', '/reset']]) {
  $('#' + id).addEventListener('click', () => void mutate(path));
}
$('#checkout-refresh').addEventListener('click', async () => {
  if (busy) return;
  if (!intent) { await openCheckout(); return; }
  busy = true; enabled();
  try { Object.assign(intent, await api('/status')); verified = true; render(); }
  catch (error) { verified = false; render(); message(error.message); } finally { busy = false; enabled(); }
});
$('#checkout-save-recovery').addEventListener('click', async () => {
  if (!livePage || busy || !verified || !intent?.order || !navigator.onLine) return;
  busy = true; enabled();
  try {
    if (recovery?.orderId !== intent.order.orderId) {
      const value = await api('/recovery', { confirmed: true, offerId: intent.offer.id });
      recovery = { file: value, orderId: intent.order.orderId };
    }
    if (recovery.file?.schema !== 'commerce.live-checkout-recovery/v1' || typeof recovery.file.recoveryToken !== 'string' || recovery.file.recoveryToken.length > 8192 || !recovery.file.recoveryToken) throw Error('Recovery file unavailable. Check the order before continuing.');
    const file = Object.fromEntries(['schema', 'recoveryToken', 'expiresAt', 'offerProfile'].map(key => [key, recovery.file[key]]));
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'airvio-purchase-recovery.json'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); savedOrder = intent.order.orderId;
    $('#checkout-recovery-status').textContent = 'Recovery file downloaded. Check that it is saved and keep it private.'; render();
  } catch (error) { message(error.message); } finally { busy = false; enabled(); }
});
$('#checkout-restore-recovery').addEventListener('change', async event => {
  const input = event.currentTarget, file = input.files?.[0]; input.value = '';
  if (!livePage || busy || !file || !navigator.onLine) return;
  busy = true; enabled();
  try {
    if (file.size > 16384) throw Error('Choose an Airvio recovery JSON file smaller than 16 kB.');
    const value = JSON.parse(await file.text());
    if (value.schema !== 'commerce.live-checkout-recovery/v1' || typeof value.recoveryToken !== 'string' || !value.recoveryToken || value.recoveryToken.length > 8192) throw Error('This recovery file is invalid or belongs to another site.');
    const restored = await api('/recover', { recoveryToken: value.recoveryToken });
    recovery = { file: value, orderId: restored.order?.orderId }; savedOrder = recovery.orderId;
    busy = false; if (!await openCheckout()) throw Error('Restored order could not be refreshed.');
    $('#checkout-recovery-status').textContent = 'Recovery file restored. The order was checked with Stripe; keep this file private.';
  } catch { message('Recovery could not be verified. Keep the file and check your connection before trying again.'); }
  finally { busy = false; enabled(); }
});
window.addEventListener('offline', () => { verified = false; render(); if (!$('#checkout').hidden) message('Checkout needs a connection. Private drafts remain available offline.'); });
window.addEventListener('online', enabled);
