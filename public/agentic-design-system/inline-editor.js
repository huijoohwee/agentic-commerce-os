// One native single-line draft field. The host owns the value and the commit decision.
export function mountInlineEditor(host, { value, label, describedBy, onInput, onCommit, onCancel }) {
  if (!label || typeof onInput !== 'function' || typeof onCommit !== 'function' || typeof onCancel !== 'function') {
    throw new TypeError('Inline editing requires a label and input, commit and cancel handlers');
  }
  if (host.hasAttribute('data-agentic-inline-editing')) throw new Error('This host already has an inline editor');
  const field = host.ownerDocument.createElement('input');
  field.type = 'text';
  field.className = 'agentic-inline-editor';
  field.value = value;
  field.autocomplete = 'off';
  field.autocapitalize = 'off';
  field.spellcheck = false;
  field.enterKeyHint = 'done';
  field.setAttribute('aria-label', label);
  if (describedBy) field.setAttribute('aria-describedby', describedBy);

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let composing = false;
  field.addEventListener('compositionstart', () => { composing = true; }, options);
  field.addEventListener('compositionend', () => { composing = false; }, options);
  field.addEventListener('input', () => onInput(field.value), options);
  field.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229 || field.readOnly) return;
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') onCommit();
    else onCancel();
  }, options);
  host.setAttribute('data-agentic-inline-editing', '');
  host.append(field);
  return {
    input: field,
    destroy() {
      if (listeners.signal.aborted) return;
      listeners.abort();
      field.remove();
      host.removeAttribute('data-agentic-inline-editing');
    },
  };
}
