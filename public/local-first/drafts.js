export const LIMITS = Object.freeze({ count: 100, title: 120, description: 10000, price: 120, transferBytes: 8000000 });
export const MAXIMUM_AMOUNT_MINOR = 1_000_000_000;
const TERMS_KEYS = ['acquisitionCostMinor', 'agentCostMinor', 'agentId', 'audience', 'currency',
  'deliveryCostMinor', 'fixedCostMinor', 'merchantId', 'outcome', 'priceMinor', 'providerFeeMinor'];
const MONEY_KEYS = ['priceMinor', 'deliveryCostMinor', 'providerFeeMinor', 'agentCostMinor', 'acquisitionCostMinor', 'fixedCostMinor'];
const DATABASE = 'agentic-commerce-local-drafts';
const SCHEMA = 'commerce.local-drafts/v3';
const LEGACY_KEYS = ['createdAt', 'description', 'id', 'price', 'revision', 'title', 'updatedAt'];
const V2_KEYS = [...LEGACY_KEYS, 'launch'].sort();
const KEYS = [...V2_KEYS, 'workflow'].sort();
const WORKFLOW_KEYS = 'description,inputRevision,outputDigest,reviewedDigest,runId,status,text,title';
export function validWorkflow(value) {
  const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === WORKFLOW_KEYS
    && typeof value.title === 'string' && value.title.trim() && value.title.length <= 120
    && typeof value.description === 'string' && value.description.length <= 10000
    && Number.isSafeInteger(value.inputRevision) && value.inputRevision > 0
    && (value.runId === null ? value.status === 'queued' : typeof value.runId === 'string' && /^listing-[a-f0-9]{64}$/u.test(value.runId))
    && ['queued', 'planning', 'running', 'completed', 'blocked', 'canceled', 'pending', 'idle', 'reconciling', 'synthesizing'].includes(value.status)
    && (value.status === 'completed' ? typeof value.text === 'string' && value.text.trim()
      && new TextEncoder().encode(value.text).byteLength <= 16000 && hash(value.outputDigest)
      : value.text === null && value.outputDigest === null)
    && (value.reviewedDigest === null || value.status === 'completed' && value.reviewedDigest === value.outputDigest);
}

export function validLaunchTerms(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === TERMS_KEYS.join()
    && ['merchantId', 'agentId'].every(key => typeof value[key] === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value[key]))
    && ['audience', 'outcome'].every(key => typeof value[key] === 'string'
      && value[key].trim() === value[key] && value[key].length > 0 && value[key].length <= 280)
    && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)
    && MONEY_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAXIMUM_AMOUNT_MINOR)
    && value.priceMinor > 0;
}

export function validDraft(value, legacy = false) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (legacy ? Object.keys(value).sort().join() === LEGACY_KEYS.join()
      : [V2_KEYS.join(), KEYS.join()].includes(Object.keys(value).sort().join()))
    && (legacy || value.launch === null || validLaunchTerms(value.launch))
    && (!Object.hasOwn(value, 'workflow') || value.workflow === null || validWorkflow(value.workflow)
      && value.workflow.inputRevision <= value.revision)
    && typeof value.id === 'string' && /^[0-9a-f-]{36}$/.test(value.id)
    && ['title', 'description', 'price'].every(key => typeof value[key] === 'string' && value[key].length <= LIMITS[key])
    && value.title.trim().length > 0
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && Number.isSafeInteger(value.createdAt) && value.createdAt > 0
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

export function parseImport(text) {
  if (new TextEncoder().encode(text).length > LIMITS.transferBytes) throw Error('Import exceeds 8 MB.');
  let value;
  try { value = JSON.parse(text); } catch { throw Error('Choose a valid draft JSON export.'); }
  const legacy = value?.schema === 'commerce.local-drafts/v1', v2 = value?.schema === 'commerce.local-drafts/v2';
  if (!value || Object.keys(value).sort().join() !== 'drafts,schema' || (!legacy && !v2 && value.schema !== SCHEMA)
    || !Array.isArray(value.drafts) || value.drafts.length > LIMITS.count
    || !value.drafts.every(draft => validDraft(draft, legacy)
      && Object.keys(draft).sort().join() === (legacy ? LEGACY_KEYS : v2 ? V2_KEYS : KEYS).join())
    || new Set(value.drafts.map(draft => draft.id)).size !== value.drafts.length) {
    throw Error('This file is not a supported draft export. Existing drafts were kept.');
  }
  return value.drafts.map(normalizeStored).map(draft => draft.workflow
    ? { ...draft, workflow: { ...draft.workflow, reviewedDigest: null } } : draft);
}

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('Browser storage is unavailable. Export or copy your text before leaving.'));
    request.onblocked = () => reject(Error('Close older Commerce tabs before opening storage.'));
  });
}

async function transaction(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode), store = tx.objectStore('drafts');
    let result, failure;
    const fail = error => { failure = error; tx.abort(); };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure || Error('Draft storage failed. Your current text is still in the editor.')); };
    try { operation(store, value => { result = value; }, fail); } catch (error) { fail(error); }
  });
}

export function listDrafts() {
  return transaction('readonly', (store, done, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      try { done(request.result.map(normalizeStored).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))); }
      catch (error) { fail(error); }
    };
  });
}

export function saveDraft(input, expectedRevision = null, { allowNewWorkflow = false } = {}) {
  if (!input || !['title', 'description', 'price'].every(key => typeof input[key] === 'string')) {
    throw Error('Add a title and keep each field within its limit.');
  }
  return transaction('readwrite', (store, done, fail) => {
    const id = input.id || crypto.randomUUID(), read = store.get(id);
    read.onsuccess = () => {
      let previous;
      try { previous = read.result ? normalizeStored(read.result) : null; } catch (error) { fail(error); return; }
      if ((previous?.revision ?? null) !== expectedRevision) {
        fail(Error('This draft changed in another tab. Export or copy your edits, then reopen the saved draft.')); return;
      }
      if (input.workflow && !previous?.workflow && allowNewWorkflow !== true) {
        fail(Error('Reconnect to the execution host before preparing a new listing. Your draft was kept.')); return;
      }
      const count = store.count();
      count.onsuccess = () => {
        if (!previous && count.result >= LIMITS.count) { fail(Error('This workspace holds up to 100 drafts. Export a backup to keep your work.')); return; }
        const now = Date.now();
        const draft = { id, title: input.title.trim(), description: input.description, price: input.price,
          launch: input.launch === undefined ? previous?.launch ?? null : input.launch,
          workflow: input.workflow === undefined ? previous?.workflow ?? null : input.workflow,
          revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now,
          updatedAt: Math.max(now, previous?.updatedAt ?? 0) };
        if (draft.workflow && (draft.title !== draft.workflow.title || draft.description !== draft.workflow.description))
          draft.workflow = { ...draft.workflow, reviewedDigest: null };
        // Keep ordinary drafts readable by retained v2 clients until a job is explicitly prepared.
        if (draft.workflow === null) delete draft.workflow;
        if (!validDraft(draft)) { fail(Error('Add a title and keep each field within its limit.')); return; }
        store.put(draft); done(draft);
      };
    };
  });
}

export async function importDrafts(text, authorizeWorkflow = null) {
  const incoming = parseImport(text);
  if (incoming.some(draft => draft.workflow) &&
    !(typeof authorizeWorkflow === 'function' && await authorizeWorkflow() === true)) {
    throw Error('The execution host must be available before importing listing jobs. Existing drafts were kept.');
  }
  return transaction('readwrite', (store, done, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      let existing;
      try { existing = new Map(request.result.map(normalizeStored).map(draft => [draft.id, draft])); }
      catch (error) { fail(error); return; }
      const additions = [];
      for (const draft of incoming) {
        const previous = existing.get(draft.id);
        if (previous && KEYS.some(key => JSON.stringify(previous[key]) !== JSON.stringify(draft[key]))) {
          fail(Error('An imported draft conflicts with a saved draft. Nothing was replaced.')); return;
        }
        if (!previous) additions.push(draft);
      }
      if (existing.size + additions.length > LIMITS.count) { fail(Error('Import would exceed the 100-draft limit. Nothing was changed.')); return; }
      additions.forEach(draft => store.add(draft)); done(additions.length);
    };
  });
}

function normalizeStored(draft) {
  if (validDraft(draft, true)) return { ...draft, launch: null, workflow: null };
  if (!validDraft(draft)) throw Error('Saved draft is malformed. Preserve your backup before continuing.');
  return { ...draft, workflow: draft.workflow ?? null,
    launch: draft.launch === null ? null : Object.fromEntries(TERMS_KEYS.map(key => [key, draft.launch[key]])) };
}

export async function exportDrafts() {
  const drafts = await listDrafts(), workflows = drafts.some(draft => draft.workflow !== null);
  return JSON.stringify({ schema: workflows ? SCHEMA : 'commerce.local-drafts/v2',
    drafts: workflows ? drafts : drafts.map(({ workflow: _workflow, ...draft }) => draft) }, null, 2);
}
