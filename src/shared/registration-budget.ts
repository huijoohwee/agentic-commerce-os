export const CORE_REQUEST_TIMEOUT_MS = 10_000
export const REGISTRATION_DRY_RUN_WALL_CLOCK_SECONDS = 60
export const REGISTRATION_SANDBOX_TIMEOUT_MS = REGISTRATION_DRY_RUN_WALL_CLOCK_SECONDS * 1_000 + 5_000
// Invocation resolution, admission, and fenced commit follow the bounded dry-run.
export const REGISTRATION_CORE_REQUEST_TIMEOUT_MS = REGISTRATION_SANDBOX_TIMEOUT_MS + 20_000

export function coreRequestTimeoutMs(path: string, method: string): number {
  return method === 'POST' && path === '/internal/v1/agents'
    ? REGISTRATION_CORE_REQUEST_TIMEOUT_MS
    : CORE_REQUEST_TIMEOUT_MS
}
