export function merchantPage(role: 'admin' | 'vendor'): string {
  const editor = `<article class="card storefront">
    <h2>Prepare your storefront</h2>
    <p class="hint">Describe the offer for your buyer. Staging saves a proposal on this browser; an operator reviews it before publication.</p>
    <label>Import a merchant launch pack <input id="launch-import" type="file" accept="application/json,.json"></label>
    <form id="merchant-editor" class="stack">
      <label>Merchant ID <input name="merchantId" required maxlength="128" pattern="[a-z0-9][a-z0-9._-]*" placeholder="your-store"></label>
      <label>Registered agent ID <input name="agentId" required maxlength="128" pattern="[a-z0-9][a-z0-9._-]*" placeholder="your-agent"></label>
      <label>Brand <input name="brand" required maxlength="280" placeholder="Your business"></label>
      <label>Buyer outcome <input name="headline" required maxlength="280" placeholder="What will your buyer achieve?"></label>
      <label>Who it helps and how <input name="subhead" required maxlength="280" placeholder="For… who need…"></label>
      <button type="submit">Stage for review</button>
    </form>
  </article>`
  const operator = `<article class="card storefront">
    <h2>Operator session</h2>
    <p class="hint">Connect with your operator credential to review the registry and publish approved proposals. It stays in this tab until disconnect or reload.</p>
    <form id="operator-connect"><label class="sr-only" for="operator-token">Operator credential</label><input id="operator-token" type="password" autocomplete="off" required placeholder="Operator credential"><button>Connect</button></form>
    <button id="operator-disconnect" type="button" hidden>Disconnect</button>
    <p id="operator-overview" class="hint" aria-live="polite">Disconnected.</p><ul id="operator-agents"></ul>
  </article>`
  return `${role === 'vendor' ? editor : operator}
    <article class="card storefront"><h2>${role === 'admin' ? 'Review before publishing' : 'Your proposals'}</h2>
      <p class="hint">This browser keeps up to 20 proposals. Applied changes must be reviewed again when the live version changes. An interrupted publication requires checking the live store before staging again.</p>
      <p id="merchant-status" role="status"></p><div id="merchant-proposals"></div>
    </article>`
}
