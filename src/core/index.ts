import { AgentRegistry } from './agent-registry.js'
import { AuthoringClaim } from './authoring-claim.js'
import { CheckoutSession } from './checkout-session.js'
import { classifyError, reject, respond } from './core-http-utils.js'
import { handleCoreRequest } from './core-http-handler.js'
import { IntentRoute } from './intent-route.js'
import { RevenueLedger } from './revenue-ledger.js'
import { ThemeDeployment } from './theme-deployment-store.js'

export { AgentRegistry, AuthoringClaim, CheckoutSession, IntentRoute, RevenueLedger, ThemeDeployment }

export default {
  async fetch(request: Request, env: CoreEnv): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
    try {
      return await handleCoreRequest(request, env, requestId)
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'commerce_core_request_failed',
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        code: classifyError(error),
      }))
      return respond(reject('internal_error'), requestId, 500)
    }
  },
} satisfies ExportedHandler<CoreEnv>
