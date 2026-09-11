const proposalPrefix = 'merchant-proposal/';
const proposalRange = () => IDBKeyRange.bound(proposalPrefix, proposalPrefix + '\uffff');
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('commerce-merchant-review') : null;
const announce = () => channel?.postMessage('changed');
const proposalStore = async (mode, operation) => {
  const database = await openDatabase();
  try {
    const transaction = database.transaction('completed-sync', mode);
    const done = transactionDone(transaction);
    try {
      const result = await operation(transaction.objectStore('completed-sync'));
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch {}
      await done.catch(() => undefined);
      throw error;
    }
  } finally { database.close(); }
};
const readProposals = () => proposalStore('readonly', store => requestResult(store.getAll(proposalRange(), 20)));
const changeProposal = (scope, expected, status, result = null) => proposalStore('readwrite', async store => {
  const prior = await requestResult(store.get(scope));
  if (!prior || prior.status !== expected) return null;
  const next = { ...prior, status, result, updatedAtMs: Date.now() };
  store.put(next);
  return next;
});
const api = async (path, options = {}, signal) => {
  const response = await fetch(runtimePath(path), { ...options, credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok || value?.ok === false) throw Object.assign(new Error(value?.code || 'request_failed'), { holdingLeaseEpoch: value?.holdingLeaseEpoch });
  return value;
};
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
const readMerchant = async ({ merchantId }, options = {}) => {
  if (!identifier(merchantId)) throw new Error('merchant_id_malformed');
  try { return await api('/v1/public/merchants/' + merchantId + '/catalog', {}, options.signal); }
  catch (error) {
    if (error.message === 'theme_deployment_not_found') return { ok: true, merchantId, manifestDigest: null, listings: [] };
    throw error;
  }
};
const stageTheme = async (input, options = {}) => {
  options.signal?.throwIfAborted();
  if (!input || Object.keys(input).sort().join(',') !== 'agentId,brand,headline,merchantId,subhead'
    || !identifier(input.merchantId) || !identifier(input.agentId)
    || !['brand','headline','subhead'].every(key => typeof input[key] === 'string' && input[key].trim() && input[key].length <= 280)) {
    throw new Error('proposal_input_invalid');
  }
  const manifest = { ...themeDefaults, merchantId: input.merchantId, catalogScope: [input.agentId],
    copy: { ...themeDefaults.copy, brand: input.brand.trim(), headline: input.headline.trim(), subhead: input.subhead.trim() } };
  const current = await readMerchant(input, options);
  const expectedPreviousManifestDigest = current.manifestDigest;
  if (expectedPreviousManifestDigest !== null && !/^[0-9a-f]{64}$/.test(expectedPreviousManifestDigest || '')) throw new Error('theme_version_unavailable');
  const proposal = { manifest, expectedPreviousManifestDigest };
  const scope = proposalPrefix + await digest(proposal);
  options.signal?.throwIfAborted();
  const saved = await proposalStore('readwrite', async store => {
    const prior = await requestResult(store.get(scope));
    if (prior) return prior;
    if (await requestResult(store.count(proposalRange())) >= 20) throw new Error('proposal_capacity_reached');
    const record = { scope, ...proposal, status: 'pending', createdAt: new Date().toISOString() };
    store.add(record);
    return record;
  });
  announce();
  await renderProposals();
  return { ok: true, proposalId: scope.slice(proposalPrefix.length), status: saved.status };
};
