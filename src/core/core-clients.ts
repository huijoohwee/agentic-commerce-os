import type { AgentRegistry } from './agent-registry.js'
import type { AuthoringClaim } from './authoring-claim.js'
import type { CheckoutSession } from './checkout-session.js'
import type { IntentRoute } from './intent-route.js'
import type { RevenueLedger } from './revenue-ledger.js'
import type { ThemeDeployment } from './theme-deployment-store.js'

export type AgentRegistryClient = Readonly<{
  preflightRegistration: AgentRegistry['preflightRegistration']
  register: AgentRegistry['register']
  deregister: AgentRegistry['deregister']
  list: AgentRegistry['list']
  route: AgentRegistry['route']
  health: AgentRegistry['health']
  events: AgentRegistry['events']
}>

export function registryStub(env: CoreEnv): AgentRegistryClient {
  return env.AGENT_REGISTRY.getByName(env.REGISTRY_ID) as unknown as AgentRegistryClient
}

export function intentRouteStub(env: CoreEnv, intentId: string): DurableObjectStub<IntentRoute> {
  return env.INTENT_ROUTE.getByName(intentId) as unknown as DurableObjectStub<IntentRoute>
}

export function checkoutSessionStub(env: CoreEnv, checkoutId: string): DurableObjectStub<CheckoutSession> {
  return env.CHECKOUT_SESSION.getByName(checkoutId) as unknown as DurableObjectStub<CheckoutSession>
}

export function revenueLedgerStub(env: CoreEnv): DurableObjectStub<RevenueLedger> {
  return env.REVENUE_LEDGER.getByName(env.REGISTRY_ID) as unknown as DurableObjectStub<RevenueLedger>
}

export function themeDeploymentStub(env: CoreEnv, merchantId: string): DurableObjectStub<ThemeDeployment> {
  return env.THEME_DEPLOYMENT.getByName(merchantId) as unknown as DurableObjectStub<ThemeDeployment>
}

export function authoringClaimStub(env: CoreEnv, _scope: string): DurableObjectStub<AuthoringClaim> {
  // All semantic scopes share one coordinator so disjointness is decided atomically.
  return env.AUTHORING_CLAIM.getByName(env.REGISTRY_ID) as unknown as DurableObjectStub<AuthoringClaim>
}
