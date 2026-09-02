export async function readBoundedJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;.*)?$/u.test(contentType)) {
    await response.body?.cancel('unexpected response content type')
    throw new Error('bounded_response:json_content_type_invalid')
  }
  const bytes = await readBoundedResponseBytes(response, maximumBytes)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error('bounded_response:json_invalid')
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || response.body === null) {
    throw new Error('bounded_response:body_invalid')
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    await response.body.cancel('response body exceeded bound')
    throw new Error('bounded_response:body_too_large')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel('response body exceeded bound')
        throw new Error('bounded_response:body_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
