import { validateRunInput } from 'agentic-os/agents/invocation';
import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.ts';
import { readSession, csrf, newSession, cookie, type Session } from './session.ts';
import { digest, FULFILLMENT_AGENT, FULFILLMENT_GOAL, FulfillmentFailure, validRunId, type FulfillmentRuntime } from './fulfillment-contract.ts';

const PREFIX = '/agentic-commerce-os/fulfillment/';
const STATES = new Set(['planning', 'running', 'completed', 'blocked', 'canceled', 'pending', 'idle', 'reconciling', 'synthesizing']);
type FulfillmentResult = { runId: string; status: string; text?: string; outputDigest?: string;
  reviewRequired?: boolean; plannedAt?: number };
const observationHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const fail = (status: number, code: string) => Response.json({ ok: false, code }, { status, headers: observationHeaders });
export const fulfillmentContext = async (session: Session) => ({
  principalId: 'commerce-' + await digest(session.nonce), principalExpiresAt: session.issuedAt + 7 * 86400000,
});
async function invoke(runtime: FulfillmentRuntime | undefined, session: Session,
  operation: 'start' | 'status' | 'cancel' | 'retry', input: Record<string, unknown>,
  includePlannedAt = false): Promise<FulfillmentResult> {
  if (!runtime) throw new FulfillmentFailure(503, 'fulfillment_unavailable');
  const value = await runtime.invoke(operation, input, await fulfillmentContext(session), AbortSignal.timeout(55000));
  if (!isRecord(value) || value.runId !== input.runId || !STATES.has(String(value.status)))
    throw new FulfillmentFailure(503, 'fulfillment_identity_mismatch');
  const runId = String(input.runId), status = String(value.status);
  if (['run_forbidden', 'principal_expired'].includes(String(value.reasonCode)))
    throw new FulfillmentFailure(value.reasonCode === 'run_forbidden' ? 403 : 401, 'fulfillment_access_denied');
  if (value.status === 'blocked') return { runId, status };
  if (!value.agent && ['planning', 'canceled'].includes(status)) return { runId, status };
  if (!isRecord(value.agent) || value.agent.agentId !== FULFILLMENT_AGENT.agentId || value.agent.revision !== FULFILLMENT_AGENT.revision)
    throw new FulfillmentFailure(503, 'fulfillment_definition_mismatch');
  if (value.status !== 'completed') return { runId, status };
  if (!isRecord(value.output) || typeof value.output.text !== 'string' || !value.output.text.trim()
    || new TextEncoder().encode(value.output.text).byteLength > 16000 || /\x00/u.test(value.output.text))
    throw new FulfillmentFailure(503, 'fulfillment_output_invalid');
  const text = value.output.text;
  const first = Array.isArray(value.events) ? value.events[0] : undefined;
  // The OS ledger retains its first event even when later tracing is capped.
  // This fixed server timestamp bounds separate-order creation; it never enters the public read model.
  const plannedAt = includePlannedAt && isRecord(first) && first.sequence === 1
    && first.type === 'run_planned' && typeof first.at === 'string' ? Date.parse(first.at) : NaN;
  // Product readback excludes intermediate prompts, task context and arbitrary provider fields.
  return { runId, status, text, outputDigest: await digest(text), reviewRequired: true,
    ...(includePlannedAt ? { plannedAt } : {}) };
}
export async function readFulfillment(runtime: FulfillmentRuntime | undefined, session: Session, runId: string,
  includePlannedAt = false) {
  if (!validRunId(runId)) throw new FulfillmentFailure(400, 'fulfillment_run_invalid');
  return invoke(runtime, session, 'status', { runId }, includePlannedAt);
}
export async function handleFulfillment(request: Request, secret: string | undefined,
  runtime?: FulfillmentRuntime): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const operation = url.pathname.slice(PREFIX.length);
  if (operation === 'session') {
    if (!secret || secret.length < 32 || !runtime) return fail(503, 'fulfillment_unavailable');
    if (request.method !== 'GET' || url.search) return fail(400, 'fulfillment_session_invalid');
    if (request.headers.get('sec-fetch-site') === 'cross-site'
      || request.headers.has('origin') && request.headers.get('origin') !== url.origin) return fail(403, 'fulfillment_session_invalid');
    try { await runtime.ready?.(AbortSignal.timeout(15000)); }
    catch { return fail(503, 'fulfillment_unavailable'); }
    const session = await readSession(request, secret) ?? newSession();
    return Response.json({ ok: true, csrfToken: await csrf(session, secret) },
      { headers: { 'set-cookie': await cookie(session, secret), 'cache-control': 'no-store' } });
  }
  if (!['start', 'status', 'cancel', 'retry', 'query', 'trace', 'evaluate', 'compare'].includes(operation)) return fail(404, 'not_found');
  if (request.method !== 'POST') return fail(405, 'post_required');
  if (url.search) return fail(400, 'unexpected_query');
  if (!secret || secret.length < 32 || !runtime) return fail(503, 'fulfillment_unavailable');
  const session = await readSession(request, secret);
  if (!session) return fail(401, 'checkout_session_required');
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site'
    || request.headers.get('x-commerce-csrf') !== await csrf(session, secret)
    || request.headers.has('content-encoding')) return fail(403, 'fulfillment_confirmation_required');
  const body = await readJsonObject(request, 16384);
  if (isHttpFailure(body)) return fail(body.code === 'body_too_large' ? 413 : 400, body.code);
  try {
    if (['query', 'trace', 'evaluate', 'compare'].includes(operation)) {
      const observationOperation = operation as 'query' | 'trace' | 'evaluate' | 'compare';
      let observation: Record<string, unknown>;
      try { observation = validateRunInput(observationOperation, body); }
      catch { return fail(400, 'fulfillment_observation_invalid'); }
      const value = await runtime.invoke(observationOperation, observation,
        await fulfillmentContext(session), AbortSignal.any([request.signal, AbortSignal.timeout(55000)]));
      if (!isRecord(value)) return fail(503, 'fulfillment_observation_unavailable');
      if (['run_forbidden', 'principal_expired'].includes(String(value.reasonCode)))
        return fail(value.reasonCode === 'run_forbidden' ? 403 : 401, 'fulfillment_access_denied');
      // The source runtime owns redaction and evidence schema. Preserve its native envelope.
      const status = value.status === 'blocked' ? 409 : 200;
      const streaming = status === 200 && ['query', 'trace'].includes(operation)
        && request.headers.get('accept')?.includes('text/event-stream');
      const json = JSON.stringify(value), text = streaming ? 'data: ' + json + '\n\ndata: [DONE]\n\n' : json;
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > 256 * 1024) return fail(503, 'fulfillment_observation_too_large');
      return new Response(bytes, { status, headers: { ...observationHeaders,
        'content-type': streaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8' } });
    }
    let input: Record<string, unknown>;
    if (operation === 'start') {
      if (Object.keys(body).sort().join() !== 'description,draftId,revision,title'
        || typeof body.draftId !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.draftId)
        || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1
        || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120
        || typeof body.description !== 'string' || body.description.length > 10000)
        return fail(400, 'fulfillment_draft_invalid');
      const draft = { draftId: body.draftId, revision: body.revision, title: body.title, description: body.description };
      const runId = 'listing-' + await digest(JSON.stringify([session.nonce, FULFILLMENT_AGENT, draft]));
      input = { runId, conversationId: body.draftId, agent: FULFILLMENT_AGENT,
        goal: FULFILLMENT_GOAL, input: draft, maxParallel: 1 };
    } else {
      if (!validRunId(body.runId)) return fail(400, 'fulfillment_run_invalid');
      if (operation === 'retry') {
        if (Object.keys(body).sort().join() !== 'operationId,runId' || typeof body.operationId !== 'string'
          || !/^[a-f0-9-]{36}$/u.test(body.operationId)) return fail(400, 'fulfillment_retry_invalid');
        input = { ...body, taskId: 'listing' };
      } else {
        if (Object.keys(body).join() !== 'runId') return fail(400, 'fulfillment_input_invalid');
        input = operation === 'cancel' ? { ...body, operationId: 'cancel-' + body.runId } : body;
      }
    }
    const result = await invoke(runtime, session, operation as 'start' | 'status' | 'cancel' | 'retry', input);
    return Response.json({ ok: true, ...result }, { status: ['completed', 'canceled', 'blocked'].includes(String(result.status)) ? 200 : 202 });
  } catch (error) {
    return error instanceof FulfillmentFailure ? fail(error.status, error.code) : fail(503, 'fulfillment_unavailable');
  }
}
