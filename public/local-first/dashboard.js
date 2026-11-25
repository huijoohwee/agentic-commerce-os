/*
MIT License

Copyright (c) 2026 huijoohwee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Extracted from Agentic Base's Mission dashboard. Copyright (c) 2026 huijoohwee, MIT.
const classes = (...values) => values.filter(Boolean).join(' ');

/** The Mission shell and card tree are identical for React and native DOM hosts. */
export function createDashboardRenderer(element) {
  function DashboardCanvasLayout({
    ariaLabel = 'Dashboard content', beforeHeader, title, description, hero, observation,
    overview, insights, metrics, sections, children, metricsAttributes, sectionsAttributes,
    className, ...attributes
  }) {
    const region = (content, className, attributes) => content
      ? element('section', { className, ...attributes }, content) : null;
    return element('section', {
      className: classes('agentic-dashboard-layout agentic-base-dashboard-layout', className),
      'aria-label': ariaLabel, 'data-agentic-base-dashboard-layout': 'true', ...attributes,
    },
    beforeHeader,
    element('header', { className: 'agentic-dashboard-header agentic-base-dashboard-layout-header' },
      element('section', { className: 'agentic-base-dashboard-layout-heading' }, title,
        description ? element('div', { className: 'agentic-base-dashboard-layout-description' }, description) : null),
      region(hero, 'agentic-dashboard-hero agentic-base-dashboard-layout-hero', { 'aria-label': 'Dashboard highlight' })),
    observation ? element('p', { className: 'agentic-dashboard-observation agentic-base-dashboard-layout-observation' }, observation) : null,
    region(overview, 'agentic-base-dashboard-layout-overview'), insights,
    region(metrics, 'agentic-base-dashboard-layout-metrics', { 'aria-label': 'Dashboard metrics', ...metricsAttributes }),
    region(sections, 'agentic-dashboard-sections agentic-base-dashboard-layout-sections', sectionsAttributes),
    children);
  }

  function DashboardCardGrid({
    ariaLabel, cards, columns = 3, headingLevel = 3, className, cardClassName,
    eyebrowClassName, titleClassName, descriptionClassName, accentClassNameByRole = {},
  }) {
    const part = (tag, className, content) => content == null ? null : element(tag, { className }, content);
    return element('section', { className: 'agentic-dashboard-region' },
      element('ol', { 'aria-label': ariaLabel, 'data-columns': columns, 'data-layout': 'grid', className: classes('agentic-collection', className) },
        ...cards.map(card => element('li', {
          key: card.id, 'data-accent': card.accent, 'data-layout': 'grid',
          className: classes('agentic-collection-item agentic-dashboard-card', accentClassNameByRole[card.accent || 'neutral'], cardClassName),
        },
        part('p', classes('agentic-dashboard-eyebrow', eyebrowClassName), card.eyebrow),
        element('h' + headingLevel, { className: classes('font-semibold', titleClassName) }, card.title),
        part('p', classes('agentic-dashboard-description', descriptionClassName), card.description),
        part('div', 'agentic-dashboard-detail', card.content),
        part('div', 'agentic-dashboard-actions', card.actions)))));
  }

  function DashboardPrimitive({ kind, level = 2, columns, children }) {
    const attr = { 'data-dashboard-primitive': kind };
    switch (kind) {
      case 'heading': return element('h' + level, attr, children);
      case 'text': return element('p', attr, children);
      case 'divider': return element('hr', attr);
      case 'container': return element('div', { className: 'agentic-dashboard-region' },
        element('div', { ...attr, 'data-columns': columns }, children));
      default: throw new TypeError('Unknown dashboard primitive: ' + kind);
    }
  }

  return { DashboardCanvasLayout, DashboardCardGrid, DashboardPrimitive };
}

/** Hosts pass text and existing nodes as slots. Text is never parsed as HTML. */
export function createNativeDashboard(document) {
  return createDashboardRenderer((tag, attributes, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name !== 'key' && value != null) node.setAttribute(name === 'className' ? 'class' : name, String(value));
    }
    for (const child of children) {
      if (child != null && typeof child !== 'boolean') node.append(child);
    }
    return node;
  });
}
