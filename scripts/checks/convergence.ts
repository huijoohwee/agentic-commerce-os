import { fileContains, report } from './common.ts'

report('convergence', [
  fileContains('src/core/convergence-evaluator.ts', 'evaluateConvergence'),
  fileContains('src/core/convergence-evaluator.ts', 'converged-with-surplus'),
  fileContains('src/core/convergence-evaluator.ts', 'requiredAbsentOrFailing'),
  fileContains('src/core/upstream-evidence.ts', 'declaredRequirements'),
  fileContains('src/core/core-readiness.ts', 'delivery_route_live_unknown'),
  fileContains('src/edge/readiness.ts', "PRODUCTION_DELIVERY_HOST = 'airvio.co'"),
  fileContains('src/edge/readiness.ts', 'coreStatusReflectsOnlyRouteUnknown'),
  fileContains('src/edge/readiness.ts', 'delivery_route_unauthorized_in_dev'),
])
