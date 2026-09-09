import { isHttpFailure, isRecord, jsonResponse, readJsonObject, readJsonResponse } from '../shared/http.ts'
import { parseSandboxRequest } from './isolation.ts'
import { deviceHostHeaders, parseDeviceHostPins, probeDeviceHost, type DeviceHostFetch } from './device-host.ts'

/** Private service-binding facade; the device host remains the execution owner. */
export async function handleDeviceSandbox(request: Request, env: DeviceSandboxEnv,
  send: DeviceHostFetch = value => fetch(value)): Promise<Response> {
  const url = new URL(request.url)
  if (request.headers.has('origin') || request.headers.has('content-encoding')) {
    return jsonResponse({ ok: false, code: 'sandbox_request_authority_invalid' }, 403)
  }
  if (url.search || !((request.method === 'GET' && ['/livez', '/readyz'].includes(url.pathname))
    || (request.method === 'POST' && url.pathname === '/v1/run'))) {
    return jsonResponse({ ok: false, code: 'not_found' }, 404)
  }
  if (url.pathname === '/livez') return jsonResponse({ ok: true, contract: 'agentic-graph-sandbox/v1',
    readinessRung: 'dev-proven', deliveryBoundary: 'closed' })
  try {
    const pins = parseDeviceHostPins({ origin: env.EXECUTION_HOST_URL,
      bundleSha256: env.EXECUTION_HOST_BUNDLE_SHA256, imageId: env.EXECUTION_HOST_IMAGE_ID })
    const version = env.CF_VERSION_METADATA
    if (!['Production', 'Staging'].includes(env.DEPLOY_LANE)
      || !/^[a-f0-9]{40}$/u.test(env.RELEASE_CANDIDATE_SHA)
      || !/^[a-f0-9]{64}$/u.test(env.RELEASE_CANDIDATE_DIGEST)
      || !version?.id || version.tag !== env.RELEASE_CANDIDATE_SHA
      || !Number.isFinite(Date.parse(version.timestamp))) throw Error('sandbox_release_identity_invalid')
    if (url.pathname === '/readyz') {
      const hostProbe = await probeDeviceHost(pins, env.EXECUTION_HOST_BEARER_TOKEN, send, request.signal)
      return jsonResponse({ ok: true, contract: 'agentic-commerce-registration-sandbox/v1',
        lane: env.DEPLOY_LANE, releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
        releaseCandidateDigest: env.RELEASE_CANDIDATE_DIGEST, version, hostProbe })
    }
    const body = await readJsonObject(request, 1_000_000)
    if (isHttpFailure(body)) return jsonResponse(body, 400)
    const parsed = parseSandboxRequest(body)
    if (!parsed) return jsonResponse({ ok: false, code: 'sandbox_request_invalid' }, 400)
    await probeDeviceHost(pins, env.EXECUTION_HOST_BEARER_TOKEN, send, request.signal)
    // Host v2 compares both pins immediately before accepting the job. No retry or redirect.
    const response = await send(new Request(`${pins.origin}/v1/run`, { method: 'POST',
      headers: deviceHostHeaders(pins, env.EXECUTION_HOST_BEARER_TOKEN),
      body: JSON.stringify(parsed), redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(parsed.limits.wallClockSeconds * 1_000 + 10_000)]),
    }))
    if (![200, 409, 422, 503].includes(response.status) || response.redirected
      || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel(); throw Error('sandbox_response_invalid')
    }
    const result = await readJsonResponse(response, 1_000_000)
    if (!isRecord(result) || typeof result.ok !== 'boolean' || !isRecord(result.record)
      || typeof result.record.instanceId !== 'string' || !/^run-[a-f0-9]{32}$/u.test(result.record.instanceId)
      || result.record.purpose !== parsed.purpose || (result.ok && response.status !== 200)
      || (!result.ok && response.status === 200)) throw Error('sandbox_response_invalid')
    return jsonResponse(result, response.status)
  } catch {
    return jsonResponse({ ok: false, code: 'sandbox_blocked', reason: 'device_executor_unavailable' }, 503)
  }
}

export default { fetch(request, env) { return handleDeviceSandbox(request, env) } } satisfies ExportedHandler<DeviceSandboxEnv>
