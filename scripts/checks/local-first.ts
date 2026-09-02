import { fileContains, report } from './common.ts'

report('local-first', [
  fileContains('src/edge/client/local-store.ts', 'indexedDB'),
  fileContains('src/edge/client/local-store.ts', 'MAXIMUM_PENDING_CHANGES'),
  fileContains('src/edge/client/local-store.ts', 'connectivity_absent'),
  fileContains('src/core/sync-merge.ts', 'mergeSequences'),
  fileContains('src/core/authoring-claim.ts', 'admitMutation'),
  fileContains('src/core/authoring-claim.ts', 'fence_stale'),
])
