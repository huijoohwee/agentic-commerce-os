import { isHttpFailure, isRecord, jsonResponse, readJsonObject } from '../shared/http'
import {
  authorizeHumanConfirmation,
  clearHumanConfirmationCookie,
  issueHumanConfirmation,
} from './human-confirmation'
import { readHumanPresenceTrustAnchor } from './human-presence'
import {
  edgeExternalHumanPresenceRequired,
  edgeLoopbackAllowed,
  readEdgeDeployLane,
} from './deploy-lane'
import { authorizeStorefrontSession } from './session'

type ConfirmationEnv = Readonly<{
  DEPLOY_LANE: string
  STOREFRONT_SESSION_SECRET?: string
  HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON?: string
}>

type CoreCall = (
  capabilityAction: string,
  path: string,
  init: Readonly<{ method: string; body?: string }>,
  requestId: string,
) => Promise<Readonly<{ response: Response; payload: unknown }>>

export async function confirmHumanCheckout(
  request: Request,
  env: ConfirmationEnv,
  requestId: string,
  checkoutId: string,
  callCore: CoreCall,
): Promise<Response> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(checkoutId)) {
    return jsonResponse({ ok: false, code: 'human_confirmation_invalid' }, 400)
  }
  if (!readEdgeDeployLane(env.DEPLOY_LANE)) {
    return jsonResponse({ ok: false, code: 'runtime_configuration_invalid' }, 503)
  }
  const allowLoopback = edgeLoopbackAllowed(env.DEPLOY_LANE)
  const session = await authorizeStorefrontSession(
    request,
    env.STOREFRONT_SESSION_SECRET,
    'checkout:prepare',
    Date.now(),
    allowLoopback,
  )
  if (!session.ok) return jsonResponse({ ok: false, code: 'human_confirmation_invalid' }, 401)
  const trustAnchor = readHumanPresenceTrustAnchor(env.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON)
  if (edgeExternalHumanPresenceRequired(env.DEPLOY_LANE) && !trustAnchor) {
    return jsonResponse({ ok: false, code: 'human_presence_trust_anchor_required' }, 503)
  }
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return jsonResponse(body, 400)
  const authorization = await authorizeHumanConfirmation(
    request,
    env.STOREFRONT_SESSION_SECRET,
    session.session.nonce,
    trustAnchor,
    checkoutId,
    body,
    Date.now(),
    allowLoopback,
  )
  if (!authorization.ok) return jsonResponse({ ok: false, code: authorization.code }, 401)
  const core = await callCore(
    'checkout.confirm',
    `/internal/v1/checkouts/${encodeURIComponent(checkoutId)}/confirm`,
    { method: 'POST', body: JSON.stringify(authorization.body) },
    requestId,
  )
  if (!core.response.ok
    && isRecord(core.payload)
    && core.payload.code === 'offer_reconfirmation_required'
    && typeof core.payload.blockerDigest === 'string'
    && Array.isArray(core.payload.blockers)) {
    const reissued = await issueHumanConfirmation(
      request,
      env.STOREFRONT_SESSION_SECRET,
      authorization.body,
      {
        ok: true,
        status: 'confirmation_required',
        checkoutId,
        confirmationToken: authorization.body.confirmationToken,
        confirmationExpiresAt: authorization.reissue.confirmationExpiresAt,
      },
      {
        sessionNonce: session.session.nonce,
        trustAnchor,
        blockerDigest: core.payload.blockerDigest,
        blockers: core.payload.blockers,
        expectedShopperPrincipalDigest: authorization.reissue.expectedShopperPrincipalDigest,
      },
      Date.now(),
      allowLoopback,
    )
    if (!reissued) return jsonResponse({ ok: false, code: 'human_confirmation_proof_unavailable' }, 502)
    const response = jsonResponse({ ...core.payload, humanConfirmation: reissued.publicProof }, core.response.status)
    response.headers.set('set-cookie', reissued.cookie)
    return response
  }
  const response = jsonResponse(core.payload, core.response.status)
  if (core.response.ok && isRecord(core.payload) && core.payload.ok === true) {
    response.headers.set('set-cookie', clearHumanConfirmationCookie())
  }
  return response
}
