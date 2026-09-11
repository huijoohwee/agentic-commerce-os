import { LOCAL_DATABASE_RUNTIME } from './local-runtime'
import { WEBMCP_CLIENT_RUNTIME } from './webmcp-runtime'
import state from './shopper-state.client.js'
import actions from './shopper-actions.client.js'
import view from './shopper-view.client.js'
import checkout from './shopper-checkout.client.js'
import boot from './shopper-boot.client.js'
import experience from './experience.client.js'

export function storefrontClientModule(): string {
  return [LOCAL_DATABASE_RUNTIME, experience, state, actions, view, checkout,
    WEBMCP_CLIENT_RUNTIME, boot].join('\n')
}
