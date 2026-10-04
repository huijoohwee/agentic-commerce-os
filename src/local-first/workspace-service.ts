import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import tokenMap from '../../config/capability-token-map.json' with { type: 'json' }
import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.ts'
// Browser and edge intentionally execute the same validated, DOM-free capability owner.
// @ts-expect-error The native browser module is JavaScript; its transport contract is verified by integration tests.
import { WORKSPACE_TOOLS, WORKSPACE_LIMITS, invokeWorkspace, parseWorkspaceInvocation } from '../../public/local-first/workspace-capabilities.js'

export const WORKSPACE_SERVICE_PATH = '/agentic-commerce-os/services/workspace'
function routingTokens() {
  const owner = tokenMap.find(row => row.capabilityAction === 'invocation.resolve')
  if (!owner || owner.bindingTokens.length !== 1 || owner.semanticTokens.length !== 1) throw Error('workspace_routing_unavailable')
  return { commandToken: owner.commandToken, bindingToken: owner.bindingTokens[0], semanticToken: owner.semanticTokens[0] }
}
/** Explicit caller snapshots and bounded environment reads; no persistence, credentials or agent writes. */
export async function handleWorkspaceService(request: Request, sourceRevision: string,
  environment: (signal?: AbortSignal) => unknown): Promise<Response | null> {
  const url = new URL(request.url), route = url.pathname.slice(WORKSPACE_SERVICE_PATH.length)
  if (!url.pathname.startsWith(WORKSPACE_SERVICE_PATH + '/') || !['/api', '/invoke', '/mcp', '/service.json'].includes(route)) return null
  const fail = (status: number, code: string) => Response.json({ ok: false, code }, { status })
  if (url.search) return fail(400, 'workspace_query_refused')
  if (request.headers.has('authorization') || request.headers.has('cookie') || request.headers.has('content-encoding')
    || request.headers.has('origin') && request.headers.get('origin') !== url.origin) return fail(403, 'workspace_credentials_or_origin_refused')
  if (route === '/service.json') {
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'get_required')
    return Response.json({ schema: 'commerce.workspace-service/v1', sourceRevision, scope: 'read-only',
      registryAdmission: 'not-claimed', persistence: 'none', routing: routingTokens(), tools: WORKSPACE_TOOLS,
      limits: WORKSPACE_LIMITS, api: WORKSPACE_SERVICE_PATH + '/api', mcp: WORKSPACE_SERVICE_PATH + '/mcp' })
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const deadline = new AbortController(), signal = AbortSignal.any([request.signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(), WORKSPACE_LIMITS.deadlineMs)
  let server: Server | undefined
  const invoke = (name: unknown, args: unknown) => invokeWorkspace(name, args, { signal, environment })
  try {
    const bounded = new Request(request, { body: request.body?.pipeThrough(new TransformStream(), { signal }) ?? null,
      signal, ...{ duplex: 'half' } })
    const body = await readJsonObject(bounded, WORKSPACE_LIMITS.requestBytes)
    if (isHttpFailure(body)) return fail(body.code === 'body_too_large' ? 413 : body.code === 'content_type_required' ? 415 : 400, body.code)
    if (route !== '/mcp') {
      const field = route === '/invoke' ? 'invocation' : 'name'
      if (Object.keys(body).sort().join() !== ['arguments', field].sort().join() || !isRecord(body.arguments)) throw Error('workspace_arguments_invalid')
      return Response.json(await invoke(route === '/invoke' ? parseWorkspaceInvocation(body.invocation, routingTokens()) : body.name, body.arguments))
    }
    server = new Server({ name: 'agentic-commerce-os-workspace', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: WORKSPACE_TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await invoke(params.name, params.arguments ?? {})) }] } }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: errorCode(error) }] } }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    const response = await transport.handleRequest(new Request(request.url, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: request.headers.get('accept') ?? '',
        ...(request.headers.has('mcp-protocol-version') ? { 'mcp-protocol-version': request.headers.get('mcp-protocol-version')! } : {}) } }), { parsedBody: body })
    const text = await response.text()
    if (new TextEncoder().encode(text).length >= 500000) return fail(503, 'workspace_result_limit')
    return new Response(response.status === 202 ? null : text, { status: response.status, headers: response.headers })
  } catch (error) { return fail(signal.aborted ? 504 : 422, signal.aborted ? 'workspace_cancelled' : errorCode(error)) }
  finally { clearTimeout(timer); await server?.close() }
}
function errorCode(error: unknown) {
  return error instanceof Error && /^workspace_[a-z_]+$/.test(error.message) ? error.message : 'workspace_request_refused'
}
