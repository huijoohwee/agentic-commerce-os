import { fileContains, fileExists, report } from './common.ts'

report('template-pack', [
  fileContains('src/shared/theme-manifest.ts', 'THEME_MANIFEST_MAX_BYTES'),
  fileContains('src/shared/theme-manifest.ts', 'validateThemeManifest'),
  fileContains('src/core/merchant-catalog.ts', 'projectMerchantCatalog'),
  fileContains('src/core/theme-deployment.ts', 'theme_asset_unreachable'),
  fileContains('src/core/theme-deployment-store.ts', 'ThemeDeployment'),
  fileContains('src/edge/dashboard.ts', 'consoleResponse'),
  fileContains('src/edge/experience-styles.ts', 'min-height: 44px'),
  fileExists('test/browser/template-pack.spec.ts'),
])
