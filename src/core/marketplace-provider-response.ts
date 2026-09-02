import { isRecord } from '../shared/http.ts'
import { MARKETPLACE_PROVIDER_CONTRACT } from './provider-contract.ts'
import {
  MARKETPLACE_PROVIDER_RESPONSE_KEYS,
  MARKETPLACE_TERMINAL_409_CODES,
  MARKETPLACE_VENDOR_STATES,
} from './marketplace-provider-response-contract.ts'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const SETTLEMENT_STATES = Object.freeze(['pending', 'settled', 'failed'] as const)
const TERMINAL_VENDOR_CODES = new Set<string>(MARKETPLACE_TERMINAL_409_CODES)

export type MarketplaceVendorState = typeof MARKETPLACE_VENDOR_STATES[number]

export function validVendorList(status: number, value: unknown): value is Record<string, unknown> {
  if (status !== 200 || !isRecord(value)
    || !exactKeys(value, MARKETPLACE_PROVIDER_RESPONSE_KEYS.vendorList)
    || value.ok !== true || value.contract !== MARKETPLACE_PROVIDER_CONTRACT
    || !Array.isArray(value.vendors) || value.vendors.length > 10_000) return false
  return value.vendors.every((vendor) => isRecord(vendor)
    && exactKeys(vendor, MARKETPLACE_PROVIDER_RESPONSE_KEYS.vendor)
    && IDENTIFIER_PATTERN.test(String(vendor.vendorId))
    && IDENTIFIER_PATTERN.test(String(vendor.actorId))
    && IDENTIFIER_PATTERN.test(String(vendor.mutationId))
    && isVendorState(vendor.state))
}

export function classifyVendorTransition(
  status: number,
  value: unknown,
  vendorId: string,
  actorId: string,
  state: MarketplaceVendorState,
  mutationId: string,
): 'success' | 'terminal' | 'invalid' {
  if (status === 200 && isRecord(value)
    && exactKeys(value, MARKETPLACE_PROVIDER_RESPONSE_KEYS.transition)
    && value.ok === true && value.contract === MARKETPLACE_PROVIDER_CONTRACT
    && value.vendorId === vendorId && value.actorId === actorId
    && value.state === state && value.mutationId === mutationId) return 'success'
  if (status === 409 && isRecord(value)
    && exactKeys(value, MARKETPLACE_PROVIDER_RESPONSE_KEYS.error)
    && value.ok === false && value.contract === MARKETPLACE_PROVIDER_CONTRACT
    && typeof value.code === 'string' && TERMINAL_VENDOR_CODES.has(value.code)) return 'terminal'
  return 'invalid'
}

export function validSettlement(status: number, value: unknown, splitId: string): value is Record<string, unknown> {
  return status === 200 && isRecord(value)
    && exactKeys(value, MARKETPLACE_PROVIDER_RESPONSE_KEYS.settlement)
    && value.ok === true && value.contract === MARKETPLACE_PROVIDER_CONTRACT
    && value.splitId === splitId && SETTLEMENT_STATES.includes(value.state as never)
    && Number.isSafeInteger(value.amountMinor) && Number(value.amountMinor) >= 0
    && typeof value.currency === 'string' && CURRENCY_PATTERN.test(value.currency)
}

export function exactProviderError(
  status: number,
  value: unknown,
  expectedStatus: number,
  code: string,
): value is Record<string, unknown> {
  return status === expectedStatus && isRecord(value)
    && exactKeys(value, MARKETPLACE_PROVIDER_RESPONSE_KEYS.error)
    && value.ok === false && value.contract === MARKETPLACE_PROVIDER_CONTRACT && value.code === code
}

export function isVendorState(value: unknown): value is MarketplaceVendorState {
  return typeof value === 'string' && MARKETPLACE_VENDOR_STATES.includes(value as MarketplaceVendorState)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}
