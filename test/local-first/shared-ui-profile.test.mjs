import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System icon size from its offline shell assets', () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  assert.equal(pin.sourceRevision, 'f73934c884a6ae8d1c7d0521408014dde20a6c2d');
  assert.equal(pin.registryRevision, '25290dabc9cd50e4ab9baf14f2a8c2165aaa3c86');
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

test('Workspace Pack takes panel geometry and colors from the pinned stylesheets', () => {
  const html = fs.readFileSync('public/local-first/workspace-pack.html', 'utf8');
  const css = fs.readFileSync('public/local-first/workspace-pack.css', 'utf8');
  const owners = [...css.matchAll(/@import\s+([^;]+);/gi)].map(match => match[1].trim());
  assert.deepEqual(owners, ['"./graph-ui-tokens.css"', '"./commerce-theme.css"', '"./shared-ui-profile.css"']);
  assert.match(html, /id="builder" class="agentic-dashboard-layout"/);
  assert.match(html, /class="agentic-dashboard-region">\s*<div class="agentic-dashboard-grid" data-columns="2">/);
  assert.match(html, /class="formats agentic-dashboard-region"/);
  assert.match(html, /class="format-grid agentic-dashboard-grid" data-columns="4"/);
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'local inline styles bypass the owner');
  assert.doesNotMatch(css, /(?:[;{]\s*--[\w-]+\s*:|\bcolor-scheme\s*:|\.agentic-[\w-]+|\.(?:workspace|panel|format-grid)\s*\{)/,
    'the consumer must not declare theme tokens or replace the shared layout');
  for (const [, value] of css.matchAll(/(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-(?:top|bottom|left|right|(?:block|inline)(?:-(?:start|end))?))?(?:-color)?|outline(?:-color)?|box-shadow)\s*:\s*([^;}]+)/gm)) {
    const remainder = value.replace(/var\(--(?:commerce|kg|agentic)-[\w-]+\)/g, '')
      .replace(/color-mix\(in srgb,\s*\d+%, transparent\)/g, '')
      .replace(/(?:\b(?:none|solid|transparent|currentColor)\b|[\d.]+(?:px|rem|%)?|\s)/g, '');
    assert.equal(remainder, '', 'use the owner palette for ' + value);
  }
});

test('the storefront leaves the Mission grid, cards and selected colors to the shared profile', () => {
  for (const file of ['style.css', 'workspace-shell.css']) {
    const css = fs.readFileSync('public/local-first/' + file, 'utf8')
      .replaceAll(':where(:not(.agentic-dashboard-layout))', '');
    assert.doesNotMatch(css, /\.agentic-dashboard-(?:layout|header|grid|card)\b|--agentic-(?:dashboard-[\w-]+|control-selected-[\w-]+)\s*:/);
    assert.doesNotMatch(css, /\.(?:shopper-hero|shop-preview-card|product-grid|demo-type-filters)\b/);
  }
});
