import deployBoundaryRegister from '../../docs/deploy-boundary-register.json' with { type: 'json' }

type BoundaryRecord = Readonly<{
  id: string
  state: 'closed' | 'pending-protected-integration'
  openingConditions: readonly string[]
}>

type BoundaryProjection = Readonly<{
  schema: string
  deployLane: string
  boundaries: readonly BoundaryRecord[]
  readiness: Readonly<{ sourceLevel: string; liveRelease: string }>
  source: 'docs/deploy-boundary-register.json'
}>

export function releaseBoundaryProjection(): BoundaryProjection {
  const register: unknown = deployBoundaryRegister
  if (!isRegister(register)) throw new Error('release_boundary_register_invalid')
  return Object.freeze({
    schema: register.schema,
    deployLane: register.deployLane,
    boundaries: Object.freeze(register.boundaries.map((boundary) => Object.freeze({
      id: boundary.id,
      state: boundary.state,
      openingConditions: Object.freeze([...boundary.openingConditions]),
    }))),
    readiness: Object.freeze({
      sourceLevel: register.readiness.sourceLevel,
      liveRelease: register.readiness.liveRelease,
    }),
    source: 'docs/deploy-boundary-register.json',
  })
}

function isRegister(value: unknown): value is Readonly<{
  schema: string
  deployLane: string
  boundaries: readonly BoundaryRecord[]
  readiness: Readonly<{ sourceLevel: string; liveRelease: string }>
}> {
  if (!isRecord(value)
    || typeof value.schema !== 'string'
    || typeof value.deployLane !== 'string'
    || !Array.isArray(value.boundaries)
    || !isRecord(value.readiness)
    || typeof value.readiness.sourceLevel !== 'string'
    || typeof value.readiness.liveRelease !== 'string') return false
  return value.boundaries.every((boundary) => (
    isRecord(boundary)
    && typeof boundary.id === 'string'
    && (boundary.state === 'closed' || boundary.state === 'pending-protected-integration')
    && Array.isArray(boundary.openingConditions)
    && boundary.openingConditions.every((condition) => typeof condition === 'string')
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
