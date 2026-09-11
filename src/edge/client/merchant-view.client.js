let proposalRenderRevision = 0;
const renderProposals = async () => {
  const revision = ++proposalRenderRevision;
  const proposals = await readProposals();
  if (revision !== proposalRenderRevision) return;
  document.querySelector('#proposal-count').textContent = proposals.length + ' proposals';
  if (role === 'admin') {
    document.querySelector('#stat-pending').textContent = proposals.filter(p => p.status === 'pending').length;
    document.querySelector('#stat-published').textContent = proposals.filter(p => p.status === 'applied').length;
  }
  const query = document.querySelector('#proposal-query').value.trim().toLowerCase();
  const state = document.querySelector('#proposal-state').value;
  const filtered = proposals.filter(p => (!state || p.status === state) && [p.manifest.merchantId, p.manifest.copy.brand].some(value => value.toLowerCase().includes(query)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const fragment = document.createDocumentFragment();
  for (const proposal of filtered) {
    const card = node('article', undefined, 'listing proposal-card');
    const heading = node('div', undefined, 'section-head');
    heading.append(node('h3', proposal.manifest.copy.brand), badge(proposal.status));
    card.append(heading, node('p', proposal.manifest.copy.headline + ' — ' + proposal.manifest.copy.subhead, 'hint'));
    describe(card, [['Store', proposal.manifest.merchantId], ['Agent', proposal.manifest.catalogScope.join(', ')],
      ['Change', proposal.expectedPreviousManifestDigest === null ? 'New storefront' : 'Update published storefront'],
      ['Staged', new Date(proposal.createdAt).toLocaleString()]]);
    const version = node('details');
    version.append(node('summary', 'Review exact change'), node('pre', JSON.stringify({ manifest: proposal.manifest, expectedPreviousManifestDigest: proposal.expectedPreviousManifestDigest }, null, 2)));
    card.append(version);
    if (proposal.result?.code) card.append(node('p', errorText(proposal.result.code), 'notice'));
    const actions = node('div', undefined, 'actions');
    if (proposal.expectedPreviousManifestDigest !== null || proposal.status === 'applied') {
      const link = node('a', 'Open store ↗', 'route'); link.href = runtimePath('/s/' + encodeURIComponent(proposal.manifest.merchantId)); actions.append(link);
    }
    if (role === 'admin' && proposal.status === 'pending') {
      for (const action of ['Approve and publish', 'Reject proposal']) {
        const button = node('button', action, action === 'Reject proposal' ? 'secondary' : ''); button.type = 'button';
        button.disabled = applying || !operatorToken || !navigator.onLine;
        button.addEventListener('click', async event => {
          if (!event.isTrusted) return;
          button.disabled = true;
          try {
            if (action === 'Approve and publish') await publish(proposal.scope);
            else { await changeProposal(proposal.scope, 'pending', 'rejected'); announce(); await renderProposals(); }
          } catch (error) { report(error); }
        });
        actions.append(button);
      }
    }
    if (['applying', 'uncertain'].includes(proposal.status)) {
      const inspect = node('button', 'Check publication', 'secondary'); inspect.type = 'button'; inspect.disabled = applying || !navigator.onLine;
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
      }); actions.append(inspect);
    }
    if (['applied', 'rejected', 'uncertain'].includes(proposal.status)) {
      const remove = node('button', 'Remove local record', 'quiet'); remove.type = 'button';
      remove.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        try { await proposalStore('readwrite', store => store.delete(proposal.scope)); announce(); await renderProposals(); }
        catch (error) { report(error); }
      }); actions.append(remove);
    }
    card.append(actions); fragment.append(card);
  }
  if (!filtered.length) {
    const empty = node('div', undefined, 'empty-state');
    empty.append(node('h3', proposals.length ? 'No matching proposals' : 'No proposals yet.'), node('p', proposals.length ? 'Try another search or status.' : 'Prepare a storefront in the vendor workspace. Its draft will appear here for review.', 'hint'));
    fragment.append(empty);
  }
  queue.replaceChildren(fragment);
};
for (const id of ['proposal-query', 'proposal-state']) document.getElementById(id).addEventListener('input', () => void renderProposals().catch(report));
const updatePreview = () => {
  const form = document.querySelector('#merchant-editor');
  if (!form) return;
  for (const [key, fallback] of [['brand', 'Your business'], ['headline', 'Your buyer’s next outcome'], ['subhead', 'Tell buyers who you help and what they can achieve.']]) {
    document.querySelector('#preview-' + key).textContent = form.elements.namedItem(key).value.trim() || fallback;
  }
  document.querySelector('#vendor-catalog-id').value = form.elements.namedItem('merchantId').value;
};
document.querySelector('#merchant-editor')?.addEventListener('input', updatePreview);
let catalogRequestRevision = 0;
document.querySelector('#vendor-catalog-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const revision = ++catalogRequestRevision;
  const message = document.querySelector('#vendor-catalog-status');
  const container = document.querySelector('#vendor-catalog');
  message.textContent = 'Loading published catalog…'; container.replaceChildren();
  try {
    const merchantId = document.querySelector('#vendor-catalog-id').value.trim();
    const result = await readMerchant({ merchantId });
    if (revision !== catalogRequestRevision) return;
    message.textContent = result.manifestDigest === null ? 'This store has not been published yet. Stage a storefront and review it in Admin.' : result.listings.length + ' published listings.';
    if (result.manifestDigest !== null) {
      const link = node('a', 'Open store ↗', 'route'); link.href = runtimePath('/s/' + encodeURIComponent(merchantId)); container.append(link);
    }
    for (const listing of (result.listings || []).slice(0, 100)) {
      const row = node('article', undefined, 'proposal-card');
      row.append(node('h3', listing.title || listing.listingId));
      describe(row, [['Category', listing.category], ['Provider', listing.owningAgentId || listing.agentId], ['Listing', listing.listingId]]); container.append(row);
    }
  } catch (error) { if (revision === catalogRequestRevision) message.textContent = errorText(error.message); }
});
let registryAgents = [];
let registryPage = 1;
let registryTotal = 0;
const acceptRegistry = registry => {
  registryTotal = Array.isArray(registry.agents) ? registry.agents.length : 0;
  registryAgents = (registry.agents || []).slice(0, 100);
  registryPage = 1;
  const select = document.querySelector('#registry-state');
  select.replaceChildren(new Option('All states', ''));
  for (const state of [...new Set(registryAgents.map(agent => agent.registrationState || 'registered'))].sort()) select.add(new Option(state, state));
  document.querySelector('#stat-agents').textContent = registryTotal;
  renderRegistry();
};
const renderRegistry = () => {
  const region = document.querySelector('#operator-agents');
  const query = document.querySelector('#registry-query').value.trim().toLowerCase();
  const state = document.querySelector('#registry-state').value;
  const agents = registryAgents.filter(agent => (!state || (agent.registrationState || 'registered') === state)
    && [agent.agentId, agent.declaredCategory || agent.category || ''].some(value => value.toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(agents.length / 10)); registryPage = Math.min(pages, Math.max(1, registryPage));
  document.querySelector('#registry-page').textContent = 'Page ' + registryPage + ' of ' + pages;
  document.querySelector('#registry-previous').disabled = registryPage <= 1;
  document.querySelector('#registry-next').disabled = registryPage >= pages;
  region.replaceChildren();
  if (!agents.length) {
    region.append(node('p', operatorToken ? 'No matching agents. Try another search or state.' : 'Connect an operator session to view agents.', 'panel-body hint')); return;
  }
  const table = node('table');
  table.append(node('caption', registryTotal > 100 ? 'First 100 of ' + registryTotal + ' registered agents' : agents.length + ' matching agents'));
  const head = node('thead'), header = node('tr');
  for (const title of ['Agent', 'Category', 'State', 'Details']) { const th = node('th', title); th.scope = 'col'; header.append(th); } head.append(header); table.append(head);
  const body = node('tbody');
  for (const agent of agents.slice((registryPage - 1) * 10, registryPage * 10)) {
    const row = node('tr'); row.append(node('td', agent.agentId), node('td', agent.declaredCategory || agent.category || '—'));
    const stateCell = node('td'); stateCell.append(badge(agent.registrationState || 'registered')); row.append(stateCell);
    const action = node('td'), view = node('button', 'View', 'secondary'); view.type = 'button'; view.setAttribute('aria-label', 'View agent ' + agent.agentId);
    view.addEventListener('click', () => {
      const detail = document.querySelector('#agent-detail-body'); detail.replaceChildren();
      document.querySelector('#agent-detail-heading').textContent = agent.agentId;
      describe(detail, [['Agent', agent.agentId], ['Category', agent.declaredCategory || agent.category || '—'], ['State', agent.registrationState || 'registered']]);
      document.querySelector('#agent-detail').showModal();
    }); action.append(view); row.append(action);
    [...row.children].forEach((cell, index) => { cell.dataset.label = ['Agent', 'Category', 'State', 'Details'][index]; });
    body.append(row);
  }
  table.append(body); region.append(table);
};
if (role === 'admin') {
  for (const id of ['registry-query', 'registry-state']) document.getElementById(id).addEventListener('input', () => { registryPage = 1; renderRegistry(); });
  for (const [id, direction] of [['registry-previous', -1], ['registry-next', 1]]) document.getElementById(id).addEventListener('click', () => { registryPage += direction; renderRegistry(); });
  document.querySelector('#registry-refresh').addEventListener('click', async event => {
    if (!operatorToken) return;
    const revision = connectionRevision, token = operatorToken; event.target.disabled = true;
    try { const value = await operatorApi('/agents', null, {}, token); if (revision === connectionRevision) acceptRegistry(value); }
    catch (error) { if (revision === connectionRevision) report(error); }
    finally { event.target.disabled = !operatorToken; }
  });
}
for (const event of ['online', 'offline']) window.addEventListener(event, () => {
  document.querySelector('#offline-indicator').hidden = navigator.onLine;
  void renderProposals().catch(report);
});
