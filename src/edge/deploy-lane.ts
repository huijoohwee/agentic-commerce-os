export const EDGE_DEPLOY_LANES = Object.freeze(['Local', 'Dev', 'Staging', 'Production'] as const)

export type EdgeDeployLane = typeof EDGE_DEPLOY_LANES[number]

export function readEdgeDeployLane(value: unknown): EdgeDeployLane | null {
  return typeof value === 'string' && EDGE_DEPLOY_LANES.includes(value as EdgeDeployLane)
    ? value as EdgeDeployLane
    : null
}

export function edgeLoopbackAllowed(value: unknown): boolean {
  const lane = readEdgeDeployLane(value)
  return lane === 'Local' || lane === 'Dev'
}

export function edgeExternalHumanPresenceRequired(value: unknown): boolean {
  const lane = readEdgeDeployLane(value)
  return lane === null || lane === 'Staging' || lane === 'Production'
}
