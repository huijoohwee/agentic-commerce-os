import type { IncomingMessage } from 'node:http'

export class BodyError extends Error { constructor(readonly status: number, code: string) { super(code) } }
export function readLocalBody(request: IncomingMessage, signal: AbortSignal, maximum = 16384): Promise<string> {
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    request.pause(); return Promise.reject(new BodyError(413, 'catalog_request_too_large'))
  }
  return new Promise((resolve, reject) => {
    let bytes = 0, settled = false
    const chunks: Buffer[] = []
    const finish = (error?: Error, text?: string) => {
      if (settled) return
      settled = true
      request.off('data', data).off('end', end).off('error', failed)
      signal.removeEventListener('abort', abort)
      if (error) { request.pause(); reject(error) } else resolve(text ?? '')
    }
    const failed = () => finish(new BodyError(400, 'catalog_body_invalid'))
    const abort = () => finish(new BodyError(499, 'catalog_cancelled'))
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maximum) finish(new BodyError(413, 'catalog_request_too_large'))
      else chunks.push(chunk)
    }
    const end = () => {
      try { finish(undefined, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
      catch { failed() }
    }
    request.on('data', data).once('end', end).once('error', failed)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

