export const MAX_REQUEST_BYTES = 65_536

export type HttpFailure = Readonly<{
  ok: false
  code: string
  message: string
}>

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  })
}

export async function readJsonObject(
  request: Request,
  maximumBytes = MAX_REQUEST_BYTES,
): Promise<Record<string, unknown> | HttpFailure> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return failure('content_type_required', 'Content-Type must be application/json.')
  }

  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!/^\d+$/u.test(declaredLength) || !Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
      return failure('body_too_large', `Request body must not exceed ${maximumBytes} bytes.`)
    }
  }

  const bytes = await readBoundedBytes(request.body, maximumBytes)
  if (isHttpFailure(bytes)) return bytes
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return isRecord(value)
      ? value
      : failure('json_object_required', 'Request body must be one JSON object.')
  } catch {
    return failure('json_malformed', 'Request body is not valid UTF-8 JSON.')
  }
}

export async function readJsonResponse(
  response: Response,
  maximumBytes = MAX_REQUEST_BYTES,
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!/^\d+$/u.test(declaredLength) || !Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
      await response.body?.cancel('response body exceeded bound')
      return failure('response_too_large', `Response body must not exceed ${maximumBytes} bytes.`)
    }
  }

  const bytes = await readBoundedBytes(response.body, maximumBytes)
  if (isHttpFailure(bytes)) return bytes
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return failure('response_malformed', 'Response body is not valid UTF-8 JSON.')
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isHttpFailure(value: unknown): value is HttpFailure {
  return isRecord(value)
    && value.ok === false
    && typeof value.code === 'string'
    && typeof value.message === 'string'
}

export function decodePath(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
}

export function failure(code: string, message: string): HttpFailure {
  return Object.freeze({ ok: false, code, message })
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array | HttpFailure> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel('request body exceeded bound')
        return failure('body_too_large', `Request body must not exceed ${maximumBytes} bytes.`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}
