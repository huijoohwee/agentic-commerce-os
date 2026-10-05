import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../../src/local-first/worker.ts';
import { OFFER_COLUMNS, projectOfferRows, projectOfferDetail } from '../../public/local-first/workspace-graph.js';
import { FILES, verifyGraphDataView } from '../../scripts/local-first-release/artifact.mjs';

const assets = ['graph-data-view.js', 'graph-data-view.css', 'graph-ui-tokens.css'];
const hash = value => createHash('sha256').update(value).digest('hex');
const readPin = () => JSON.parse(fs.readFileSync('config/graph-data-view.json', 'utf8'));
const literal = '<img src=x onerror=alert(1)> /buy @operator #draft';
const offer = Object.freeze({ id: 'offer-one', title: literal, revision: 7, updatedAt: 1760000000000,
  description: 'PRIVATE-DRAFT-NOTES', price: 'PRIVATE-PRICE-NOTES', workflow: { output: 'PRIVATE-WORKFLOW-OUTPUT' },
  launch: Object.freeze({ merchantId: 'public-store', audience: 'Public audience', outcome: 'Public outcome', priceMinor: 1200 }) });
const presentation = Object.freeze({ status: () => 'Needs human review', price: () => '$12.00', reason: () => 'Review the saved offer' });

test('Graph projections pass only explicit public fields and preserve literal strings', () => {
  const rows = projectOfferRows([offer], presentation);
  assert.deepEqual(rows, [{ id: offer.id, cells: [literal, 'public-store', 'Needs human review', '$12.00', new Date(offer.updatedAt).toLocaleDateString()] }]);
  assert.equal(rows[0].cells.length, OFFER_COLUMNS.length);
  const detail = projectOfferDetail(offer, presentation);
  assert.deepEqual(detail.columns.map(column => column.name), ['Offer', 'Merchant', 'Review status', 'Planned price', 'Buyer', 'Outcome', 'Review guidance', 'Saved revision']);
  assert.deepEqual(detail.rows, [{ id: offer.id, cells: [literal, 'public-store', 'Needs human review', '$12.00', 'Public audience', 'Public outcome', 'Review the saved offer', '7'] }]);
  for (const projection of [rows, detail]) assert.doesNotMatch(JSON.stringify(projection), /PRIVATE|description|workflow|priceMinor/);
  assert([...rows[0].cells, ...detail.rows[0].cells].every(cell => typeof cell === 'string'));
  rows[0].cells[0] = 'consumer change'; detail.rows[0].cells[0] = 'consumer change';
  assert.equal(offer.title, literal);
  assert.deepEqual(projectOfferRows([], presentation), []);
});

test('missing launch fields have explicit presentation defaults and private fields are never read', () => {
  const draft = { id: 'empty', title: 'Untitled launch', revision: 1, updatedAt: 1 };
  for (const property of ['description', 'price', 'workflow', 'notes']) Object.defineProperty(draft, property, {
    get() { throw Error('Private field was read: ' + property); }, enumerable: true,
  });
  assert.equal(projectOfferRows([draft], presentation)[0].cells[1], 'Store not set');
  assert.deepEqual(projectOfferDetail(draft, presentation).rows[0].cells,
    ['Untitled launch', 'Store not set', 'Needs human review', '$12.00', 'Not set', 'Not set', 'Review the saved offer', '1']);
});

test('generated Graph assets match their bounded native manifest and remain self-contained', () => {
  const pin = readPin();
  assert.equal(pin.schema, 'agentic-graph/data-view-artifact/v1');
  assert.equal(pin.entry, 'canvas/src/features/markdown/ui/dataViewBrowserAdapter.tsx');
  assert.equal(pin.browserExport, 'mountDataView');
  assert.equal(pin.cssScope, 'shadow-root');
  assert.equal(pin.hostTokens, 'graph-ui-tokens.css');
  assert.match(pin.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(typeof pin.sourceDirty, 'boolean');
  assert.equal(pin.inputDigest, hash(JSON.stringify(pin.inputs)));
  const inputNames = pin.inputs.map(input => input.path);
  assert.equal(new Set(inputNames).size, inputNames.length);
  assert.deepEqual(inputNames, [...inputNames].sort());
  for (const input of pin.inputs) {
    assert(!input.path.startsWith('/') && !input.path.split('/').includes('..'));
    assert(Number.isSafeInteger(input.bytes) && input.bytes > 0);
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
  }
  for (const required of [pin.entry, 'canvas/scripts/build-data-view-adapter.mjs',
    'canvas/src/features/markdown/ui/MarkdownDataViewTableCore.tsx', 'grph-shared/src/ui/themeTokens.ts',
    'grph-shared/src/ui/kgTokens.ts', 'grph-shared/src/ui/typography.ts']) assert(inputNames.includes(required), required);
  assert(!inputNames.some(file => file.startsWith('canvas/src/') && /(?:\/hooks\/|useGraphStore|\/storage\/|\/three\/|\/mermaid\/|\/rich-media\/)/.test(file)));
  assert.deepEqual(pin.outputs.map(output => output.path).sort(), [...assets].sort());
  for (const output of pin.outputs) {
    const file = 'public/local-first/' + output.path, stat = fs.lstatSync(file), bytes = fs.readFileSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert(bytes.length > 0 && bytes.length < 500000);
    assert.equal(bytes.length, output.bytes); assert.equal(hash(bytes), output.sha256);
    const text = bytes.toString('utf8');
    if (output.path.endsWith('.css')) assert.doesNotMatch(text, /@import\b|url\(\s*['"]?(?:https?:|\/\/)/i);
    else {
      assert.doesNotMatch(text, /\bimport\s*(?:\(|['"]|[^;\n]*?\bfrom\s*['"])/);
      assert.doesNotMatch(text, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
      assert.match(text, /mountDataView/);
    }
  }
});

test('release pin requires a clean committed native Graph source', () => {
  // Structural tests above accept a truthful provisional build; this release gate does not.
  const pin = verifyGraphDataView();
  assert.equal(pin.sourceDirty, false, 'Rebuild from the final clean Graph commit before accepting this release pin.');
});

test('release verification rejects provisional native provenance', t => {
  const dirty = { ...readPin(), sourceDirty: true }, original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    return file === 'config/graph-data-view.json' ? JSON.stringify(dirty) : original.call(this, file, ...args);
  });
  assert.throws(() => verifyGraphDataView(), /provenance/i);
});

test('Graph assets are included and served only under the Commerce release identity', async () => {
  const revision = 'a'.repeat(40), seen = [];
  const names = ['workspace-graph.js', ...assets];
  const env = { RELEASE_CANDIDATE_SHA: revision, ASSETS: { fetch(request) {
    assert.deepEqual([...request.headers], []);
    seen.push(new URL(request.url).pathname);
    return new Response('native fixture asset');
  } } };
  for (const name of names) {
    assert(FILES.includes(name));
    const response = await worker.fetch(new Request(`https://airvio.co/agentic-commerce-os/assets/${revision}/${name}`, {
      headers: { cookie: 'private=1', authorization: 'Bearer private' },
    }), env);
    assert.equal(response.status, 200); assert.equal(seen.at(-1), '/' + name);
    assert.equal(response.headers.get('x-commerce-source'), revision);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
    const count = seen.length;
    assert.equal((await worker.fetch(new Request(`https://airvio.co/agentic-commerce-os/assets/${'b'.repeat(40)}/${name}`), env)).status, 404);
    assert.equal(seen.length, count);
  }
});
