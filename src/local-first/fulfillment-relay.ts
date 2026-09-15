import { createAgentRunClient } from 'agentic-os/agents/invocation';
import { deviceHostHeaders, parseDeviceHostPins, type DeviceHostPins } from '../sandbox/device-host.ts';
import { isRecord, readJsonResponse } from '../shared/http.ts';
import { LISTING_DEFINITION } from './fulfillment-definition.ts';
import { FULFILLMENT_AGENT, FulfillmentFailure, type FulfillmentRuntime, type RunContext } from './fulfillment-contract.ts';

export const LISTING_HOST_CONTRACT = 'commerce.listing-host/v1';
export const LISTING_HOST_READY_PATH = '/agentic-commerce-os/fulfillment/host-ready';
export type ListingHostPins = Readonly<DeviceHostPins & { sourceRevision: string }>;
export type ListingRelayEnv = Readonly<{ LISTING_HOST_PINS_JSON?: string; LISTING_HOST_BEARER?: string }>;

export function parseListingHostPins(value: unknown): ListingHostPins {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'bundleSha256,imageId,origin,sourceRevision'
    || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceRevision)
    || /^0+$/u.test(value.sourceRevision)) throw Error('listing_host_pins_invalid');
  const pins = parseDeviceHostPins({ origin: value.origin, bundleSha256: value.bundleSha256, imageId: value.imageId });
  if (pins.imageId !== LISTING_DEFINITION.imageDigest.slice(7)) throw Error('listing_host_image_mismatch');
  return Object.freeze({ ...pins, sourceRevision: value.sourceRevision });
}

export function listingHostHeaders(pins: ListingHostPins, token: string, context?: RunContext): Headers {
  const headers = deviceHostHeaders(pins, token);
  headers.set('x-commerce-host-source', pins.sourceRevision);
  headers.set('x-commerce-host-definition', FULFILLMENT_AGENT.revision);
  if (context) {
    if (Object.keys(context).sort().join() !== 'principalExpiresAt,principalId'
      || !/^commerce-[a-f0-9]{64}$/u.test(context.principalId)
      || !Number.isSafeInteger(context.principalExpiresAt) || context.principalExpiresAt <= Date.now()
      || context.principalExpiresAt > Date.now() + 7 * 86400000) throw Error('listing_host_context_invalid');
    headers.set('x-commerce-principal-id', context.principalId);
    headers.set('x-commerce-principal-expires', String(context.principalExpiresAt));
  }
  return headers;
}

export function listingHostIdentity(pins: ListingHostPins) {
  return { ok: true, contract: LISTING_HOST_CONTRACT, availability: 'device-session',
    bundleSha256: pins.bundleSha256, imageId: pins.imageId, sourceRevision: pins.sourceRevision,
    definitionRevision: FULFILLMENT_AGENT.revision, modelSha256: LISTING_DEFINITION.modelSha256 } as const;
}

/** Construction does no I/O. Each invocation receives immutable server-derived context. */
export function createFulfillmentRelay(env: ListingRelayEnv, send: typeof fetch = fetch): FulfillmentRuntime | undefined {
  if (env.LISTING_HOST_PINS_JSON === undefined && env.LISTING_HOST_BEARER === undefined) return undefined;
  if (typeof env.LISTING_HOST_PINS_JSON !== 'string' || env.LISTING_HOST_PINS_JSON.length > 2048
    || typeof env.LISTING_HOST_BEARER !== 'string') throw Error('listing_host_configuration_incomplete');
  const pins = parseListingHostPins(JSON.parse(env.LISTING_HOST_PINS_JSON)), token = env.LISTING_HOST_BEARER;
  listingHostHeaders(pins, token);
  return Object.freeze({
    async ready(signal: AbortSignal) {
      const response = await send(new Request(pins.origin + LISTING_HOST_READY_PATH, {
        headers: listingHostHeaders(pins, token), redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      }));
      if (response.status !== 200 || response.redirected || response.headers.get('cache-control') !== 'no-store'
        || !response.headers.get('content-type')?.startsWith('application/json')) {
        await response.body?.cancel(); throw Error('listing_host_unavailable');
      }
      const actual = await readJsonResponse(response, 4096), expected = listingHostIdentity(pins);
      if (!isRecord(actual) || Object.keys(actual).sort().join() !== Object.keys(expected).sort().join()
        || Object.entries(expected).some(([key, value]) => actual[key] !== value)) throw Error('listing_host_identity_mismatch');
      return expected;
    },
    async invoke(operation, input, context, signal) {
      const headers = listingHostHeaders(pins, token, Object.freeze({ ...context }));
      const client = createAgentRunClient({ endpoint: pins.origin + '/api/agent-swarm/',
        fetchImpl: send, getHeaders: () => headers, timeoutMs: 55000 });
      const result = await client.invoke(operation, input, { signal });
      // Transport refusal is not a terminal job state. Keep the browser's prior handle/result.
      if (result.writeResultUnknown === true || typeof result.httpStatus === 'number'
        && ![401, 403, 409].includes(result.httpStatus)) throw Object.assign(
        new FulfillmentFailure(503, 'fulfillment_transport_unavailable'), { writeResultUnknown: result.writeResultUnknown === true });
      return result;
    },
  });
}
