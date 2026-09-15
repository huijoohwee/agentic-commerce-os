import { createHash } from 'node:crypto';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function boundedBody(response) {
  const reader = response.body?.getReader(), chunks = [];
  let bytes = 0, truncated = false;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const available = 16384 - bytes;
        chunks.push(next.value.subarray(0, available)); bytes += Math.min(available, next.value.length);
        if (next.value.length > available || bytes === 16384) { truncated = true; break; }
      }
    } finally { await reader.cancel(); }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// Poll only the public read endpoint; never replay deployment or route mutations.
export async function waitForReadiness({ url, revision, versionId, observe = () => {},
  fetchImpl = fetch, now = Date.now, sleep = delay, timeoutMs = 45000, intervalMs = 2000 }) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    const observation = { attempt: ++attempt, observedAt: new Date(now()).toISOString() };
    let identity, terminal;
    try {
      const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - now()))) });
      Object.assign(observation, { status: response.status, contentType: response.headers.get('content-type'),
        ray: response.headers.get('cf-ray') });
      if (![200, 404, 503].includes(response.status)) terminal = 'readiness_terminal_http_' + response.status;
      const body = await boundedBody(response);
      Object.assign(observation, { bodyTruncated: body.truncated,
        bodyDigest: createHash('sha256').update(body.text).digest('hex') });
      if (response.status === 200) {
        try { identity = JSON.parse(body.text); } catch { terminal = 'readiness_invalid_json'; }
        const legacy = identity?.checkout === 'deferred' && identity?.sourceRevision !== revision
          && /^[0-9a-f]{40}$/.test(identity?.sourceRevision ?? '') && identity?.storage === 'browser-only';
        if (!terminal && (body.truncated || identity?.ok !== true || identity?.profile !== 'local-first'
          || !legacy && (identity?.checkout !== 'sandbox' || identity?.storage !== 'browser-only' || identity?.realMoney !== false
          || identity?.paymentStorage !== 'stripe-test' || identity?.paymentProvider !== 'stripe'))) terminal = 'readiness_invalid_profile';
        if (!terminal) {
          observation.sourceRevision = identity.sourceRevision;
          observation.workerVersionId = identity.workerVersionId;
          if (identity.sourceRevision === revision && (!versionId || identity.workerVersionId === versionId)) {
            observation.matched = true; observe(observation); return identity;
          }
          observation.error = 'readiness_identity_not_converged';
        }
      }
    } catch (error) {
      observation.error = error.message;
    }
    if (terminal) observation.error = terminal;
    observe(observation);
    if (terminal) throw Error(terminal);
    if (now() >= deadline) throw Error('readiness_convergence_deadline');
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}

// Provider/readiness convergence does not establish the browser's served document.
// Retry only reads of an exact document, accepting just the known predecessor while it propagates.
export async function waitForBrowserDocument({ url, revision, previousRevision = null, navigate,
  observe = () => {}, now = Date.now, sleep = delay, timeoutMs = 45000, intervalMs = 2000 }) {
  if (!/^[a-f0-9]{40}$/.test(revision) || previousRevision !== null && !/^[a-f0-9]{40}$/.test(previousRevision)
    || typeof navigate !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 45000
    || !Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 5000) throw Error('browser_document_invalid_input');
  const expectedUrl = new URL(url); expectedUrl.hash = '';
  const deadline = now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    const observation = { attempt: ++attempt, expectedRevision: revision, observedAt: new Date(now()).toISOString() };
    let response, terminal;
    try {
      response = await navigate(url, { timeout: Math.max(1, Math.min(8000, deadline - now())) });
      if (!response) terminal = 'browser_document_absent_response';
      else {
        const headers = response.headers(), actualUrl = new URL(response.url()); actualUrl.hash = '';
        Object.assign(observation, { status: response.status(), sourceRevision: headers['x-commerce-source'],
          contentType: headers['content-type'], ray: headers['cf-ray'] });
        if (actualUrl.href !== expectedUrl.href || response.request().redirectedFrom()) terminal = 'browser_document_redirect';
        else if (![200, 404, 503].includes(observation.status)) terminal = 'browser_document_terminal_http_' + observation.status;
        else if (observation.status === 200) {
          if (!/^text\/html(?:;|$)/i.test(observation.contentType ?? '') || headers['x-commerce-profile'] !== 'local-first')
            terminal = 'browser_document_invalid_profile';
          else if (observation.sourceRevision === revision) {
            observation.matched = true; observe(observation); return response;
          } else if (previousRevision && observation.sourceRevision === previousRevision)
            observation.error = 'browser_document_identity_not_converged';
          else terminal = 'browser_document_unexpected_source';
        }
      }
    } catch (error) { observation.error = error.message; }
    if (terminal) observation.error = terminal;
    observe(observation);
    if (terminal) throw Error(terminal);
    if (now() >= deadline) throw Error('browser_document_convergence_deadline');
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}
