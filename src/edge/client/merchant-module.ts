import { THEME_MANIFEST_DEFAULTS } from '../../shared/theme-manifest'
import { LOCAL_DATABASE_RUNTIME } from './local-runtime'
import merchantState from './merchant-state.client.js'
import { WEBMCP_CLIENT_RUNTIME } from './webmcp-runtime'
import merchantClient from './merchant.client.js'
import merchantView from './merchant-view.client.js'
import experience from './experience.client.js'

export function merchantClientModule(): string {
  return [
    'const themeDefaults = ' + JSON.stringify(THEME_MANIFEST_DEFAULTS) + ';',
    LOCAL_DATABASE_RUNTIME, experience, merchantState, merchantClient, merchantView, WEBMCP_CLIENT_RUNTIME,
    String.raw`if (channel) channel.onmessage = () => void renderProposals().catch(report);
window.addEventListener('pagehide', () => { operatorToken = ''; channel?.close(); });
void renderProposals().catch(report);
void registerWebMcp().catch(report);
`,
  ].join('\n')
}
