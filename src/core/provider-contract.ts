import { isRecord } from '../shared/http.js'

export const CHECKOUT_PROVIDER_CONTRACT = 'commerce.checkout-provider/v1'
export const MARKETPLACE_PROVIDER_CONTRACT = 'commerce.marketplace-provider/v1'

export function hasProviderContract(value: unknown, contract: string): value is Record<string, unknown> {
  return isRecord(value) && value.contract === contract
}
