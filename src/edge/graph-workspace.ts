/** Graph owns the workspace runtime. This is navigation, never a credential handoff. */
export function graphWorkspaceUrl(configured: string | undefined, lane: string): string | null {
  if (configured === undefined || configured === '') return null
  if (configured.length > 2_048 || configured !== configured.trim()
    || /[\u0000-\u0020\u007f\\]/u.test(configured)) throw new Error('graph_workspace_url_invalid')
  let url: URL
  try { url = new URL(configured) } catch { throw new Error('graph_workspace_url_invalid') }
  const local = (lane === 'Local' || lane === 'Dev')
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash
    || url.pathname === '/agentic-commerce-os'
    || url.pathname.startsWith('/agentic-commerce-os/')) throw new Error('graph_workspace_url_invalid')
  url.searchParams.set('openEditorWorkspace', '1')
  return url.href
}
