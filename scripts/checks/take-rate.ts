import { fileContains, report } from './common.ts'

report('take-rate', [
  fileContains('src/core/take-rate.ts', 'AG_TAKE_RATE_BASIS_POINTS'),
  fileContains('src/core/take-rate.ts', 'computeMarkupMinor'),
  fileContains('src/core/revenue-ledger.ts', 'settlement_id'),
  fileContains('src/core/checkout-session.ts', /markup_(?:recorded|deferred)/u),
  fileContains('src/core/core-readiness.ts', 'take_rate_configuration'),
])
