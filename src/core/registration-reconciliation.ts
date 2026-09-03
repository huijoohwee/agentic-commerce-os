import type { ReservedOperatorMutation } from './authoring-mutation.js'
import { respond, resultOk } from './core-http-utils.js'

export type RegistrationReconciliationPhase =
  | 'commerce-commit-rejected'
  | 'commerce-commit-unconfirmed'
  | 'reservation-completion-unconfirmed'

export async function preserveRegistrationBoundary(
  reservation: ReservedOperatorMutation,
  admissionReceipt: unknown,
  localOutcome: unknown,
  phase: RegistrationReconciliationPhase,
  requestId: string,
): Promise<Response> {
  const evidence = Object.freeze({
    schema: 'agentic-commerce-acos-registration-reconciliation/v1',
    boundary: 'acos-to-commerce-registry',
    disposition: 'preserve-required',
    phase,
    admissionReceipt,
    localOutcome,
  })
  const reconciliation = await reservation.preserve(evidence)
  return respond(Object.freeze({
    ok: false,
    code: resultOk(reconciliation)
      ? 'acos_commerce_reconciliation_required'
      : 'acos_commerce_reconciliation_persistence_failed',
    disposition: 'preserve-required',
    boundary: 'acos-to-commerce-registry',
    phase,
    reconciliation,
  }), requestId, 503)
}
