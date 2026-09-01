import { isRecord } from '../shared/http.ts'

export const DISCOVERY_PROVIDER_CONTRACT = 'commerce.discovery-provider/v1'
export const CHECKOUT_PROVIDER_CONTRACT = 'commerce.checkout-provider/v1'
export const MARKETPLACE_PROVIDER_CONTRACT = 'commerce.marketplace-provider/v1'

export function hasProviderContract(value: unknown, contract: string): value is Record<string, unknown> {
  return isRecord(value) && value.contract === contract
}
