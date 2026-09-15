import { createAdapterRegistrationInterface } from 'agentic-os/agents/adapter-registration';
import { createCommerceAdmissionAuthority } from './commerce-admission-authority.js';
import { createCommerceAdmissionProvider, createCommerceInvocationRegister,
  createCommerceToolAllowlistProjection } from './commerce-admission-provider.js';
import { createDurableObjectCommerceAdmissionStore } from './durable-object-state-store.js';
import { resolveCommerceDeploymentIdentity } from './commerce-deployment-identity.js';
import { COMMERCE_RELEASE_PROOF_PATH, createCommerceReleaseProofHandler } from './commerce-release-proof.js';

/** Explicit product extension for the optional OS Worker. The caller retains
 * the existing environment, namespace, definition registry and probe binding. */
export function createCommerceWorkerExtension({ env = {}, agentDefinitions } = {}) {
  const authority = createCommerceAdmissionAuthority({
    authorityRef: env.AGENTIC_OS_ADMISSION_AUTHORITY_REF,
    operatorInstructionRef: env.AGENTIC_OS_ADMISSION_OPERATOR_INSTRUCTION_REF,
    evidence: env.AGENTIC_OS_ADMISSION_AUTHORITY_EVIDENCE,
    secret: env.AGENTIC_OS_ADMISSION_AUTHORITY_HMAC_SECRET,
  });
  const namespace = env.AGENT_STATE;
  const store = typeof namespace?.idFromName === 'function' && typeof namespace?.get === 'function'
    ? createDurableObjectCommerceAdmissionStore({ namespace }) : undefined;
  const registrationInterface = createAdapterRegistrationInterface({
    ...(agentDefinitions ? { agentDefinitionRegistry: agentDefinitions } : {}),
    toolAllowlist: createCommerceToolAllowlistProjection(),
    invocationRegister: createCommerceInvocationRegister(),
    resolveOperatorInstruction: authority.resolveOperatorInstruction,
  });
  const provider = createCommerceAdmissionProvider({ store, registrationInterface, authority,
    deploymentIdentity: resolveCommerceDeploymentIdentity(env), authSecret: env.AGENTIC_OS_ADMISSION_AUTH_SECRET });
  return Object.freeze({
    async handle(request, ctx = {}) {
      const url = new URL(request.url);
      if (url.hostname === 'agentic-os-admission.internal') return provider.handle(request);
      if (url.pathname === '/agentic-os/internal' || url.pathname.startsWith('/agentic-os/internal/'))
        return Response.json({ error: 'not found' }, { status: 404 });
      if (url.pathname !== COMMERCE_RELEASE_PROOF_PATH) return null;
      const service = ctx?.exports?.CommerceAdmissionProbe;
      return createCommerceReleaseProofHandler({ token: env.ACOS_RELEASE_PROBE_TOKEN,
        admissionAuthSecret: env.AGENTIC_OS_ADMISSION_AUTH_SECRET,
        serviceFetch: typeof service?.fetch === 'function' ? input => service.fetch(input) : undefined,
      }).handle(request);
    },
    async beforeReadiness() {
      if (provider.stats().configured) {
        // Public readiness survives a private projection failure; a healthy warm isolate catches up.
        try { await provider.rehydrate(); } catch {}
      }
    },
  });
}
