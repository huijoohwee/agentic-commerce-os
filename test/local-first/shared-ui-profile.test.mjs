import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import worker from '../../src/local-first/worker.ts';
import { verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System icon size from its offline shell assets', async () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  assert.equal(pin.sourceRevision, 'f73934c884a6ae8d1c7d0521408014dde20a6c2d');
  assert.equal(pin.registryRevision, '4ef5bf3f2371574ae159a4d947691716d5904c63');
  const profile = fs.readFileSync('public/local-first/shared-ui-profile.css', 'utf8');
  assert.match(profile, /stroke-width: var\(--agentic-icon-stroke-width\)/);
  assert.match(profile, /--agentic-font-size-body: 0\.875rem;/);
  assert.match(profile, /--agentic-line-height-body: 1\.25rem;/);
  const revision = 'f'.repeat(40);
  const env = {RELEASE_CANDIDATE_SHA:revision, ASSETS:{fetch(request) {
    assert.equal(new URL(request.url).pathname, '/shared-ui-profile.css');
    return new Response(profile);
  }}};
  for (const path of ['shared-ui-profile.css','services/workspace-pack/shared-ui-profile.css']) {
    const response = await worker.fetch(new Request('https://store.example/agentic-commerce-os/assets/' + revision + '/' + path), env);
    assert.equal(response.status, 200); assert.equal(await response.text(), profile);
  }
})

test('SME workflow actions reuse the shared responsive control geometry', () => {
  const css = fs.readFileSync('public/local-first/sme-business-pack.css', 'utf8');
  const rule = css.match(/#sme \.workflow-toolbar button:not\(\.agentic-form-control\)\s*\{([^}]*)\}/u)?.[1];
  assert.ok(rule, 'workflow actions must keep one owning rule');
  assert.match(rule, /block-size:\s*var\(--agentic-control-height\)/u);
  assert.match(rule, /min-block-size:\s*var\(--agentic-control-height\)/u);
  assert.match(rule, /padding-block:\s*0/u);
  assert.match(rule, /border-radius:\s*var\(--agentic-control-radius\)/u);
  assert.doesNotMatch(rule, /(?:min-)?height:\s*44px|padding:\s*9px\s+13px/u);
});

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
  assert.match(fs.readFileSync('public/local-first/commerce-shell.css', 'utf8'), /@import "\.\/floating-panel\.css";/);
  assert.deepEqual(owners, ['"./graph-ui-tokens.css"', '"./commerce-theme.css"', '"./shared-ui-profile.css"', '"./commerce-shell.css"', '"./toolbar.css"']);
  assert.match(html, /id="builder" class="agentic-dashboard-layout"/);
  assert.match(html, /class="agentic-dashboard-region">\s*<div class="agentic-dashboard-grid" data-columns="2" data-dashboard-columns-for="builder">/);
  assert.match(html, /id="formats" class="agentic-dashboard-layout"/);
  assert.match(html, /class="format-grid" data-dashboard-primitive="container" data-columns="4"/);
  assert.doesNotMatch(css, /\.console-(?:panel|top)\b|#console-panel\s*\{/, 'do not recreate the shared FloatingPanel shell');
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

test('storefront and service navigation use the pinned Toolbar without a local surface', () => {
  for (const file of ['workspace-pack.css', 'workspace-shell.css']) {
    const css = fs.readFileSync('public/local-first/' + file, 'utf8');
    assert.match(css, /@import "\.\/toolbar\.css";/);
    assert.match(css, /@import "\.\/commerce-shell\.css";/);
    assert.doesNotMatch(css, /\.(?:commerce-chrome|commerce-flyout|commerce-banner|service-note)\b/);
    assert.doesNotMatch(css, /\.agentic-toolbar(?:[-\w]*)\b|\.topbar\s*[{>]|body\s*>\s*header\s*\{/);
  }
  const owner = fs.readFileSync('public/local-first/commerce-toolbar.js', 'utf8');
  assert.match(owner, /import \{ createIconButton \} from '\.\/toolbar-icons\.js'/);
  for (const file of ['workspace-pack.html', 'index.html', 'workspace-pack.js', 'workspace-navigation.js']) {
    const consumer = fs.readFileSync('public/local-first/' + file, 'utf8');
    assert.doesNotMatch(consumer, /class="service-note"|createIconButton\(|<symbol id="icon-(?:navigation|command)"/);
  }
  const html = fs.readFileSync('public/local-first/workspace-pack.html', 'utf8');
  assert.doesNotMatch(html, /<nav class="agentic-toolbar"|id="console-toggle"/);
  for (const entry of ['workspace-navigation.js', 'workspace-pack.js']) {
    const source = fs.readFileSync('public/local-first/' + entry, 'utf8');
    assert.match(source, /mountCommerceChrome.*from '\.\/commerce-toolbar\.js'/);
    assert.doesNotMatch(source, /['"]agentic-toolbar-item['"]|workspace-role-switcher/);
  }
});

test('Commerce leaves dashboard primitive and column styles to the pinned Design System', () => {
  for (const file of ['style.css','workspace-shell.css','workspace-pack.css','sme-business-pack.css','housing-comparison.css']) {
    const css = fs.readFileSync('public/local-first/' + file, 'utf8').replaceAll(':where(:not([data-dashboard-primitive]))', '');
    assert.doesNotMatch(css, /\[data-dashboard-(?:primitive|columns-for)\b/, file);
  }
});
