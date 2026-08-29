import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('commerce edge invalid Production configuration', () => {
  it('keeps the read-only browser console available for diagnosis', async () => {
    const dashboard = await SELF.fetch('https://edge.test/')
    expect(dashboard.status).toBe(200)
    await expect(dashboard.text()).resolves.toContain('Operational routes remain bearer-protected.')
  })

  it('fails readiness and blocks every operational transport', async () => {
    const ready = await SELF.fetch('https://edge.test/readyz')
    expect(ready.status).toBe(503)
    await expect(ready.json()).resolves.toMatchObject({
      ok: false,
      contract: 'commerce.edge-readiness/v1',
    })

    const http = await SELF.fetch('https://edge.test/v1/registry', {
      headers: { authorization: 'Bearer weak' },
    })
    expect(http.status).toBe(503)
    await expect(http.json()).resolves.toMatchObject({
      ok: false,
      code: 'runtime_configuration_invalid',
    })

    const mcp = await SELF.fetch('https://edge.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer weak',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(mcp.status).toBe(503)
    await expect(mcp.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_003 },
    })
  })
})
