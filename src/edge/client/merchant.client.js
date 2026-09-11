const runtimeBasePath = document.querySelector('meta[name="ag-runtime-base-path"]').content;
const runtimePath = path => runtimeBasePath + path;
const role = document.querySelector('meta[name="ag-workspace-role"]').content;
const status = document.querySelector('#merchant-status');
const queue = document.querySelector('#merchant-proposals');
let operatorToken = '';
let applying = false;
let connectionRevision = 0;
const errorText = code => ({
  unauthorized: 'Credential not accepted. Check your operator credential.',
  theme_review_stale: 'The live store changed. Stage a fresh proposal before publishing.',
  scope_held: 'Another operation holds this store. Wait for it to finish, then review again.',
  proposal_capacity_reached: 'The local queue is full. Remove a completed or rejected record.',
  proposal_integrity_mismatch: 'This local record changed unexpectedly. Remove it and stage a fresh review.',
  theme_scope_agent_not_registered: 'Register and admit this agent before publishing its storefront.',
  publication_may_be_in_flight_wait_one_minute: 'Publication may still be running. Wait one minute, then check again.',
  live_version_differs_stage_a_fresh_review: 'The live version differs. Inspect the store and stage a fresh review.'
}[code] || code);
const report = error => { status.textContent = errorText(error?.message || String(error)); };
const recordLocalEvent = async event => { status.dataset.agentStatus = event.type; };
const operatorApi = (path, body, headers = {}, token = operatorToken) => api('/v1/operator' + path, {
  method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
  ...(body ? { body: JSON.stringify(body) } : {})
});
const publish = async scope => {
  if (!operatorToken || applying || !navigator.onLine) throw new Error('operator_connection_required');
  const token = operatorToken;
  applying = true;
  let proposal, claim, headers;
  try {
    proposal = await changeProposal(scope, 'pending', 'applying');
    if (!proposal) throw new Error('proposal_already_reviewed');
    if (proposalPrefix + await digest({ manifest: proposal.manifest, expectedPreviousManifestDigest: proposal.expectedPreviousManifestDigest }) !== scope) throw new Error('proposal_integrity_mismatch');
    announce();
    await renderProposals();
    const id = crypto.randomUUID(), target = 'merchant-theme:' + proposal.manifest.merchantId;
    claim = { claimId: 'browser-' + id, actorId: 'browser-operator', deviceId: id, sessionId: id,
      worktree: 'browser', branch: 'browser', semanticScope: target, declaredWriteSet: [target],
      leaseEpoch: Date.now(), leaseExpiresAtMs: Date.now() + 60000, fenceRevision: id };
    try { await operatorApi('/claims/acquire', claim, {}, token); }
    catch (error) {
      if (error.message !== 'fence_stale' || !Number.isSafeInteger(error.holdingLeaseEpoch)
        || error.holdingLeaseEpoch >= Number.MAX_SAFE_INTEGER) throw error;
      claim.leaseEpoch = error.holdingLeaseEpoch + 1;
      await operatorApi('/claims/acquire', claim, {}, token);
    }
    headers = { 'x-authoring-semantic-scope': target, 'x-authoring-claim-id': claim.claimId,
      'x-authoring-lease-epoch': String(claim.leaseEpoch), 'x-authoring-fence-revision': id };
    const result = await operatorApi('/merchants/' + proposal.manifest.merchantId + '/theme', {
      manifest: proposal.manifest, expectedPreviousManifestDigest: proposal.expectedPreviousManifestDigest
    }, headers, token);
    await changeProposal(scope, 'applying', 'applied', { manifestDigest: result.manifestDigest });
    status.textContent = 'Published. Open the store to check your buyer experience.';
  } catch (error) {
    if (proposal) await changeProposal(scope, 'applying', 'uncertain', { code: error.message });
    throw error;
  } finally {
    if (headers) {
      await operatorApi('/claims/release', { semanticScope: claim.semanticScope, claimId: claim.claimId,
        leaseEpoch: claim.leaseEpoch, fenceRevision: claim.fenceRevision }, headers, token)
        .catch(() => { status.textContent += ' Claim release unconfirmed; wait for the one-minute lease to expire.'; });
    }
    applying = false;
    announce();
    await renderProposals();
  }
};
const renderProposals = async () => {
  const proposals = await readProposals();
  const fragment = document.createDocumentFragment();
  for (const proposal of proposals) {
    const card = document.createElement('article'); card.className = 'listing';
    const heading = document.createElement('h3'); heading.textContent = proposal.manifest.copy.brand;
    const copy = document.createElement('p'); copy.textContent = proposal.manifest.copy.headline + ' — ' + proposal.manifest.copy.subhead;
    const detail = document.createElement('p'); detail.className = 'hint';
    detail.textContent = proposal.manifest.merchantId + ' · ' + proposal.manifest.catalogScope.join(', ') + ' · ' + proposal.status;
    const version = document.createElement('details'); const label = document.createElement('summary'); label.textContent = 'Review exact change';
    const exact = document.createElement('pre'); exact.textContent = JSON.stringify({ manifest: proposal.manifest, expectedPreviousManifestDigest: proposal.expectedPreviousManifestDigest }, null, 2);
    version.append(label, exact); card.append(heading, copy, detail, version);
    if (proposal.result?.code) { const error = document.createElement('p'); error.textContent = errorText(proposal.result.code); card.append(error); }
    const link = document.createElement('a'); link.className = 'route'; link.href = runtimePath('/s/' + encodeURIComponent(proposal.manifest.merchantId)); link.textContent = 'Open store';
    if (proposal.expectedPreviousManifestDigest !== null || proposal.status === 'applied') card.append(link);
    if (role === 'admin' && proposal.status === 'pending') {
      for (const action of ['Approve and publish', 'Reject proposal']) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action;
        button.disabled = applying || !operatorToken;
        button.addEventListener('click', async event => {
          if (!event.isTrusted) return;
          button.disabled = true;
          try {
            if (action === 'Approve and publish') await publish(proposal.scope);
            else { await changeProposal(proposal.scope, 'pending', 'rejected'); announce(); await renderProposals(); }
          } catch (error) { report(error); }
        });
        card.append(button);
      }
    }
    if (['applying', 'uncertain'].includes(proposal.status)) {
      const inspect = document.createElement('button'); inspect.type = 'button'; inspect.textContent = 'Check publication';
      inspect.disabled = applying;
      inspect.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        try {
          if (Date.now() - proposal.updatedAtMs < 60000) throw new Error('publication_may_be_in_flight_wait_one_minute');
          const live = await readMerchant({ merchantId: proposal.manifest.merchantId });
          const matches = live.manifestDigest === await digest(proposal.manifest);
          await changeProposal(proposal.scope, proposal.status, matches ? 'applied' : 'uncertain',
            matches ? { manifestDigest: live.manifestDigest } : { code: 'live_version_differs_stage_a_fresh_review' });
          announce(); await renderProposals();
        } catch (error) { report(error); }
      });
      card.append(inspect);
    }
    if (['applied', 'rejected', 'uncertain'].includes(proposal.status)) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove local record';
      remove.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        await proposalStore('readwrite', store => store.delete(proposal.scope)); announce(); await renderProposals();
      });
      card.append(remove);
    }
    fragment.append(card);
  }
  if (!proposals.length) { const empty = document.createElement('p'); empty.textContent = 'No proposals yet. Prepare a storefront in the vendor workspace.'; fragment.append(empty); }
  queue.replaceChildren(fragment);
};
document.querySelector('#merchant-editor')?.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const result = await stageTheme(Object.fromEntries(new FormData(event.currentTarget)));
    status.textContent = result.status === 'pending' ? 'Saved for human review in Admin.'
      : 'This proposal is ' + result.status + '. Edit the fields or remove its old local record before staging again.';
  }
  catch (error) { report(error); }
});
document.querySelector('#launch-import')?.addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file || file.size > 65536) throw new Error('launch_pack_too_large');
    const pack = JSON.parse(await file.text()), manifest = pack.themeManifest;
    if (pack.schema !== 'commerce.merchant-launch/v1' || !manifest || manifest.catalogScope?.length !== 1) throw new Error('launch_pack_invalid');
    const form = document.querySelector('#merchant-editor');
    const fields = { merchantId: manifest.merchantId, agentId: manifest.catalogScope[0], ...manifest.copy };
    for (const name of ['merchantId','agentId','brand','headline','subhead']) form.elements.namedItem(name).value = fields[name] || '';
    status.textContent = 'Imported copy and agent scope. Review the fields, then stage with a fresh live version.';
  } catch (error) { report(error); }
  event.target.value = '';
});
const disconnect = () => {
  connectionRevision += 1;
  operatorToken = '';
  document.querySelector('#operator-overview').textContent = 'Disconnected.';
  document.querySelector('#operator-agents').replaceChildren();
  document.querySelector('#operator-disconnect').hidden = true;
  void renderProposals().catch(report);
};
document.querySelector('#operator-connect')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.isTrusted || applying) return;
  const input = document.querySelector('#operator-token'), token = input.value.trim(); input.value = '';
  disconnect();
  const revision = connectionRevision;
  try {
    const registry = await operatorApi('/agents', null, {}, token);
    if (revision !== connectionRevision) return;
    operatorToken = token;
    const agents = document.querySelector('#operator-agents');
    for (const agent of (registry.agents || []).slice(0, 100)) {
      const row = document.createElement('li'); row.textContent = agent.agentId + ' · ' + (agent.registrationState || 'registered'); agents.append(row);
    }
    document.querySelector('#operator-overview').textContent = String(registry.agents?.length || 0) + ' registered agents. Ready to review proposals.';
    document.querySelector('#operator-disconnect').hidden = false;
    await renderProposals();
  } catch (error) { report(error); }
});
document.querySelector('#operator-disconnect')?.addEventListener('click', disconnect);
const nativeToolDefinitions = [
  { name: 'commerce.merchant.catalog', title: 'Read merchant catalog', description: 'Read the current public merchant catalog and version.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { merchantId: { type: 'string', maxLength: 128 } }, required: ['merchantId'] }, execute: readMerchant },
  { name: 'commerce.merchant.theme.stage', title: 'Stage storefront proposal', description: 'Save buyer-facing copy for visible human review. Cannot publish or approve.',
    inputSchema: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['merchantId','agentId','brand','headline','subhead'].map(key => [key, { type: 'string', maxLength: key.endsWith('Id') ? 128 : 280 }])), required: ['merchantId','agentId','brand','headline','subhead'] }, execute: stageTheme },
  { name: 'commerce.merchant.proposals.read', title: 'Read local review queue', description: 'Read proposals visible in this browser. No credentials are exposed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }, execute: async () => ({ ok: true, proposals: await readProposals() }) }
].map(tool => ({ ...tool, outputSchema: { type: 'object' }, annotations: { readOnlyHint: tool.name !== 'commerce.merchant.theme.stage', untrustedContentHint: true, consequentialHint: false } }));
