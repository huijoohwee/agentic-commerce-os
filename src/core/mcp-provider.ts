import { isRecord } from '../shared/http'
import { canonicalJson } from '../shared/digest'
import { DOCS_INVOCATION_ENDPOINT, MCP_PROTOCOL_VERSION } from '../invocation'

const MAXIMUM_RESPONSE_BYTES = 1_000_000
const MCP_REQUEST_TIMEOUT_MS = 10_000

type JsonRpc = Record<string, unknown>

export type McpToolCall = Readonly<{
  name: string
  arguments: Readonly<Record<string, unknown>>
}>

export async function callMcpTool(binding: Fetcher, call: McpToolCall): Promise<unknown> {
  const session = await initialize(binding)
  try {
    const rpc = await postRpc(binding, session.endpoint, session.sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: call.name, arguments: call.arguments },
    })
    if (isRecord(rpc.error)) throw new Error(readError(rpc.error))
    if (!isRecord(rpc.result) || rpc.result.isError === true) {
      throw new Error('MCP tool returned an error result.')
    }
    return extractToolPayload(rpc.result)
  } finally {
    await close(binding, session.endpoint, session.sessionId)
  }
}

export async function listMcpToolNames(binding: Fetcher): Promise<readonly string[]> {
  const session = await initialize(binding)
  try {
    const rpc = await postRpc(binding, session.endpoint, session.sessionId, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    })
    if (isRecord(rpc.error)) throw new Error(readError(rpc.error))
    if (!isRecord(rpc.result) || !Array.isArray(rpc.result.tools)) {
      throw new Error('MCP tools/list result is malformed.')
    }
    const names = rpc.result.tools.map((entry) => (
      isRecord(entry) && typeof entry.name === 'string' ? entry.name : ''
    ))
    if (names.some((name) => !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(name))) {
      throw new Error('MCP tools/list returned an invalid tool name.')
    }
    return Object.freeze([...new Set(names)].sort())
  } finally {
    await close(binding, session.endpoint, session.sessionId)
  }
}

async function initialize(binding: Fetcher): Promise<Readonly<{ endpoint: string; sessionId: string }>> {
  const endpoint = DOCS_INVOCATION_ENDPOINT
  const response = await binding.fetch(endpoint, {
    method: 'POST',
    headers: mcpHeaders(),
    signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agentic-commerce-os', version: '0.1.0' },
      },
    }),
  })
  const rpc = parseMcpEnvelope(await boundedResponseText(response))
  if (!response.ok
    || rpc.jsonrpc !== '2.0'
    || rpc.id !== 1
    || isRecord(rpc.error)
    || !isRecord(rpc.result)
    || rpc.result.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error(isRecord(rpc.error) ? readError(rpc.error) : 'MCP initialization failed.')
  }
  const sessionId = response.headers.get('mcp-session-id') ?? ''
  if (!/^[\x21-\x7e]{1,256}$/u.test(sessionId)) {
    throw new Error('MCP initialization did not return a valid session identifier.')
  }
  const notification = await binding.fetch(endpoint, {
    method: 'POST',
    headers: mcpHeaders(sessionId),
    signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  if (!notification.ok) throw new Error('MCP initialized notification failed.')
  await notification.body?.cancel()
  return Object.freeze({ endpoint, sessionId })
}

async function postRpc(
  binding: Fetcher,
  endpoint: string,
  sessionId: string,
  body: JsonRpc,
): Promise<JsonRpc> {
  const response = await binding.fetch(endpoint, {
    method: 'POST',
    headers: mcpHeaders(sessionId),
    signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    body: JSON.stringify(body),
  })
  const rpc = parseMcpEnvelope(await boundedResponseText(response))
  if (!response.ok) throw new Error(`MCP request failed with HTTP ${response.status}.`)
  if (rpc.jsonrpc !== '2.0' || rpc.id !== body.id) {
    throw new Error('MCP response identity did not match the request.')
  }
  return rpc
}

function mcpHeaders(sessionId = ''): Headers {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  })
  if (sessionId) headers.set('mcp-session-id', sessionId)
  return headers
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAXIMUM_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('MCP response exceeded the configured size bound.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let length = 0
  let text = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel('MCP response exceeded bound')
        throw new Error('MCP response exceeded the configured size bound.')
      }
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseMcpEnvelope(text: string): JsonRpc {
  const direct = parseRecord(text)
  if (direct) return direct
  const frames = text.split(/\r?\n\r?\n/u).slice(-16)
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const data = frames[index]?.split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n') ?? ''
    const record = parseRecord(data)
    if (record) return record
  }
  throw new Error('MCP returned an unreadable JSON-RPC response.')
}

function extractToolPayload(result: Record<string, unknown>): unknown {
  const structured = isRecord(result.structuredContent) ? result.structuredContent : null
  const content = Array.isArray(result.content) ? result.content : []
  const textBlock = content.find((entry) => (
    isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string'
  ))
  let textPayload: unknown = null
  if (isRecord(textBlock) && typeof textBlock.text === 'string') {
    try {
      textPayload = JSON.parse(textBlock.text) as unknown
    } catch {
      textPayload = textBlock.text
    }
  }
  if (structured && textPayload !== null && canonicalJson(structured) !== canonicalJson(textPayload)) {
    throw new Error('MCP structured and text payloads disagree.')
  }
  if (structured) return structured
  if (textPayload !== null) return textPayload
  throw new Error('MCP tool payload is missing.')
}

function parseRecord(value: string): JsonRpc | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readError(error: Record<string, unknown>): string {
  return typeof error.message === 'string'
    ? error.message.slice(0, 512)
    : 'MCP request failed.'
}

async function close(binding: Fetcher, endpoint: string, sessionId: string): Promise<void> {
  try {
    const response = await binding.fetch(endpoint, {
      method: 'DELETE',
      headers: mcpHeaders(sessionId),
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    })
    await response.body?.cancel()
  } catch {
    // The tool result is authoritative; best-effort session cleanup cannot replace it.
  }
}
