import { describe, expect, it, vi } from 'vitest'

import { confirmHumanCheckout } from '../../src/edge/checkout-confirmation-handler.ts'
import {
  EDGE_DEPLOY_LANES,
  edgeExternalHumanPresenceRequired,
  edgeLoopbackAllowed,
  readEdgeDeployLane,
} from '../../src/edge/deploy-lane.ts'

describe('edge deploy-lane policy', () => {
  it('accepts only the exact configured lane enum and applies the strict lane policy', () => {
    for (const lane of EDGE_DEPLOY_LANES) expect(readEdgeDeployLane(lane)).toBe(lane)
    for (const candidate of ['production', 'PRODUCTION', ' Production', 'Preview', '', null]) {
      expect(readEdgeDeployLane(candidate)).toBeNull()
      expect(edgeLoopbackAllowed(candidate)).toBe(false)
      expect(edgeExternalHumanPresenceRequired(candidate)).toBe(true)
    }
    expect(edgeLoopbackAllowed('Local')).toBe(true)
    expect(edgeLoopbackAllowed('Dev')).toBe(true)
    expect(edgeExternalHumanPresenceRequired('Staging')).toBe(true)
    expect(edgeExternalHumanPresenceRequired('Production')).toBe(true)
  })

  it('fails an unknown lane before checkout confirmation authorization or core dispatch', async () => {
    const callCore = vi.fn()
    const response = await confirmHumanCheckout(
      new Request('https://airvio.co/v1/human/checkouts/checkout-1/confirm', { method: 'POST' }),
      { DEPLOY_LANE: 'production' },
      'request-1',
      'checkout-1',
      callCore,
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ ok: false, code: 'runtime_configuration_invalid' })
    expect(callCore).not.toHaveBeenCalled()
  })
})
