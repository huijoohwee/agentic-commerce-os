import { createDesignIcon, updatePanelControlGroup } from './toolbar-icons.js';

/** Mount the native shell around product-owned tab contents. Build its chrome on first open. */
export function mountFloatingPanel(trigger, root, {
  label, tablistLabel = label, activeKey, placement = 'viewport-overlay', returnFocus = () => trigger.focus(), onChange,
}) {
  const doc = root.ownerDocument;
  const pages = [...root.children];
  const keys = pages.map(page => page.dataset.panelTab);
  if (!root.id || !label || !tablistLabel || !pages.length || new Set(keys).size !== pages.length
      || pages.some(page => !/^[a-z][a-z0-9-]*$/.test(page.dataset.panelTab ?? '') || !page.dataset.panelLabel)
      || !['flow', 'dock', 'viewport-overlay'].includes(placement)) throw new TypeError('Invalid FloatingPanel binding');
  let selected = activeKey ?? keys[0];
  if (!keys.includes(selected)) throw new RangeError('Unknown initial FloatingPanel tab');
  const element = (tag, className) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };
  const tabs = new Map();
  function select(key, focus = false) {
    if (!keys.includes(key)) throw new RangeError('Unknown FloatingPanel tab');
    const changed = selected !== key;
    selected = key;
    if (!tabs.size) return;
    for (const [index, page] of pages.entries()) {
      const active = keys[index] === key;
      const tab = tabs.get(keys[index]);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      page.hidden = !active;
    }
    const tab = tabs.get(key);
    if (focus) tab.focus({ preventScroll: true });
    const rail = tab.parentElement;
    const box = tab.getBoundingClientRect(), clip = rail.getBoundingClientRect();
    rail.scrollLeft += Math.min(0, box.left - clip.left) + Math.max(0, box.right - clip.right);
    if (changed && !root.hidden) onChange?.({ open: true, key });
  }
  function build() {
    const dialog = element('aside', 'agentic-base-floating-panel agentic-form-controls');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('aria-label', label);
    const inner = element('section', 'agentic-base-floating-panel-inner agentic-base-floating-panel-expanded');
    const header = element('header', 'agentic-panel-header agentic-base-floating-panel-header');
    const rail = element('nav', 'agentic-floating-panel-tabs');
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-label', tablistLabel);
    rail.setAttribute('aria-orientation', 'horizontal');
    const controls = element('section', 'agentic-panel-control-group');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Panel controls');
    updatePanelControlGroup(controls, { actions: { close } });
    for (const [i, page] of pages.entries()) {
      const key = keys[i], name = page.dataset.panelLabel;
      page.id ||= root.id + '-' + key;
      const tab = element('button', 'agentic-floating-panel-tab');
      tab.type = 'button';
      tab.id = page.id + '-tab';
      tab.dataset.agenticFloatingPanelTabKey = key;
      tab.title = name;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-label', name);
      tab.setAttribute('aria-controls', page.id);
      if (page.dataset.panelIcon) tab.append(createDesignIcon(page.dataset.panelIcon, doc));
      const caption = doc.createElement('span');
      caption.textContent = name;
      tab.append(caption);
      page.classList.add('agentic-floating-panel-body');
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', tab.id);
      page.tabIndex = 0;
      tabs.set(key, tab);
      rail.append(tab);
      tab.addEventListener('click', () => select(key, true));
    }
    rail.addEventListener('keydown', event => {
      const index = keys.indexOf(event.target.closest('[role="tab"]')?.dataset.agenticFloatingPanelTabKey);
      if (index < 0) return;
      const next = { Home: 0, End: keys.length - 1, ArrowRight: (index + 1) % keys.length,
        ArrowLeft: (index + keys.length - 1) % keys.length }[event.key];
      if (typeof next !== 'number') return;
      event.preventDefault();
      select(keys[next], true);
    });
    header.append(rail, controls);
    inner.append(header, ...pages);
    dialog.append(inner);
    root.replaceChildren(dialog);
  }
  function open(key = activeKey ?? selected, { focus = true } = {}) {
    if (!keys.includes(key)) throw new RangeError('Unknown FloatingPanel tab');
    if (!tabs.size) build();
    const wasHidden = root.hidden;
    root.hidden = false;
    // A newly opened panel emits just the open transition, even when it targets a different tab.
    if (wasHidden) selected = key;
    select(key, focus);
    trigger.setAttribute('aria-expanded', 'true');
    if (wasHidden) onChange?.({ open: true, key });
  }
  function close(restoreFocus = true) {
    if (root.hidden) return;
    root.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    onChange?.({ open: false, key: selected });
    if (restoreFocus) returnFocus();
  }
  function escape(event) {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || root.hidden || event.composedPath().some(node => node.matches?.('dialog[open]'))) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  root.hidden = true;
  root.classList.add('agentic-base-floating-panel-root');
  root.dataset.agenticFloatingPanelPlacement = placement;
  trigger.setAttribute('aria-controls', root.id);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.addEventListener('click', () => root.hidden ? open() : close());
  root.addEventListener('keydown', escape);
  trigger.addEventListener('keydown', escape);
  return { open, close, select, get activeKey() { return selected; }, get isOpen() { return !root.hidden; } };
}
