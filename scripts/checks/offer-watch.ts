import { fileContains, report } from './common.ts'

report('offer-watch', [
  fileContains('src/core/offer-watch.ts', 'OBSERVATION_INTERVAL_MS = 60_000'),
  fileContains('src/core/offer-watch.ts', 'MAXIMUM_OBSERVATION_RETRIES = 3'),
  fileContains('src/core/offer-watch.ts', 'offer_changed'),
  fileContains('src/core/offer-watch.ts', 'hasProviderContract(value, CHECKOUT_PROVIDER_CONTRACT)'),
  fileContains('src/core/checkout-session.ts', 'acknowledgedEventSequence'),
  fileContains('docs/runtime-api.md', '`human_confirmation_required`; backend MCP never forwards settlement'),
  fileContains('docs/runtime-api.md', '`POST /v1/human/checkouts/{id}/confirm`'),
  fileContains('docs/deploy-boundary-register.json', 'autonomous-cart-rederivation'),
])
