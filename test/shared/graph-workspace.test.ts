import { describe, expect, it } from 'vitest'
import { dashboardResponse } from '../../src/edge/dashboard'
import { graphWorkspaceUrl } from '../../src/edge/graph-workspace'

const metadata = { lane: 'Production', releaseCandidateSha: 'a'.repeat(40), version: { id: 'edge-version' } }

describe('Graph workspace navigation', () => {
  it('opens the owner-supported workspace without passing commerce state', () => {
    expect(graphWorkspaceUrl('https://airvio.co/agentic-graph/', 'Production'))
      .toBe('https://airvio.co/agentic-graph/?openEditorWorkspace=1')
    expect(graphWorkspaceUrl('https://canvas.example/workspace/', 'Production'))
      .toBe('https://canvas.example/workspace/?openEditorWorkspace=1')
    expect(graphWorkspaceUrl(undefined, 'Production')).toBeNull()
    expect(graphWorkspaceUrl('', 'Production')).toBeNull()
  })
  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'http://canvas.example/',
    'https://user:secret@canvas.example/', 'https://canvas.example/?token=private',
    'https://canvas.example/#private', ' https://canvas.example/', 'https://canvas.example/\n',
    'https://canvas.example/\\bad', 'https://airvio.co/agentic-commerce-os/',
    'https://airvio.co/agentic-commerce-os', `https://canvas.example/${'a'.repeat(2048)}`,
  ])('rejects unsafe or state-bearing configuration: %s', value => {
    expect(() => graphWorkspaceUrl(value, 'Production')).toThrow('graph_workspace_url_invalid')
  })
  it('permits cleartext only on loopback in explicit development lanes', () => {
    for (const lane of ['Local', 'Dev']) {
      expect(graphWorkspaceUrl('http://127.0.0.1:5173/', lane)).toContain('openEditorWorkspace=1')
    }
    for (const lane of ['Production', 'Staging', 'dev', 'unknown']) {
      expect(() => graphWorkspaceUrl('http://localhost:5173/', lane)).toThrow()
    }
  })
  it('keeps cross-window authority isolated and omits the link when delivery is closed', async () => {
    const options = { graphWorkspaceUrl: 'https://airvio.co/agentic-graph/' }
    const response = dashboardResponse(metadata, options)
    const html = await response.text()
    expect(html).toContain('href="https://airvio.co/agentic-graph/?openEditorWorkspace=1"')
    expect(html).toContain('target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"')
    expect(html).not.toMatch(/<iframe|rel="(?:prefetch|preload|preconnect)"/u)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    for (const disabled of [{}, { ...options, deliveryBoundary: 'closed' as const }]) {
      expect(await dashboardResponse(metadata, disabled).text()).not.toContain('Open in canvas')
    }
  })
})
