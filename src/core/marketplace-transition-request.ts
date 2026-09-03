import type { ClaimMutationPermit } from '../domain/authoring-claim-policy.ts'
import { authoringMutationHeaders } from './authoring-mutation-headers.ts'
import { MARKETPLACE_PROVIDER_CONTRACT } from './provider-contract.ts'
import {
  bindAuthenticatedProviderRequest,
  prepareMarketplaceProviderOperation,
  type OperationalRequestResult,
} from './provider-operation-gate.ts'

const PROVIDER_TIMEOUT_MS = 10_000

export async function prepareAuthenticatedMarketplaceVendorTransitionRequest(
  env: CoreEnv,
  input: Readonly<{
    vendorId: string
    actorId: string
    state: 'pending_review' | 'approved' | 'active' | 'suspended'
    permit: ClaimMutationPermit
  }>,
): Promise<OperationalRequestResult> {
  const operation = await prepareMarketplaceProviderOperation(env, new Request(
    `https://marketplace.internal/v1/vendors/${encodeURIComponent(input.vendorId)}/transition`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-commerce-contract': MARKETPLACE_PROVIDER_CONTRACT,
        'x-operator-id': input.actorId,
      },
      body: JSON.stringify({ state: input.state }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    },
  ))
  if (!operation.ok) return operation
  const headers = new Headers(operation.request.headers)
  for (const [name, value] of Object.entries(authoringMutationHeaders(input.permit))) headers.set(name, value)
  return bindAuthenticatedProviderRequest(
    operation.binding,
    new Request(operation.request, { headers }),
    MARKETPLACE_PROVIDER_CONTRACT,
    env.MARKETPLACE_PROVIDER_AUTH_SECRET,
  )
}
