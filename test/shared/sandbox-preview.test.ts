import { describe, expect, it } from 'vitest'

import {
  PREVIEW_CONTRACT,
  handlePreviewRequest,
  type PreviewIdentity,
  type PreviewRepository,
} from '../../src/sandbox/preview'

describe('persisted engagement preview', () => {
  it('creates one addressable identity and revokes it exactly at its lifetime', async () => {
    const records = new Map<string, unknown>()
    const createdAtMs = Date.UTC(2026, 7, 30)
    const createResponse = await handlePreviewRequest(jsonRequest('/v1/previews', {
      engagementId: 'merchant-engagement',
      lifetimeHours: 1,
    }), repository(records), createdAtMs)
    expect(createResponse?.status).toBe(201)
    const created = await createResponse?.json<{
      contract: string
      identity: PreviewIdentity
    }>()
    expect(created).toMatchObject({
      contract: PREVIEW_CONTRACT,
      identity: {
        engagementId: 'merchant-engagement',
        address: expect.stringMatching(/^\/preview\/[0-9a-f]{32}$/u),
      },
    })
    if (!created) throw new Error('preview_creation_fixture_invalid')

    const addressedBeforeExpiry = await handlePreviewRequest(
      new Request(`https://sandbox.test${created.identity.address}`),
      repository(records),
      createdAtMs + 3_599_999,
    )
    expect(addressedBeforeExpiry?.status).toBe(200)
    await expect(addressedBeforeExpiry?.json()).resolves.toMatchObject({
      ok: true,
      contract: PREVIEW_CONTRACT,
      identity: { previewId: created.identity.previewId },
    })

    const addressedAtExpiry = await handlePreviewRequest(
      new Request(`https://sandbox.test${created.identity.address}`),
      repository(records),
      createdAtMs + 3_600_000,
    )
    expect(addressedAtExpiry?.status).toBe(410)
    await expect(addressedAtExpiry?.json()).resolves.toEqual({
      ok: false,
      contract: PREVIEW_CONTRACT,
      code: 'preview_revoked',
      previewId: created.identity.previewId,
    })
    expect(records.has(created.identity.previewId)).toBe(false)
  })

  it('reuses the engagement-scoped address while replacing its persisted lifetime', async () => {
    const records = new Map<string, unknown>()
    const first = await createPreview(records, Date.UTC(2026, 7, 30))
    const second = await createPreview(records, Date.UTC(2026, 7, 30, 1))
    expect(second.previewId).toBe(first.previewId)
    expect(second.createdAt).not.toBe(first.createdAt)
    expect(records.size).toBe(1)
    expect(records.get(second.previewId)).toEqual(second)
  })

  it('rejects an overlong lifetime and reports persistence failures as blocked', async () => {
    const invalid = await handlePreviewRequest(jsonRequest('/v1/previews', {
      engagementId: 'merchant-engagement',
      lifetimeHours: 25,
    }), repository(new Map()), Date.UTC(2026, 7, 30))
    expect(invalid?.status).toBe(400)
    await expect(invalid?.json()).resolves.toMatchObject({ ok: false, code: 'preview_request_invalid' })

    const unavailableRepository: PreviewRepository = Object.freeze({
      async save() { throw new Error('unavailable') },
      async read() { throw new Error('unavailable') },
      async delete() { throw new Error('unavailable') },
    })
    const blocked = await handlePreviewRequest(jsonRequest('/v1/previews', {
      engagementId: 'merchant-engagement',
      lifetimeHours: 1,
    }), unavailableRepository, Date.UTC(2026, 7, 30))
    expect(blocked?.status).toBe(503)
    await expect(blocked?.json()).resolves.toMatchObject({
      ok: false,
      code: 'sandbox_blocked',
      reason: 'preview_persistence_failed',
      rung: 'dev-proven',
    })
  })
})

function repository(records: Map<string, unknown>): PreviewRepository {
  return Object.freeze({
    async save(identity: PreviewIdentity) { records.set(identity.previewId, identity) },
    async read(previewId: string) { return records.get(previewId) },
    async delete(previewId: string) { records.delete(previewId) },
  })
}

async function createPreview(records: Map<string, unknown>, nowMs: number): Promise<PreviewIdentity> {
  const response = await handlePreviewRequest(jsonRequest('/v1/previews', {
    engagementId: 'merchant-engagement',
    lifetimeHours: 1,
  }), repository(records), nowMs)
  const body = await response?.json<{ identity?: PreviewIdentity }>()
  if (!body?.identity) throw new Error('preview_creation_fixture_invalid')
  return body.identity
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://sandbox.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
