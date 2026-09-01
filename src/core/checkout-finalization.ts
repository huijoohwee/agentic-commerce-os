import type { MarkupOutcome } from './checkout-markup.ts'

export type FinalizationOutcome = MarkupOutcome & Readonly<{
  evidenceDisposition: 'persisted' | 'response-only-deferred'
  observationStopDisposition: 'completed' | 'deferred'
}>

type FinalizationActions = Readonly<{
  stopObservation: () => Promise<void>
  recordMarkup: () => Promise<MarkupOutcome>
  recordEvidence: (markup: MarkupOutcome) => void
}>

export async function finalizeSettledCheckout(
  providerResult: unknown,
  idempotent: boolean,
  actions: FinalizationActions,
): Promise<unknown> {
  let observationStopDisposition: FinalizationOutcome['observationStopDisposition'] = 'completed'
  try {
    await actions.stopObservation()
  } catch {
    observationStopDisposition = 'deferred'
  }

  let markup: MarkupOutcome
  try {
    markup = await actions.recordMarkup()
  } catch {
    markup = Object.freeze({ stage: 'deferred', failingStage: 'unexpected', attempts: 3 })
  }

  let evidenceDisposition: FinalizationOutcome['evidenceDisposition'] = 'persisted'
  try {
    actions.recordEvidence(markup)
  } catch {
    evidenceDisposition = 'response-only-deferred'
  }
  const finalization: FinalizationOutcome = Object.freeze({
    ...markup,
    evidenceDisposition,
    observationStopDisposition,
  })
  return settledResult(providerResult, idempotent, finalization)
}

export function settledResult(result: unknown, idempotent: boolean, markup?: unknown): unknown {
  return Object.freeze({ ok: true, status: 'settled', idempotent, result, ...(markup ? { markup } : {}) })
}
