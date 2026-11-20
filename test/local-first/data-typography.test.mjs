import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const local = 'public/local-first/';
const registry = 'public/agentic-design-system/';
const read = file => readFileSync(file, 'utf8');
const release = JSON.parse(read('config/design-system-static-release.json'));
const hash = css => createHash('sha256').update(css).digest('hex');
const guide = 'agentic-commerce-os/storage-management/';

test('Commerce serves the same offline typography in the shell, edge dashboard and storage guide', () => {
  const typography = read(registry + 'vendor/typography.css');
  assert.match(typography, /:where\(dt\), \.agentic-fact-label/u);
  assert.equal(hash(typography), release.files.find(file => file.path === 'vendor/typography.css').sha256);
  assert.equal(read(local + 'shared-ui-profile.css').split(typography).length, 2);
  assert.equal(JSON.parse(read('src/generated/design-typography.json')), typography);
  assert.equal(read(local + guide + 'style.css').split('/* Storage guide layout */')[0], typography);
  for (const name of ['index.html', 'workspace-pack.html', guide + 'index.html']) {
    assert.match(read(local + name), /<body\b[^>]*\bdata-agentic-typography\b/u, name);
  }
  const edge = read('src/edge/dashboard.ts');
  assert.match(edge, /design-typography\.json/u);
  assert.match(edge, /<body\b[^>]*\bdata-agentic-typography\b/u);
  assert.match(read(local + 'commerce-theme.css'), /--commerce-font-family:\s*var\(--agentic-font-sans, sans-serif\)/u);
});

test('authored styles inherit the owner font stacks and structured data roles', () => {
  const generated = new Set(release.files.map(file => file.path.replace(/^vendor\//u, '')));
  // These self-contained upstream bundles each have an exact release digest.
  for (const name of ['agentic-base-data-view.css', 'graph-data-view.css', 'graph-ui-tokens.css', 'graph-gantt-timeline.css']) generated.add(name);
  const styles = readdirSync(local).filter(name => name.endsWith('.css') && !generated.has(name))
    .map(name => [name, read(local + name)]);
  styles.push(['storage guide', read(local + guide + 'style.css').split('/* Storage guide layout */')[1]],
    ['edge', read('src/edge/experience-styles.ts')], ['timeline host', read('scripts/sme-review/graph-gantt-host.css')]);
  for (const [name, css] of styles) {
    assert.doesNotMatch(css, /--agentic-(?:font|line-height)-[\w-]+\s*:|\.agentic-(?:mono(?:-detail)?|text-detail|fact-label)\b\s*[{,]/u, name);
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      for (const [, value] of body.matchAll(/(?:^|;)\s*font(?:-family)?\s*:\s*([^;}]+)/gu)) {
        assert.ok(value.trim() === 'inherit' || /var\(--agentic-font-(?:mono|sans)\)\s*$/u.test(value), name + ': ' + value);
      }
      if (selector.split(',').some(part => /(?:^|[\s>+~])(?:code|dt|dd|kbd|pre|samp|time)\s*$/u.test(part))) {
        assert.doesNotMatch(body, /(?:^|;)\s*(?:font(?:-[\w-]+)?|line-height)\s*:/u, name + ': ' + selector);
      }
    }
  }
});
