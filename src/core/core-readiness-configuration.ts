import { validAcosAdmissionAuthSecret } from '../shared/acos-admission-auth.ts'
import { validCommerceProviderSecret } from '../shared/commerce-provider-auth.ts'

export function releaseCandidateConfiguration(
  lane: string,
  releaseCandidateSha: string,
  releaseCandidateDigest: string,
): Readonly<{ ok: boolean }> {
  return Object.freeze({
    ok: lane.toLowerCase() !== 'production' || (/^[0-9a-f]{40}$/u.test(releaseCandidateSha)
      && /^[0-9a-f]{64}$/u.test(releaseCandidateDigest)),
  })
}

export function providerAuthenticationConfiguration(env: CoreEnv): Readonly<{ ok: boolean }> {
  return Object.freeze({
    ok: validCommerceProviderSecret(env.CHECKOUT_PROVIDER_AUTH_SECRET)
      && validCommerceProviderSecret(env.MARKETPLACE_PROVIDER_AUTH_SECRET)
      && validAcosAdmissionAuthSecret(env.AGENTIC_OS_ADMISSION_AUTH_SECRET),
  })
}
