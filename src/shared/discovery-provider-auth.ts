const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{32,4094}={0,2}$/u

export function readDiscoveryProviderAuthorization(value: unknown): string | null {
  return typeof value === 'string' && BEARER_TOKEN_PATTERN.test(value)
    ? `Bearer ${value}`
    : null
}
