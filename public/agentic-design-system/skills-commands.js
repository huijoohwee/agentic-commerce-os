import { createDesignIcon } from './toolbar-icons.js';
import { PANEL_SECTION, createPanelSectionSummary, setPanelSectionExpanded } from './panel-section.js';
import { mountCollectionLayoutPicker } from './collection-layout.js';

export const skillsCommandsTab = Object.freeze({ key: 'skills-commands', label: 'Skills & Commands', icon: 'SquareTerminal' });
export const initialCatalogFilters = Object.freeze({ prefix: 'all', groupBy: 'subject', query: '', layout: 'list' });
const prefixes = [['slash', '/', 'Slash commands'], ['hash', '#', 'Hash semantics'], ['at', '@', 'At bindings']];
const facets = [['subject', 'S', 'Group by Subject'], ['verb', 'V', 'Group by Verb'], ['object', 'O', 'Group by Object']];

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** The host supplies catalog data and disclosure state. The header never invokes entries. */
export function mountSkillsCommandsHeader(host, onChange) {
  const doc = host.ownerDocument;
  let filters = initialCatalogFilters, toggleGroups;
  const header = element(doc, 'header', 'agentic-skills-header');
  const heading = element(doc, 'h2', 'agentic-panel-section-title', skillsCommandsTab.label);
  const subtitle = element(doc, 'span', 'agentic-skills-meta', '/ # @ invocation catalog');
  const actions = element(doc, 'div', 'agentic-panel-section-actions');
  function button(label, face, click) {
    const control = element(doc, 'button', '', face);
    control.type = 'button';
    control.title = label;
    control.setAttribute('aria-label', label);
    control.addEventListener('click', click);
    return control;
  }
  const buttons = [];
  function change(field, value) {
    filters = { ...filters, [field]: value };
    if (field === 'layout') picker.setLayout(value);
    for (const { node, key, field } of buttons) {
      node.setAttribute('aria-pressed', String(filters[field] === key || filters[field] === 'all'));
    }
    onChange(filters);
  }
  function group(label, field, choices) {
    const container = element(doc, 'div', 'agentic-toggle-group');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', label);
    for (const [key, face, name] of choices) {
      const node = button(name, face, () => change(field, field === 'prefix' && filters.prefix === key ? 'all' : key));
      node.setAttribute('aria-pressed', String(filters[field] === key || filters[field] === 'all'));
      buttons.push({ node, key, field });
      container.append(node);
    }
    return container;
  }
  const search = element(doc, 'input', 'agentic-form-control');
  search.type = 'search';
  search.placeholder = 'Search commands';
  search.setAttribute('aria-label', 'Search commands');
  search.hidden = true;
  function showSearch(open) {
    search.hidden = !open;
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) search.focus();
    else {
      if (search.value) { search.value = ''; change('query', ''); }
      searchToggle.focus();
    }
  }
  const searchToggle = button('Search skills and commands', '', () => showSearch(search.hidden));
  searchToggle.className = 'agentic-form-control';
  searchToggle.append(createDesignIcon('Search', doc));
  searchToggle.setAttribute('aria-expanded', 'false');
  search.addEventListener('input', () => change('query', search.value));
  search.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    showSearch(false);
  });
  const disclosure = button(PANEL_SECTION.collapseAll, PANEL_SECTION.collapseAll, () => toggleGroups?.());
  disclosure.className = 'agentic-form-control';
  disclosure.hidden = true;
  const pickerHost = element(doc, 'div');
  const picker = mountCollectionLayoutPicker(pickerHost, {
    layout: filters.layout, label: 'Skills & Commands layout', onChange: value => change('layout', value),
  });
  actions.append(group('Skills & Commands prefix', 'prefix', prefixes), group('Skills & Commands group by', 'groupBy', facets), pickerHost, searchToggle, disclosure);
  header.append(heading, subtitle, actions, search);
  host.replaceChildren(header);
  return {
    setDisclosure(hasGroups, collapsed, toggle) {
      toggleGroups = toggle;
      disclosure.hidden = !hasGroups;
      const label = collapsed ? PANEL_SECTION.expandAll : PANEL_SECTION.collapseAll;
      disclosure.textContent = disclosure.title = label;
      disclosure.setAttribute('aria-label', label);
    },
    destroy() { picker.destroy(); header.remove(); },
  };
}

/** Render a browsable catalog. Interactive hosts can bind their own typed rows below the shared header. */
export function mountSkillsCommandsReference(host, entries, sourceLabel) {
  const doc = host.ownerDocument;
  host.dataset.panelTab = skillsCommandsTab.key;
  host.dataset.panelLabel = skillsCommandsTab.label;
  host.dataset.panelIcon = skillsCommandsTab.icon;
  const surface = element(doc, 'section', 'agentic-skills-catalog');
  const head = element(doc, 'div'), body = element(doc, 'div', 'agentic-skills-body');
  const source = element(doc, 'p', 'agentic-skills-meta', sourceLabel);
  const list = element(doc, 'div', 'agentic-collection agentic-skills-groups');
  body.append(source, list);
  surface.append(head, body);
  host.replaceChildren(surface);
  const closed = new Set();
  const header = mountSkillsCommandsHeader(head, render);
  function render({ prefix, groupBy, query, layout }) {
    const groups = new Map();
    const symbol = prefixes.find(([key]) => key === prefix)?.[1];
    const needle = query.trim().toLowerCase();
    for (const entry of entries) {
      if (symbol && !entry.token.startsWith(symbol)) continue;
      if (![entry.token, entry.summary, entry[groupBy]].join(' ').toLowerCase().includes(needle)) continue;
      const group = entry[groupBy];
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    }
    const sections = [];
    function updateDisclosure() {
      const collapsed = sections.every(({ detail }) => !detail.open);
      header.setDisclosure(sections.length > 0, collapsed, () => {
        for (const { key, detail } of sections) {
          setPanelSectionExpanded(detail, collapsed);
          if (collapsed) closed.delete(key); else closed.add(key);
        }
        updateDisclosure();
      });
    }
    for (const [name, records] of groups) {
      const key = groupBy + ':' + name;
      const detail = element(doc, 'details', PANEL_SECTION.section + ' agentic-skills-group-section');
      detail.dataset.agenticSection = '';
      detail.open = !closed.has(key);
      const label = element(doc, 'span', 'agentic-skills-group-label', name + ' (' + records.length + ')');
      const summary = createPanelSectionSummary(doc, label);
      summary.dataset.agenticSticky = 'true';
      detail.append(summary);
      const rows = element(doc, 'div', 'agentic-collection');
      rows.dataset.layout = layout;
      for (const { token, summary } of records) {
        const row = element(doc, 'div', 'agentic-collection-item agentic-skills-row');
        row.dataset.layout = layout;
        const symbol = element(doc, 'span', layout === 'card' ? 'agentic-collection-preview' : 'agentic-collection-leading', token[0]);
        symbol.setAttribute('aria-hidden', 'true');
        const content = element(doc, 'div');
        content.append(element(doc, 'div', 'agentic-collection-title', token), element(doc, 'div', 'agentic-skills-meta', summary));
        row.append(symbol, content);
        rows.append(row);
      }
      detail.append(rows);
      detail.addEventListener('toggle', () => {
        if (!list.contains(detail)) return;
        if (detail.open) closed.delete(key); else closed.add(key);
        updateDisclosure();
      });
      sections.push({ key, detail });
    }
    list.replaceChildren(...sections.map(({ detail }) => detail));
    if (!sections.length) list.append(element(doc, 'p', '', 'No matching entries.'));
    updateDisclosure();
  }
  render(initialCatalogFilters);
  return { destroy() { header.destroy(); surface.remove(); } };
}
