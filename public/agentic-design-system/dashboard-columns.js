// Presentation and edit contract. A host supplies authenticated load/save and native view targets.
export const allowedColumns = Object.freeze([1, 2, 3, 4]);
export const isColumnCount = value => allowedColumns.includes(value);
export const isLayoutKey = key => typeof key === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(key) && !['constructor','prototype'].includes(key);
export function isColumnLayout(value) {
  return !!value && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    !!value.columns && Object.getPrototypeOf(value.columns) === Object.prototype &&
    Object.keys(value.columns).length <= 32 && Object.entries(value.columns).every(([k, n]) => isLayoutKey(k) && isColumnCount(n));
}
const authoredColumns = new WeakMap();
export function applyDashboardColumns(root, layout) {
  if (!isColumnLayout(layout)) throw Error('Invalid dashboard layout');
  for (const element of root.querySelectorAll('[data-dashboard-columns-for]')) {
    const count = layout.columns[element.dataset.dashboardColumnsFor];
    if (!authoredColumns.has(element)) authoredColumns.set(element, element.dataset.columns);
    const columns = isColumnCount(count) ? String(count) : authoredColumns.get(element);
    if (columns === undefined) delete element.dataset.columns;
    else if (element.dataset.columns !== columns) element.dataset.columns = columns;
  }
}
export function dashboardEditorActions(...buttons) {
  const actions = document.createElement('div');
  actions.className = 'agentic-dashboard-actions';
  for (const button of buttons) button.classList.add('agentic-form-control');
  actions.append(...buttons);
  return actions;
}
// Mount only after the host verifies its editor. Persist before reflecting success.
export function createDashboardColumnEditor({ views, layout, save, onSaved, end }) {
  if (!isColumnLayout(layout)) throw Error('Invalid dashboard layout');
  const el = (tag, text) => Object.assign(document.createElement(tag), text ? {textContent: text} : {});
  const form = el('form'), view = el('select'), columns = el('select'), status = el('p');
  const select = (name, field, options) => {
    const label = el('label', name);
    for (const [id, title] of options) field.add(new Option(title, id));
    label.append(field); form.append(label);
  };
  select('Dashboard', view, views.map(item => [item.key, item.label]));
  select('Columns', columns, [['', 'Dashboard default'], ...allowedColumns.map(n => [String(n), String(n)])]);
  const current = () => {
    const value = String(layout.columns[view.value] ?? '');
    if (columns.value !== value) {
      columns.value = value;
      columns.dispatchEvent(new Event('change', {bubbles:true}));
    }
  };
  view.addEventListener('change', current); current();
  const submit = el('button', 'Save layout'), close = el('button', 'Exit edit mode');
  submit.type = 'submit'; close.type = 'button'; close.onclick = end;
  status.setAttribute('role', 'status'); form.append(dashboardEditorActions(submit, close), status);
  form.onsubmit = async event => {
    event.preventDefault(); if (submit.disabled) return;
    submit.disabled = view.disabled = columns.disabled = true;
    try {
      const next = await save({view: view.value, columns: columns.value === '' ? null : Number(columns.value), revision: layout.revision});
      if (!isColumnLayout(next)) throw Error('Invalid dashboard layout');
      layout = next; onSaved(next); current(); status.textContent = 'Layout saved.';
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = view.disabled = columns.disabled = false; }
  };
  return form;
}
