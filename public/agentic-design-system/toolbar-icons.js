/** Props shared by React and native, icon-only toolbar and floating buttons. */
export function getIconButtonProps(label) {
  return {
    type: 'button',
    className: 'agentic-toolbar-item',
    'data-icon-only': '',
    'aria-label': label,
  };
}

export function getIconSizeClass(scale = 'default') {
  return scale === 'compact' ? 'agentic-icon agentic-icon-compact' : 'agentic-icon';
}

export function createIconButton(label, glyph) {
  const button = glyph.ownerDocument.createElement('button');
  const { className, ...attributes } = getIconButtonProps(label);
  button.className = className;
  for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
  glyph.setAttribute('class', getIconSizeClass());
  glyph.setAttribute('aria-hidden', 'true');
  glyph.setAttribute('focusable', 'false');
  glyph.setAttribute('stroke', 'currentColor');
  glyph.setAttribute('fill', 'none');
  button.append(glyph);
  return button;
}
