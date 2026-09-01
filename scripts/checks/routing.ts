import { fileContains, report } from './common.ts'

report('routing', [
  fileContains('src/domain/selection-policy.ts', 'selectAgent'),
  fileContains('src/domain/selection-policy.ts', 'agentId'),
  fileContains('src/core/intent-route.ts', 'dispatch_exhausted'),
  fileContains('src/core/intent-route.ts', 'fallback'),
  fileContains('src/core/public-catalog.ts', 'PUBLIC_FIELD_ALLOWLIST'),
  fileContains('src/edge/index.ts', '/v1/public/agents'),
])
