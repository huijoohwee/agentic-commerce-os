import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import worker from '../../src/local-first/worker.ts';
import { digest, verifySharedUiIconProfile } from '../../scripts/local-first-release/artifact.mjs';

test('Commerce consumes the pinned Design System panel profile and shell offline', async () => {
  const pin = verifySharedUiIconProfile();
  assert.equal(pin.owner, 'github.com/huijoohwee/agentic-design-system');
  const sourceRelease = JSON.parse(fs.readFileSync('config/design-system-static-release.json', 'utf8'));
  assert.equal(pin.sourceRevision, sourceRelease.profilePins.sharedUi.sourceRevision);
  assert.equal(pin.registryRevision, sourceRelease.profilePins.sharedUi.registryRevision);
  assert.equal(pin.profileSha256, sourceRelease.profilePins.sharedUi.sourceSha256.slice(7));
  assert.equal(pin.projectionSha256, sourceRelease.profilePins.sharedUi.projectionSha256.slice(7));
  assert.match(pin.registryRevision, /^[a-f0-9]{40}$/u);
  const profile = fs.readFileSync('public/local-first/shared-ui-profile.css', 'utf8');
  assert.equal(digest(profile), pin.projectionSha256);
  assert.match(profile, /stroke-width: var\(--agentic-icon-stroke-width\)/);
  assert.match(profile, /--agentic-font-size-body: 0\.875rem;/);
  assert.match(profile, /--agentic-line-height-body: 1\.25rem;/);
  assert.match(profile, /--agentic-panel-width:/u);
  assert.match(profile, /--agentic-panel-bottom-height:/u);
  assert.match(profile, /--agentic-control-hover-background: light-dark\(#fffbeb, rgb\(251 191 36 \/ 0\.16\)\);/u);
  const panelCss = fs.readFileSync('public/local-first/floating-panel.css', 'utf8');
  assert.match(panelCss, /\.agentic-panel-main\b/u);
  assert.match(panelCss, /\.agentic-panel-bottom\b/u);
  assert.match(panelCss, /\.agentic-base-floating-panel\s*\{/u);
  assert.match(panelCss, /background:\s*var\(--agentic-control-hover-background\)/u);
  assert.match(panelCss,
    /\.agentic-base-floating-panel\s+\.agentic-floating-panel-tab:not\(\[aria-selected="true"\]\):not\(:hover\):not\(:focus-visible\):has\(>\s*\.agentic-icon\)\s*>\s*span\s*\{\s*font-size:\s*0;\s*line-height:\s*0;/u,
    'only inactive, unhovered, unfocused FloatingPanel tabs collapse their labels');
  assert.match(panelCss,
    /\.agentic-base-floating-panel\s+\.agentic-floating-panel-tab\[aria-selected="true"\]\s*\{[^}]*color:\s*var\(--agentic-control-selected-foreground\)[^}]*background:\s*var\(--agentic-control-selected-background\)/u,
    'the selected icon-plus-label state comes from the pinned Design System stylesheet');
  assert.match(panelCss,
    /\.agentic-base-floating-panel\s+\.agentic-floating-panel-tab:hover\s*\{[^}]*background:\s*var\(--agentic-control-hover-background\)/u,
    'hovered icon-plus-label state comes from the pinned Design System stylesheet');
  const shellHtml = fs.readFileSync('public/local-first/index.html', 'utf8');
  assert.match(shellHtml, /assets\/__RELEASE__\/shared-ui-profile\.css/u);
  assert.match(shellHtml, /assets\/__RELEASE__\/floating-panel\.css/u);
  assert.ok(shellHtml.indexOf('style.css') < shellHtml.indexOf('shared-ui-profile.css'));
  assert.ok(shellHtml.indexOf('shared-ui-profile.css') < shellHtml.indexOf('floating-panel.css'));
  const floatingPanelPin = JSON.parse(fs.readFileSync('config/floating-panel.pin.json', 'utf8'));
  const designSystemRelease = JSON.parse(fs.readFileSync('config/design-system-static-release.json', 'utf8'));
  assert.equal(floatingPanelPin.revision, designSystemRelease.source.revision);
  assert.equal(floatingPanelPin.sha256, digest(panelCss));
  const toolbarPin = JSON.parse(fs.readFileSync('config/toolbar.pin.json', 'utf8'));
  assert.equal(toolbarPin.revision, designSystemRelease.source.revision);
  assert.equal(toolbarPin.sha256, digest(fs.readFileSync('public/local-first/toolbar.css')));
  assert.equal(toolbarPin.iconsSha256, digest(fs.readFileSync('public/local-first/toolbar-icons.js')));
  const commerceShell = fs.readFileSync('public/local-first/commerce-shell.css', 'utf8');
  const panelRules = [...commerceShell.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selector]) => /\.agentic-(?:base-floating-panel|panel-(?:main|bottom)|panel-control)/u.test(selector));
  assert.ok(panelRules.length, 'Commerce keeps its panel host layout scoped to the shared panel classes');
  assert.ok(panelRules.every(([, , declarations]) => !/(?:^|[;{])\s*(?:color|background(?:-[\w-]+)?|border(?:-[\w-]+)?|box-shadow|font(?:-[\w-]+)?)\s*:/u.test(declarations)),
    'Commerce must not define a competing Design System panel appearance');
  const commercePanelRule = commerceShell.match(/\.commerce-workspace-panel\s*\{([^}]*)\}/u)?.[1] ?? '';
  assert.ok(commercePanelRule, 'Commerce must scope its workspace offset to the shared panel root');
  assert.match(commercePanelRule, /--agentic-floating-panel-block-start-offset:/u,
    'Commerce may provide its app chrome offset through the Design System placement token');
  assert.doesNotMatch(commercePanelRule, /(?:inline-size|width|block-size|height|max-block-size|max-height)\s*:/u,
    'Design System owns Commerce panel dimensions');
  assert.doesNotMatch(commerceShell, /--agentic-floating-panel-available-height\s*:/u,
    'Commerce must not calculate a competing panel height');
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

test('Commerce field layouts consume the central KTV owner without competing grids', () => {
  const css = fs.readFileSync('public/local-first/sme-business-pack.css', 'utf8');
  const housing = fs.readFileSync('public/local-first/housing-comparison.css', 'utf8');
  for (const source of ['app.js', 'housing-comparison.js', 'sme-workflow-editor.js']) {
    const script = fs.readFileSync('public/local-first/' + source, 'utf8');
    assert.match(script, /import \{ createKeyTypeValueRow(?:, createKeyTypeValueRows)? \} from '\.\/key-type-value.js'/u);
    assert.doesNotMatch(script, /className\s*=\s*['"]agentic-ktv-row['"]/u);
  }
  assert.doesNotMatch(css, /\.(?:workflow-toolbar|workflow-control|workflow-parameter-grid|evidence-fields|decision-policy)\s*\{/u);
  assert.doesNotMatch(housing, /\.housing-(?:field-grid|listing-grid|option-action-list|option-action|actions|option-actions|listing-filter|table-toolbar)\s*\{\s*display:/u);
});

test('Commerce actions and Workspace Pack reuse shared responsive control geometry', () => {
  const style = fs.readFileSync('public/local-first/style.css', 'utf8');
  const primary = style.match(/button:not\(\.agentic-form-control\):where\(:not\(\.agentic-toggle-group > button, \.agentic-toolbar-item, \.agentic-color-palette button\)\),\.button\{([^}]*)\}/u)?.[1];
  assert.ok(primary, 'storefront actions must keep one owning rule');
  for (const declaration of [
    /block-size:\s*var\(--agentic-control-height\)/u,
    /min-block-size:\s*var\(--agentic-control-height\)/u,
    /padding-block:\s*0/u,
    /padding-inline:\s*var\(--agentic-control-padding-inline\)/u,
    /border-radius:\s*var\(--agentic-control-radius\)/u,
  ]) assert.match(primary, declaration);
  assert.doesNotMatch(primary, /44px|10px|11px\s+18px/u);
  const consoleOverride = style.match(/\.console-mode \.button,\.console-mode button:not\(\.agentic-form-control\):where\(:not\(\.agentic-toggle-group > button, \.agentic-toolbar-item, \.agentic-color-palette button\)\)\{([^}]*)\}/u)?.[1];
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

test('housing priorities use individual central KTV rows with no local layout override', () => {
  const housing = fs.readFileSync('public/local-first/housing-comparison.js', 'utf8');
  assert.match(housing, /<fieldset class="agentic-ktv-container"><legend>Priorities/);
  const localCss = fs.readFileSync('public/local-first/housing-comparison.css', 'utf8');
  assert.doesNotMatch(localCss, /[.]housing-choice-list|[.]agentic-checkbox-group/);
})

test('Housing uses shared panel sections and fixed KTV flow, isolated from legacy form styling', () => {
  const housing = fs.readFileSync('public/local-first/housing-comparison.js', 'utf8');
  const style = fs.readFileSync('public/local-first/style.css', 'utf8');
  const layout = fs.readFileSync('public/local-first/workspace-layout.js', 'utf8');
  assert.match(housing, /class="agentic-ktv-container" data-housing-inputs/);
  assert.match(housing, /agentic-panel-section housing-context/);
  assert.doesNotMatch(housing, /agentic-dashboard-card housing-|data-dashboard-columns-for="housing"/);
  assert.match(style, /label:not\(#sme label, \.agentic-ktv-row label\)\{/);
  assert.match(layout, /filter\(\(\[key\]\)=>key!==['"]housing['"]\)/);
});

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
  assert.deepEqual(owners, ['"./graph-ui-tokens.css"', '"./commerce-theme.css"', '"./shared-ui-profile.css"', '"./panel-section.css"', '"./commerce-shell.css"', '"./toolbar.css"']);
  assert.match(html, /id="builder" class="agentic-dashboard-layout"/);
  assert.match(html, /class="agentic-dashboard-region">\s*<div class="agentic-dashboard-grid" data-columns="2" data-dashboard-columns-for="builder">/);
  assert.match(html, /id="formats" class="agentic-dashboard-layout"/);
  assert.match(html, /class="format-grid" data-dashboard-primitive="container" data-columns="4"/);
  assert.doesNotMatch(css, /\.console-(?:panel|top)\b|#console-panel\s*\{/, 'do not recreate the shared FloatingPanel shell');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'local inline styles bypass the owner');
  assert.match(html, /<template id="console-template">/);
  assert.match(html, /<template id="agent-tools-template">/);
  assert.doesNotMatch(html, /agentic-base-floating-panel|agentic-floating-panel-tabs|id="console-panel"/,
    'Commerce mounts one tabbed shell through the shared toolbar owner');
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
  assert.match(owner, /import \{[^}]*createPanelControlButton[^}]*\} from '\.\/toolbar-icons\.js'/);
  assert.match(owner, /createPanelControlButton\('close'\)/);
  assert.doesNotMatch(owner, /aria-label.{0,40}close|title.{0,40}close/u);
  assert.match(owner, /PANEL_VIEWS[\s\S]*?Bot[\s\S]*?SquareTerminal[\s\S]*?HelpCircle/);
  assert.doesNotMatch(owner, /workspace-agent-open|console-toggle/);
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

test('Commerce panel close reuses the canonical semantic role and icon', () => {
  const icons = JSON.parse(fs.readFileSync('public/local-first/icons.json', 'utf8'));
  const source = fs.readFileSync('public/local-first/toolbar-icons.js', 'utf8');
  assert.equal(source, fs.readFileSync('public/agentic-design-system/toolbar-icons.js', 'utf8'));
  assert.equal(fs.readFileSync('public/local-first/icons.json', 'utf8'),
    fs.readFileSync('public/agentic-design-system/icons.json', 'utf8'));
  const owner = fs.readFileSync('public/local-first/commerce-toolbar.js', 'utf8');
  assert.deepEqual(Object.keys(icons.panelControls).sort(), ['apply', 'close', 'minimize', 'pin', 'reset', 'restore', 'search']);
  assert.equal(icons.panelControls.close.label, 'Close');
  assert.match(source, /export function applyPanelControl\(button, control\)/);
  assert.match(source, /definition\.label/);
  assert.match(source, /cannot override its canonical/);
  assert.match(source, /cannot replace its existing semantic role/);
  assert.match(owner, /createPanelControlButton\('close'\)/);
  assert.match(fs.readFileSync('public/local-first/floating-panel.css', 'utf8'), /\.agentic-base-floating-panel-close/);
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
  const profileDigest = digest(profile);
  assert.equal(pin.source.revision, '887d2cfa7f1dc3b76fa0a33694f76336e7aacbcf');
  assert.equal(pin.inputs.find(input => input.path === 'packages/views-react/src/browser/shared-ui-profile.css')?.sha256,
    profileDigest);
  assert.match(profile, /--agentic-control-border:\s*1px solid var\(--agentic-base-border,/u);
  assert.match(css, /--agentic-control-border:\s*1px solid var\(--agentic-base-border,/u);
  assert.match(css, /\.agentic-form-control,[\s\S]+?border:\s*var\(--agentic-control-border\)/u);
});

test('native hover panel, palette and key/value text are exact shared projections', () => {
  const manifest = JSON.parse(fs.readFileSync('config/design-system-static-release.json', 'utf8'));
  for (const name of ['hover.js', 'hover-text.js', 'hover.css']) {
    const entry = manifest.files.find(file => file.path === name);
    assert.ok(entry, name + ' must be an owner projection');
    assert.equal(digest(fs.readFileSync('public/local-first/' + name)), entry.sha256);
  }
  const editor = fs.readFileSync('public/local-first/sme-workflow-editor.js', 'utf8');
  assert.ok(editor.includes("from './hover-text.js'"));
  assert.ok(editor.includes("defaultValueOverride: 'Not declared'"));
});


test('native section assets reuse immutable owner bytes and both workspace routes', async () => {
  const release = JSON.parse(fs.readFileSync('config/design-system-static-release.json', 'utf8'));
  assert.match(fs.readFileSync('public/local-first/workspace.js', 'utf8'), /installPanelSections\(document\)/);
  for (const name of ['panel-section.js', 'panel-section.css']) {
    const bytes = fs.readFileSync('public/local-first/' + name);
    assert.deepEqual(bytes, fs.readFileSync('public/agentic-design-system/' + name));
    assert.equal(digest(bytes), release.files.find(file => file.path === name).sha256);
    assert(fs.readFileSync('public/local-first/sw.js', 'utf8').includes(name));
    for (const prefix of ['', 'services/workspace-pack/']) {
      const response = await worker.fetch(new Request('https://commerce.test/agentic-commerce-os/assets/local-unreleased/' + prefix + name),
        { RELEASE_CANDIDATE_SHA: 'local-unreleased', ASSETS: { fetch: () => new Response(bytes) } });
      assert.equal(response.status, 200, prefix + name);
    }
  }
  assert.match(fs.readFileSync('public/local-first/housing-comparison.js', 'utf8'), /data-housing-section="context"/);
  assert.doesNotMatch(fs.readFileSync('public/local-first/housing-comparison.css', 'utf8'), />summary\{/);
  assert.doesNotMatch(fs.readFileSync('public/local-first/sme-business-pack.css', 'utf8'), /decision-panel summary/);
});
