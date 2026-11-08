import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System icon size from its offline shell assets', () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  assert.equal(pin.sourceRevision, '431b9b60f3f8a85362ea5c99f6dbf502265a210a');
  assert.equal(pin.registryRevision, '4f76b3c15b52c25a61f27039f6b437f67d91430a');
  const profile = fs.readFileSync('public/local-first/shared-ui-profile.css', 'utf8');
  assert.match(profile, /stroke-width: var\(--agentic-icon-stroke-width\)/);
  assert.match(profile, /--agentic-font-size-body: 0\.875rem;/);
  assert.match(profile, /--agentic-line-height-body: 1\.25rem;/);
  const worker = fs.readFileSync('src/local-first/worker.ts', 'utf8');
  assert.match(worker, /'\/shared-ui-profile\.css'/);
})

test('housing priorities use the offline checkbox group with no local layout override', () => {
  const housing = fs.readFileSync('public/local-first/housing-comparison.js', 'utf8');
  assert.match(housing, /<fieldset class="agentic-checkbox-group housing-field-wide"><legend>Priorities/);
  const localCss = fs.readFileSync('public/local-first/housing-comparison.css', 'utf8');
  assert.doesNotMatch(localCss, /[.]housing-choice-list|[.]agentic-checkbox-group/);
})

test('workspace pack pickers share the owner selection rule', () => {
  const html = fs.readFileSync('public/local-first/workspace-pack.html', 'utf8');
  for (const name of ['Output format', 'Response stage']) {
    assert.ok(html.includes(`class="agentic-toggle-group" role="group" aria-label="${name}"`));
  }
  const css = fs.readFileSync('public/local-first/workspace-pack.css', 'utf8');
  assert.doesNotMatch(css, /\.agentic-(?:toggle-group|control-selected)\b|--agentic-control-selected-[\w-]+\s*:|\[aria-pressed=true\]/);
});
