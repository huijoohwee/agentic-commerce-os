import test from 'node:test';
import assert from 'node:assert/strict';
import { launchFieldIssues, validLaunchTerms, MAXIMUM_AMOUNT_MINOR } from '../../public/local-first/drafts.js';
import { inspectLaunchInput, parseLaunchInput, evaluateOfferSetup, evaluateLaunch } from '../../public/local-first/launch.js';
import { invokeWorkspace, workspaceSnapshot } from '../../public/local-first/workspace-capabilities.js';
import worker from '../../src/local-first/worker.ts';

const terms = Object.freeze({ merchantId: 'local-store', agentId: 'discovery-agent', audience: 'Independent makers',
  outcome: 'One useful result', currency: 'USD', priceMinor: 1000, deliveryCostMinor: 0, providerFeeMinor: 0,
  agentCostMinor: 0, acquisitionCostMinor: 0, fixedCostMinor: 2000 });
const moneyKeys = ['priceMinor', 'deliveryCostMinor', 'providerFeeMinor', 'agentCostMinor', 'acquisitionCostMinor', 'fixedCostMinor'];
const raw = () => Object.fromEntries(Object.entries(terms).map(([key, value]) => [key, moneyKeys.includes(key) ? String(value / 100) : value]));
const draft = launch => ({ id: '12345678-1234-1234-1234-123456789abc', title: 'Useful offer', description: 'PRIVATE research',
  price: 'PRIVATE negotiation notes', launch, revision: 2, createdAt: 1, updatedAt: 2 });
const step = (setup, id) => setup.steps.find(value => value.id === id);
const name = 'commerce.workspace.offer.review';

test('field diagnostics retain the strict launch field contract and boundaries', () => {
  assert.deepEqual(launchFieldIssues(terms), []);
  for (const field of Object.keys(terms)) {
    const missing = { ...terms }; delete missing[field];
    assert.equal(validLaunchTerms(missing), false);
    assert(launchFieldIssues(missing).some(issue => issue.field === field), field);
  }
  for (const [field, values] of Object.entries({
    merchantId: ['', 'Uppercase', '../other', 'a'.repeat(129), 1], agentId: ['', 'agent name', null],
    audience: ['', ' padded', 'x'.repeat(281), 1], outcome: ['', 'padded ', null], currency: ['', 'usd', 'US', 123],
    priceMinor: [0, -1, 0.1, NaN, Infinity, MAXIMUM_AMOUNT_MINOR + 1],
    deliveryCostMinor: [-1, 0.1, '0', null], providerFeeMinor: [-1], agentCostMinor: [-1],
    acquisitionCostMinor: [-1], fixedCostMinor: [-1],
  })) for (const value of values) {
    const input = { ...terms, [field]: value };
    assert.equal(validLaunchTerms(input), false, field + '=' + value);
    assert(launchFieldIssues(input).some(issue => issue.field === field));
  }
  for (const input of [null, [], 'launch', { ...terms, approved: true }]) {
    assert.equal(validLaunchTerms(input), false);
    assert(launchFieldIssues(input).some(issue => issue.field === 'launch'));
  }
  const boundary = { ...terms, merchantId: 'a'.repeat(128), agentId: 'a-._0', audience: 'x'.repeat(280),
    outcome: 'x'.repeat(280), priceMinor: MAXIMUM_AMOUNT_MINOR };
  assert.equal(validLaunchTerms(boundary), true);
  assert.equal(validLaunchTerms(Object.fromEntries(Object.entries(boundary).reverse())), true);
});

test('editor normalization and strict saving use the same parse result without coercing blank costs', () => {
  assert.deepEqual(inspectLaunchInput({}), { terms: null, issues: [], hasInput: false });
  assert.equal(parseLaunchInput(Object.fromEntries(Object.keys(terms).map(key => [key, '   ']))), null);
  const input = { ...raw(), merchantId: ' local-store ', audience: ' Independent makers ', currency: ' usd ' };
  const before = structuredClone(input), result = inspectLaunchInput(input);
  assert.deepEqual(result, { terms: { ...terms }, issues: [], hasInput: true });
  assert.deepEqual(parseLaunchInput(input), result.terms); assert.deepEqual(input, before);
  for (const [field, value] of [['deliveryCostMinor', ''], ['priceMinor', '0'], ['priceMinor', '1.001'],
    ['agentCostMinor', '-1'], ['providerFeeMinor', '1e2'], ['fixedCostMinor', '1,000'], ['currency', 'US']]) {
    const invalid = { ...input, [field]: value }, inspected = inspectLaunchInput(invalid);
    assert(inspected.issues.some(issue => issue.field === field), field + '=' + value);
    assert.throws(() => parseLaunchInput(invalid), { message: inspected.issues[0].message });
  }
  assert.equal(inspectLaunchInput({ ...input, deliveryCostMinor: '' }).terms.deliveryCostMinor, '');
  assert.equal(parseLaunchInput({ ...input, fixedCostMinor: '0' }).fixedCostMinor, 0);
  assert.throws(() => parseLaunchInput({ ...input, approved: 'true' }), /supported/);
  assert.throws(() => parseLaunchInput(null), /supported/);
  for (const [currency, price, expected] of [['JPY', '125', 125], ['KWD', '1.234', 1234]]) {
    assert.equal(parseLaunchInput({ ...raw(), currency, priceMinor: price }).priceMinor, expected);
  }
});

test('setup separates incomplete values from valid identity syntax and existing economics', () => {
  const empty = evaluateOfferSetup({ title: '', launch: null });
  assert.equal(empty.status, 'draft'); assert.equal(empty.economics, null);
  assert(empty.steps.every(value => !value.complete && value.fields.length > 0));
  const setup = evaluateOfferSetup({ title: 'Useful offer', launch: terms });
  assert.equal(setup.status, 'reviewable'); assert(setup.steps.every(value => value.complete));
  assert.deepEqual(setup.economics, evaluateLaunch(terms));
  assert.equal(setup.economics.firstSaleNetMinor, -1000);
  assert.equal(setup.humanReview, 'still-required');
  const partial = evaluateOfferSetup({ title: '', launch: { ...terms, merchantId: '', audience: '' } });
  assert.equal(partial.status, 'draft'); assert.equal(step(partial, 'describe').complete, false);
  assert.deepEqual(step(partial, 'identity').fields, ['merchantId']);
  assert.equal(step(partial, 'economics').complete, true);
  assert.deepEqual(partial.economics, setup.economics);
  for (const title of [' ', 'x'.repeat(121), null]) assert.equal(evaluateOfferSetup({ title, launch: terms }).status, 'draft');
  for (const deliveryCostMinor of [1000, 1001]) {
    const loss = { ...terms, deliveryCostMinor }, result = evaluateOfferSetup({ title: 'Offer', launch: loss });
    assert.equal(result.status, 'revise_costs_or_price');
    assert.deepEqual(step(result, 'economics'), { id: 'economics', complete: false, fields: ['priceMinor'] });
    assert.deepEqual(result.economics, evaluateLaunch(loss));
  }
  const invalid = evaluateOfferSetup({ title: 'Offer', launch: inspectLaunchInput({ ...raw(), agentCostMinor: '' }).terms });
  assert.equal(invalid.status, 'draft'); assert.equal(invalid.economics, null);
  assert.deepEqual(step(invalid, 'economics').fields, ['agentCostMinor']);
  assert.equal(evaluateOfferSetup({ title: 'Offer', launch: { ...terms, published: true } }).status, 'draft');
});

test('offer review reuses setup without private fields, human approval or relaxed revision guards', async () => {
  for (const launch of [null, terms, { ...terms, deliveryCostMinor: 1001 }]) {
    const saved = draft(launch), snapshot = workspaceSnapshot([saved]);
    const args = { snapshot, offerId: saved.id, expectedRevision: saved.revision };
    const result = await invokeWorkspace(name, args), local = await invokeWorkspace(name,
      { offerId: saved.id, expectedRevision: saved.revision }, { snapshot: () => snapshot });
    assert.deepEqual(result.value.setup, evaluateOfferSetup(saved));
    assert.deepEqual(local.value, result.value);
    assert.equal(result.value.status, result.value.setup.status);
    assert.deepEqual(result.value.economics, result.value.setup.economics);
    assert.equal(result.value.humanReview, 'still-required');
    assert.equal(result.value.setup.humanReview, 'still-required');
    assert.equal(result.readOnly, true); assert.equal(result.provenance, 'provided-snapshot');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|description|approved|contentDigest|workflow/);
    await assert.rejects(invokeWorkspace(name, { ...args, expectedRevision: 1 }), /revision_changed/);
    await assert.rejects(invokeWorkspace(name, { ...args, approved: true }), /arguments_invalid/);
    await assert.rejects(invokeWorkspace(name, { ...args, snapshot: { ...snapshot,
      offers: [{ ...snapshot.offers[0], description: 'PRIVATE' }] } }), /snapshot_invalid/);
  }
});

test('read-only MCP and REST expose identical setup assessments for each economics state', async () => {
  const base = 'https://airvio.co/agentic-commerce-os/services/workspace';
  const env = { RELEASE_CANDIDATE_SHA: 'a'.repeat(40), ASSETS: { fetch() { throw Error('Unexpected asset read'); } } };
  const post = (route, body) => new Request(base + route, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify(body) });
  for (const launch of [null, terms, { ...terms, fixedCostMinor: 0 }, { ...terms, deliveryCostMinor: 1000 }, { ...terms, deliveryCostMinor: 1001 }]) {
    const saved = draft(launch), args = { snapshot: workspaceSnapshot([saved]), offerId: saved.id, expectedRevision: saved.revision };
    const rest = await worker.fetch(post('/api', { name, arguments: args }), env);
    const mcp = await worker.fetch(post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), env);
    assert.equal(rest.status, 200); assert.equal(mcp.status, 200);
    const call = (await mcp.json()).result; assert.notEqual(call.isError, true);
    const value = JSON.parse(call.content[0].text);
    assert.deepEqual(value, await rest.json()); assert.deepEqual(value.value.setup, evaluateOfferSetup(saved));
    const stale = await worker.fetch(post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name, arguments: { ...args, expectedRevision: 1 } } }), env);
    const rejected = (await stale.json()).result;
    assert.equal(rejected.isError, true); assert.equal(rejected.content[0].text, 'workspace_revision_changed');
  }
});
