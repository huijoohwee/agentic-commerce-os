import { isRecord } from '../shared/http.ts';

export { FULFILLMENT_AGENT } from './fulfillment-definition.ts';
export type FulfillmentBinding = Readonly<{ runId: string; outputDigest: string }>;
export type RunContext = Readonly<{ principalId: string; principalExpiresAt: number }>;
export type FulfillmentRuntime = Readonly<{
  invoke(operation: 'start' | 'status' | 'cancel' | 'retry', input: Record<string, unknown>,
    context: RunContext, signal: AbortSignal): Promise<unknown>;
}>;
export const validRunId = (value: unknown): value is string => typeof value === 'string' && /^listing-[a-f0-9]{64}$/u.test(value);
export function validBinding(value: unknown): value is FulfillmentBinding {
  return isRecord(value) && Object.keys(value).sort().join() === 'outputDigest,runId'
    && validRunId(value.runId) && typeof value.outputDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.outputDigest);
}
export function sameBinding(left: FulfillmentBinding | undefined, right: FulfillmentBinding | undefined) {
  return left?.runId === right?.runId && left?.outputDigest === right?.outputDigest;
}
export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export class FulfillmentFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
