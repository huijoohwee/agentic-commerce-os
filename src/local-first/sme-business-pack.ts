import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.ts'
// @ts-expect-error The browser-safe JavaScript module is shared by the UI and the Worker.
import { invokeSmePackTool, PACK_INDEX, PACK_PATH, TOOL_NAMES } from '../../public/local-first/sme-business-pack-core.js'

export const SME_PACK_LIMITS = Object.freeze({ requestBytes: 32768, responseBytes: 65536, deadlineMs: 2000 })
const inputSchemas = Object.freeze({
  'pack.list': { type: 'object', properties: {}, additionalProperties: false },
  'pack.required_fields': { type: 'object', required: ['pack_id'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map((pack: any) => pack.id) } }, additionalProperties: false },
  'takeover.check_listing': { type: 'object', required: ['pack_id', 'facts'], properties: {
    pack_id: { type: 'string', enum: PACK_INDEX.map((pack: any) => pack.id) }, facts: { type: 'object', maxProperties: 40 },
  }, additionalProperties: false },
  'takeover.transfer_checklist': { type: 'object', required: ['pack_id'], properties: { pack_id: { type: 'string', enum: PACK_INDEX.map((pack: any) => pack.id) } }, additionalProperties: false },
})
const descriptions: Record<string, string> = {
  'pack.list': 'List provisional Singapore and Malaysia F&B takeover packs. No inference or external data call.',
  'pack.required_fields': 'Read the closed F&B takeover facts required by one versioned jurisdiction pack.',
  'takeover.check_listing': 'Compute completeness and a labelled arithmetic report. Inputs are not stored or verified.',
  'takeover.transfer_checklist': 'Read a transfer checklist only after qualified review; provisional packs return no checklist content.',
}
export const SME_PACK_TOOLS = Object.freeze(TOOL_NAMES.map((name: string) => Object.freeze({
  name, title: name.replaceAll('.', ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
  description: descriptions[name]!, inputSchema: inputSchemas[name as keyof typeof inputSchemas]!,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
})))

function failure(status: number, code: string) {
  return Response.json({ ok: false, code }, { status, headers: { 'cache-control': 'no-store' } })
}
function safeCode(error: unknown) {
  return error instanceof Error && /^sme_pack_[a-z_]+$/u.test(error.message) ? error.message : 'sme_pack_request_refused'
}
function responseWithinLimit(response: Response): Promise<Response> {
  return response.text().then(text => new TextEncoder().encode(text).byteLength > SME_PACK_LIMITS.responseBytes
    ? failure(503, 'sme_pack_response_too_large') : new Response(text || null, { status: response.status, headers: response.headers }))
}
function requestBody(request: Request, signal: AbortSignal) {
  const headers = new Headers(request.headers)
  return new Request(request.url, { method: 'POST', headers, body: request.body?.pipeThrough(new TransformStream(), { signal }) ?? null,
    signal, duplex: 'half' } as RequestInit)
}
function toolSchemas() { return SME_PACK_TOOLS }

/** Stateless, no-retention R1 API/MCP adapter. Local-first callers use the same pure evaluator offline. */
export async function handleSmeBusinessPackRequest(request: Request, sourceRevision: string): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== PACK_PATH && !url.pathname.startsWith(PACK_PATH + '/')) return null
  const route = url.pathname.slice(PACK_PATH.length)
  if (!['/api', '/mcp', '/service.json'].includes(route)) return null
  if (url.search) return failure(400, 'sme_pack_query_refused')
  if (request.headers.has('authorization') || request.headers.has('cookie') || request.headers.has('content-encoding')
    || request.headers.has('origin') && request.headers.get('origin') !== url.origin) {
    return failure(403, 'sme_pack_credentials_or_origin_refused')
  }
  const localBuild = sourceRevision === 'local-unreleased'
  if (!localBuild && !/^[0-9a-f]{40}$/u.test(sourceRevision)) return failure(503, 'sme_pack_release_identity_invalid')
  if (route === '/service.json') {
    if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'get_required')
    return Response.json({ schema: 'sme-business-pack-service/v1', continuityId: 'sme-business-pack',
      availability: localBuild ? 'local-development' : 'edge-enabled', sourceRevision,
      scope: 'compute-only', persistence: 'none', inferenceTokens: 0, tools: toolSchemas(),
      packs: PACK_INDEX, limits: SME_PACK_LIMITS, api: PACK_PATH + '/api', mcp: PACK_PATH + '/mcp' },
    { headers: { 'cache-control': 'no-store' } })
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const controller = new AbortController(), signal = AbortSignal.any([request.signal, controller.signal])
  const timer = setTimeout(() => controller.abort(), SME_PACK_LIMITS.deadlineMs)
  let server: Server | undefined, transport: WebStandardStreamableHTTPServerTransport | undefined
  try {
    const body = await readJsonObject(requestBody(request, signal), SME_PACK_LIMITS.requestBytes)
    if (isHttpFailure(body)) return failure(body.code === 'body_too_large' ? 413 : body.code === 'content_type_required' ? 415 : 400, body.code)
    if (route === '/api') {
      if (!isRecord(body) || Object.keys(body).sort().join(',') !== 'arguments,tool' || typeof body.tool !== 'string' || !isRecord(body.arguments)) {
        return failure(400, 'sme_pack_arguments_invalid')
      }
      try { return await responseWithinLimit(Response.json(await invokeSmePackTool(body.tool, body.arguments))) }
      catch (error) { return failure(422, safeCode(error)) }
    }
    server = new Server({ name: 'sme-business-pack', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolSchemas() }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const value = await invokeSmePackTool(params.name, params.arguments ?? {})
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value }
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: safeCode(error) }] } }
    })
    transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    const mcpRequest = new Request(request.url, { method: 'POST', signal, headers: {
      'content-type': 'application/json', accept: request.headers.get('accept') ?? '',
      ...(request.headers.has('mcp-protocol-version') ? { 'mcp-protocol-version': request.headers.get('mcp-protocol-version')! } : {}),
    } })
    const response = await transport.handleRequest(mcpRequest, { parsedBody: body })
    return await responseWithinLimit(response)
  } catch (error) {
    return failure(signal.aborted ? 504 : 422, signal.aborted ? 'sme_pack_deadline_or_cancelled' : safeCode(error))
  } finally { clearTimeout(timer); await server?.close(); await transport?.close() }
}
