import { failure, type HttpFailure } from './http'

const MINIMUM_PRODUCTION_SECRET_LENGTH = 32

export async function bearerAuthorized(request: Request, expectedSecret: unknown): Promise<boolean> {
  const authorization = request.headers.get('authorization')
  const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  return candidate.length > 0 && typeof expectedSecret === 'string' && expectedSecret.length > 0
    ? constantTimeTextMatch(candidate, expectedSecret)
    : false
}

export function validateSecretConfiguration(
  lane: string,
  mcpSecret: unknown,
  operatorSecret: unknown,
): { ok: true } | HttpFailure {
  const production = lane.toLowerCase() === 'production'
  const minimum = production ? MINIMUM_PRODUCTION_SECRET_LENGTH : 1
  if (typeof mcpSecret !== 'string'
    || typeof operatorSecret !== 'string'
    || mcpSecret.length < minimum
    || operatorSecret.length < minimum) {
    return failure('secret_configuration_invalid', `Configured secrets must be at least ${minimum} characters.`)
  }
  if (mcpSecret === operatorSecret) {
    return failure('secret_configuration_invalid', 'MCP and operator secrets must be distinct.')
  }
  return { ok: true }
}

export function originAllowed(request: Request, encodedAllowedOrigins: string): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return false
  }
  if ((parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:')
    || parsedOrigin.origin !== origin
    || parsedOrigin.pathname !== '/'
    || parsedOrigin.username !== ''
    || parsedOrigin.password !== ''
    || parsedOrigin.search !== ''
    || parsedOrigin.hash !== '') return false
  try {
    const value: unknown = JSON.parse(encodedAllowedOrigins)
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
      return false
    }
    const allowed = value.map((entry) => {
      try {
        const parsed = new URL(entry as string)
        return parsed.origin === entry && parsed.pathname === '/' ? parsed.origin : null
      } catch {
        return null
      }
    })
    return allowed.every((entry) => entry !== null) && allowed.includes(parsedOrigin.origin)
  } catch {
    return false
  }
}

export async function constantTimeTextMatch(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(candidateDigest)
  const right = new Uint8Array(expectedDigest)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}
