import { createDesignIcon } from './toolbar-icons.js';

export const collectionLayouts = Object.freeze([
  Object.freeze({ layout: 'list', label: 'List layout', icon: 'List' }),
  Object.freeze({ layout: 'card', label: 'Card layout', icon: 'Rows3' }),
  Object.freeze({ layout: 'grid', label: 'Grid layout', icon: 'LayoutGrid' }),
]);

/** Keep the host's layout state and callbacks independent of the shared controls. */
export function mountCollectionLayoutPicker(host, { layout, label, labelPrefix = '', onChange }) {
  const doc = host.ownerDocument;
  const controls = doc.createElement('div');
  controls.className = 'agentic-toggle-group';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', label);
  const choices = new Map();
  for (const choice of collectionLayouts) {
    const button = doc.createElement('button');
    const name = labelPrefix ? `${labelPrefix} ${choice.label.toLowerCase()}` : choice.label;
    button.type = 'button';
    button.title = name;
    button.setAttribute('aria-label', name);
    button.dataset.agenticLayoutChoice = choice.layout;
    button.append(createDesignIcon(choice.icon, doc));
    button.addEventListener('click', () => onChange(choice.layout));
    controls.append(button);
    choices.set(choice.layout, button);
  }

  function setLayout(value) {
    if (!choices.has(value)) throw new RangeError('Unknown collection layout: ' + value);
    for (const [key, button] of choices) button.setAttribute('aria-pressed', String(key === value));
  }
  setLayout(layout);
  host.replaceChildren(controls);
  return { setLayout, destroy: () => controls.remove() };
}
