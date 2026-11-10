import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import worker from '../../src/local-first/worker.ts';
import { digest, verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System icon size from its offline shell assets', async () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  assert.equal(pin.sourceRevision, '267cdb31047b02d4f54ea6708fb2518a8a2a57f4');
  assert.equal(pin.registryRevision, 'bae7a65bf6fb667c3f7386732d4fa2cceb5033a3');
  const profile = fs.readFileSync('public/local-first/shared-ui-profile.css', 'utf8');
  assert.equal(profile, fs.readFileSync('public/agentic-design-system/vendor/shared-ui-profile.css', 'utf8'));
  assert.match(profile, /stroke-width: var\(--agentic-icon-stroke-width\)/);
  assert.match(profile, /--agentic-font-size-body: 0\.875rem;/);
  assert.match(profile, /--agentic-line-height-body: 1\.25rem;/);
  assert.match(profile, /--agentic-floating-panel-radius:\s*8px;/u);
  assert.equal(fs.readFileSync('public/local-first/floating-panel.css', 'utf8'),
    fs.readFileSync('public/agentic-design-system/floating-panel.css', 'utf8'));
  const floatingPanelPin = JSON.parse(fs.readFileSync('config/floating-panel.pin.json', 'utf8'));
  assert.equal(floatingPanelPin.revision, pin.registryRevision);
  assert.equal(floatingPanelPin.sha256, digest(fs.readFileSync('public/agentic-design-system/floating-panel.css')));
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

test('Commerce actions and Workspace Pack reuse shared responsive control geometry', () => {
  const style = fs.readFileSync('public/local-first/style.css', 'utf8');
  const primary = style.match(/button:not\(\.agentic-form-control\):where\(:not\(\.agentic-toggle-group > button, \.agentic-toolbar-item\)\),\.button\{([^}]*)\}/u)?.[1];
  assert.ok(primary, 'storefront actions must keep one owning rule');
  for (const declaration of [
    /block-size:\s*var\(--agentic-control-height\)/u,
    /min-block-size:\s*var\(--agentic-control-height\)/u,
    /padding-block:\s*0/u,
    /padding-inline:\s*var\(--agentic-control-padding-inline\)/u,
    /border-radius:\s*var\(--agentic-control-radius\)/u,
  ]) assert.match(primary, declaration);
  assert.doesNotMatch(primary, /44px|10px|11px\s+18px/u);
  const consoleOverride = style.match(/\.console-mode \.button,\.console-mode button:not\(\.agentic-form-control\):where\(:not\(\.agentic-toggle-group > button, \.agentic-toolbar-item\)\)\{([^}]*)\}/u)?.[1];
  assert.ok(consoleOverride, 'console typography must remain owned');
  assert.doesNotMatch(consoleOverride, /(?:block-size|height|padding|gap|border-radius)\s*:/u);

  const theme = fs.readFileSync('public/local-first/commerce-theme.css', 'utf8');
  assert.match(theme, /--commerce-touch-target:\s*44px/u);
  const pack = fs.readFileSync('public/local-first/workspace-pack.css', 'utf8');
  for (const [label, pattern] of [
    ['pack actions', /\.button,button\[type=submit\],#cancel,#confirm-request,#edit-request\s*\{([^}]*)\}/u],
    ['review action', /\.console-request button\s*\{([^}]*)\}/u],
    ['simulation action', /\.simulation-run\s*\{([^}]*)\}/u],
    ['format action', /\.format-open\s*\{([^}]*)\}/u],
  ]) {
    const rule = pack.match(pattern)?.[1];
    assert.ok(rule, `${label} must keep one owning rule`);
    assert.match(rule, /block-size:\s*var\(--agentic-control-height\)/u);
    assert.match(rule, /min-block-size:\s*var\(--agentic-control-height\)/u);
    assert.match(rule, /(?:padding-block:\s*0|padding:\s*0)/u);
  }
  const pill = pack.match(/\.pill\s*\{([^}]*)\}/u)?.[1];
  assert.ok(pill, 'status pills must keep one owning rule');
  assert.match(pill, /min-block-size:\s*var\(--agentic-control-height\)/u);
  assert.match(pill, /padding-block:\s*0/u);
  assert.match(pack, /button:where\(:not\(\[aria-pressed\], nav button\)\),\.button,summary\s*\{\s*min-block-size:\s*var\(--agentic-control-height\)/u);
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

test('all Commerce form borders come from the pinned shared control token', () => {
  const style = fs.readFileSync('public/local-first/style.css', 'utf8');
  const profile = fs.readFileSync('public/local-first/shared-ui-profile.css', 'utf8');
  assert.match(profile, /--agentic-control-border:\s*1px solid var\(--agentic-base-border,[^;]+\);/u);
  assert.match(profile, /\.agentic-form-control,[\s\S]+?\.agentic-select-trigger\s*\{[^}]*border:\s*var\(--agentic-control-border\)/u);
  const controlRules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selector]) => /\b(?:input|textarea|select)\b|\.agentic-select-trigger/u.test(selector))
    .filter(([, selector]) => !/\.file-input\b/u.test(selector));
  for (const [, selector, declarations] of controlRules) {
    assert.doesNotMatch(declarations, /\bborder(?:-color)?\s*:/u, `${selector.trim()} must inherit its border from the shared utility`);
  }
});

test('Base browser controls reuse the central shared border utility', () => {
  const pin = JSON.parse(fs.readFileSync('config/agentic-base-data-view.json', 'utf8'));
  const profile = fs.readFileSync('public/agentic-design-system/vendor/shared-ui-profile.css', 'utf8');
  const css = fs.readFileSync('public/local-first/agentic-base-data-view.css', 'utf8');
  assert.equal(pin.source.revision, 'f966ce7f9551bd0afb3ea56b25bff029c4359efb');
  assert.equal(pin.inputs.find(input => input.path === 'packages/views-react/src/browser/shared-ui-profile.css')?.sha256,
    'e9fce49e9dce6cde8afa4cde9dc0e8d77ee8642cc10d4d38f66d35d3f53361b0');
  assert.match(profile, /--agentic-control-border:\s*1px solid var\(--agentic-base-border,/u);
  assert.match(css, /--agentic-control-border:\s*1px solid var\(--agentic-base-border,/u);
  assert.match(css, /\.agentic-form-control,[\s\S]+?border:\s*var\(--agentic-control-border\)/u);
});
