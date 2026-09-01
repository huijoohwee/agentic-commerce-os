import { fileContains, report } from './common.ts'

report('webmcp', [
  fileContains('src/edge/client/storefront-actions.ts', 'createStorefrontActions'),
  fileContains('src/edge/client/webmcp-tools.ts', 'document.modelContext'),
  fileContains('src/edge/client/webmcp-tools.ts', 'MAXIMUM_REGISTERED_TOOLS'),
  fileContains('src/edge/client/webmcp-tools.ts', 'webmcp_registration_drift'),
  fileContains('src/edge/client/webmcp-tools.ts', 'commerce.checkout.initiate'),
  fileContains('docs/deploy-boundary-register.json', 'origin-trial'),
])
