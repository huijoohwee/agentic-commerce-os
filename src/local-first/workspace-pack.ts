import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createWorkspaceProgramPack, WORKSPACE_PACK_SCHEMA } from '../generated/graph-workspace-pack.js'
import graphPin from '../../config/workspace-pack-graph.json' with { type: 'json' }
import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.ts'

export const WORKSPACE_PACK_PATH = '/agentic-commerce-os/services/workspace-pack'
const TOOL = 'commerce.workspace.program-pack.create'
const LIMITS = Object.freeze({ requestBytes: 98304, sourceBytes: 32768, resultBytes: 225280, deadlineMs: 5000 })
const inputSchema = { type: 'object' as const, required: ['title', 'source', 'sourceDigest'], additionalProperties: false,
  properties: { title: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$' },
    source: { type: 'string', minLength: 1, maxLength: LIMITS.sourceBytes },
    sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }

async function convert(input: unknown, signal: AbortSignal) {
  if (signal.aborted) throw Error('workspace_pack_cancelled')
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'source,sourceDigest,title') {
    throw Error('workspace_pack_input_invalid')
  }
  // Graph's pinned native converter owns byte limits, source digest and exact round trips.
  const result = await createWorkspaceProgramPack({ schema: WORKSPACE_PACK_SCHEMA, ...input })
  if (signal.aborted) throw Error('workspace_pack_cancelled')
  return result
}

/** Pure conversion only: no code execution, network calls, credentials, persistence or payment. */
export async function handleWorkspacePack(request: Request, sourceRevision: string): Promise<Response | null> {
  const url = new URL(request.url), route = url.pathname.slice(WORKSPACE_PACK_PATH.length)
  if (!url.pathname.startsWith(WORKSPACE_PACK_PATH + '/')) return null
  if (!['/api', '/mcp', '/service.json'].includes(route)) return null
  const fail = (status: number, code: string) => Response.json({ ok: false, code }, { status })
  if (url.search) return fail(400, 'workspace_pack_query_refused')
  if (request.headers.has('authorization') || request.headers.has('cookie') || request.headers.has('content-encoding')
    || request.headers.has('origin') && request.headers.get('origin') !== url.origin) {
    return fail(403, 'workspace_pack_credentials_or_origin_refused')
  }
  if (route === '/service.json') {
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'get_required')
    return Response.json({ schema: 'commerce.workspace-pack-service/v1', id: TOOL, owner: 'agentic-commerce-os',
      title: 'Workspace Program Pack', price: { amount: '0', mode: 'free' }, availability: 'hosted-conversion',
      scope: 'conversion-only', marketplaceListed: false, registryAdmission: 'not-claimed',
      sourceRevision, graphRevision: graphPin.revision, adapterDigest: graphPin.artifact.sha256,
      limits: LIMITS, api: WORKSPACE_PACK_PATH + '/api', mcp: WORKSPACE_PACK_PATH + '/mcp' })
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const deadline = new AbortController(), signal = AbortSignal.any([request.signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(), LIMITS.deadlineMs)
  let server: Server | undefined
  try {
    // Aborting the pipe interrupts a stalled body reader as well as downstream work.
    const bounded = new Request(request, { body: request.body?.pipeThrough(new TransformStream(), { signal }) ?? null,
      signal, ...{ duplex: 'half' } })
    const body = await readJsonObject(bounded, LIMITS.requestBytes)
    if (isHttpFailure(body)) return fail(body.code === 'body_too_large' ? 413 : body.code === 'content_type_required' ? 415 : 400, body.code)
    if (route === '/api') return Response.json(await convert(body, signal))
    server = new Server({ name: 'agentic-commerce-os-workspace-pack', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: TOOL, title: 'Create a Workspace Program Pack',
      description: 'Convert supported Python into Python, Block/JSON, Markdown and Canvas files. Free. Does not execute code or publish files.',
      inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }] }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== TOOL) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool')
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await convert(params.arguments, signal)) }] } }
      catch { return { isError: true, content: [{ type: 'text' as const,
        text: 'Workspace conversion refused. Check source, digest and supported Python syntax.' }] } }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    const result = await transport.handleRequest(new Request(request.url, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: request.headers.get('accept') ?? '',
        ...(request.headers.has('mcp-protocol-version') ? { 'mcp-protocol-version': request.headers.get('mcp-protocol-version')! } : {}) } }),
    { parsedBody: body })
    // The locked SDK receives only a bounded body and one bounded Graph result.
    const text = await result.text()
    if (new TextEncoder().encode(text).length >= 500000) return fail(503, 'workspace_pack_result_limit')
    return new Response(result.status === 202 ? null : text, { status: result.status, headers: result.headers })
  } catch (error) {
    return fail(signal.aborted ? 504 : 422, error instanceof Error && /^workspace_pack_[a-z_]+$/.test(error.message)
      ? error.message : 'workspace_pack_request_refused')
  } finally { clearTimeout(timer); await server?.close() }
}
