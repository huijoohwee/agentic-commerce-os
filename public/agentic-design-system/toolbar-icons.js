import iconLibrary from './icons.json' with { type: 'json' }

/** Props shared by React and native, icon-only toolbar and floating buttons. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const SHARED_ICON_TAGS = new Set(['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect'])
const PANEL_CONTROL_GROUP_CLASS = 'agentic-panel-control-group'
const PANEL_CONTROL_GROUP_LABEL = 'Panel controls'
const panelControlActions = new WeakMap()
const panelControlButtons = new WeakMap()
const panelControlGroups = new WeakMap()

/** Render one icon from the central Design System registry. */
export function createDesignIcon(name, ownerDocument = globalThis.document) {
  const nodes = iconLibrary.icons[name]
  if (!Array.isArray(nodes)) throw new RangeError(`Unknown shared icon: ${name}`)
  if (!ownerDocument?.createElementNS) throw new TypeError('An owner document is required to create an icon')

  const icon = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg')
  for (const [attribute, value] of Object.entries({
    viewBox: iconLibrary.viewBox,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'agentic-icon',
    'aria-hidden': 'true',
    focusable: 'false',
  })) icon.setAttribute(attribute, value)

  for (const [tag, attributes] of nodes) {
    if (!SHARED_ICON_TAGS.has(tag)) throw new TypeError(`Unsupported shared icon node: ${tag}`)
    const node = ownerDocument.createElementNS(SVG_NAMESPACE, tag)
    for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, String(value))
    icon.append(node)
  }
  return icon
}

/** Resolve a panel action through its centrally owned semantic icon role. */
export function createPanelControlIcon(control, ownerDocument = globalThis.document) {
  const definition = iconLibrary.panelControls?.[control]
  if (!definition || typeof definition.icon !== 'string') throw new RangeError(`Unknown shared panel control: ${control}`)
  return createDesignIcon(definition.icon, ownerDocument)
}

/** Return the canonical accessible name for a semantic panel control role. */
export function getPanelControlLabel(control) {
  const label = iconLibrary.panelControls?.[control]?.label
  if (typeof label !== 'string') throw new RangeError(`Unknown shared panel control: ${control}`)
  return label
}

/** Apply one canonical icon, accessible name and title to an existing panel button. */
export function applyPanelControl(button, control) {
  const definition = iconLibrary.panelControls?.[control]
  if (!definition || typeof definition.icon !== 'string' || typeof definition.label !== 'string') {
    throw new RangeError(`Unknown shared panel control: ${control}`)
  }
  if (!button || button.localName !== 'button' || !button.ownerDocument?.createElementNS) {
    throw new TypeError('A panel control must be a button in an owner document')
  }
  const existingControl = button.dataset.agenticPanelControl
  if (existingControl && existingControl !== control) {
    throw new TypeError(`Panel control cannot replace its existing semantic role: ${existingControl}`)
  }
  for (const attribute of ['aria-label', 'title']) {
    const existing = button.getAttribute(attribute)
    if (button.hasAttribute(attribute) && existing !== '' && existing !== definition.label) {
      throw new TypeError(`Panel control ${control} cannot override its canonical ${attribute}`)
    }
  }
  if (button.hasAttribute('aria-labelledby') || (control !== 'pin' && button.hasAttribute('aria-pressed'))) {
    throw new TypeError(`Panel control ${control} cannot override its canonical accessible state`)
  }
  const allowedClasses = new Set(control === 'close'
    ? ['agentic-toolbar-item', 'agentic-base-floating-panel-close']
    : ['agentic-toolbar-item'])
  if ([...button.classList].some(className => !allowedClasses.has(className)) || button.hasAttribute('style')) {
    throw new TypeError(`Panel control ${control} cannot apply consumer visual overrides`)
  }
  button.type = 'button'
  button.dataset.agenticPanelControl = control
  button.setAttribute('aria-label', definition.label)
  button.title = definition.label
  button.classList.add('agentic-toolbar-item')
  button.dataset.iconOnly = ''
  if (control === 'close') button.classList.add('agentic-base-floating-panel-close')
  button.replaceChildren(createPanelControlIcon(control, button.ownerDocument))
  return button
}

/** Render one icon-only button from the semantic panel-control registry. */
export function createPanelControlButton(control, ownerDocument = globalThis.document) {
  if (!ownerDocument?.createElement) throw new TypeError('An owner document is required to create a panel control')
  return applyPanelControl(ownerDocument.createElement('button'), control)
}

function runPanelControlAction(event) {
  event.preventDefault()
  event.stopPropagation()
  const button = event.currentTarget
  if (button.disabled) return
  panelControlActions.get(button)?.()
}

function bindPanelControlButton(button) {
  if (panelControlButtons.has(button)) return
  for (const name of ['pointerdown', 'pointerup']) button.addEventListener(name, event => event.stopPropagation())
  button.addEventListener('click', runPanelControlAction)
  panelControlButtons.set(button, true)
}

/** Update the canonical DOM button while binding only the app-owned callback and state. */
export function updatePanelControlButton(button, control, { action, disabled = false, pressed = false } = {}) {
  applyPanelControl(button, control)
  bindPanelControlButton(button)
  panelControlActions.set(button, typeof action === 'function' ? action : undefined)
  button.disabled = disabled === true || typeof action !== 'function'
  if (control === 'pin') button.setAttribute('aria-pressed', String(pressed === true))
  return button
}

/** Resolve control order and minimized visibility from the central semantic registry. */
export function resolvePanelControlRoles({ actions = {}, minimized = false } = {}) {
  const definitions = iconLibrary.panelControls
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw new TypeError('The Design System panel-control registry is unavailable')
  }
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new TypeError('Panel-control actions must be an object')
  }
  if (typeof minimized !== 'boolean') throw new TypeError('Panel minimized state must be boolean')
  const roles = Object.keys(definitions)
  for (const [control, action] of Object.entries(actions)) {
    if (!Object.hasOwn(definitions, control)) throw new RangeError(`Unknown shared panel control: ${control}`)
    if (action !== undefined && typeof action !== 'function') throw new TypeError(`Panel control ${control} action must be a function`)
  }
  return roles.filter(control => {
    if (typeof actions[control] !== 'function') return false
    if (control === 'minimize') return !minimized && typeof actions.minimize === 'function'
    if (control === 'restore') return minimized && typeof actions.restore === 'function'
    if (minimized && ['search', 'apply', 'reset'].includes(control)) return false
    return true
  })
}

/** Render and update one Design System-owned control group without consumer variants. */
export function updatePanelControlGroup(group, { actions = {}, disabled = {}, minimized = false, pinned = false } = {}) {
  if (!group || group.localName !== 'section') throw new TypeError('A panel-control group must be a section')
  if (group.getAttribute('role') !== 'group' || group.getAttribute('aria-label') !== PANEL_CONTROL_GROUP_LABEL
    || group.className !== PANEL_CONTROL_GROUP_CLASS || group.hasAttribute('style')) {
    throw new TypeError('A panel-control group cannot override its shared role, label, class, or visuals')
  }
  if (!disabled || typeof disabled !== 'object' || Array.isArray(disabled)) {
    throw new TypeError('Panel-control disabled state must be an object')
  }
  if (typeof pinned !== 'boolean') throw new TypeError('Panel pin state must be boolean')
  const definitions = iconLibrary.panelControls
  for (const [control, value] of Object.entries(disabled)) {
    if (!Object.hasOwn(definitions, control)) throw new RangeError(`Unknown shared panel control: ${control}`)
    if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Panel control ${control} disabled state must be boolean`)
  }
  const cache = panelControlGroups.get(group) ?? new Map()
  panelControlGroups.set(group, cache)
  const roles = resolvePanelControlRoles({ actions, minimized })
  const buttons = roles.map(control => {
    let button = cache.get(control)
    if (!button) {
      button = createPanelControlButton(control, group.ownerDocument)
      cache.set(control, button)
    }
    updatePanelControlButton(button, control, {
      action: actions[control], disabled: disabled[control] === true, pressed: control === 'pin' && pinned,
    })
    return button
  })
  const current = [...group.children]
  const currentRoles = current.map(child => child.dataset?.agenticPanelControl)
  if (current.some((child, index) => child.localName !== 'button'
    || !Object.hasOwn(definitions, currentRoles[index])
    || cache.get(currentRoles[index]) !== child)
    || new Set(currentRoles).size !== currentRoles.length) {
    throw new TypeError('A panel-control group cannot contain consumer controls')
  }
  if (current.length !== buttons.length || current.some((button, index) => button !== buttons[index])) {
    group.replaceChildren(...buttons)
  }
  return group
}

/** Hydrate role-marked buttons from the one panel-control registry. */
export function hydratePanelControls(root = globalThis.document) {
  if (!root?.querySelectorAll) throw new TypeError('A panel control hydration root is required')
  const buttons = [...root.querySelectorAll('[data-agentic-panel-control]')]
  for (const button of buttons) applyPanelControl(button, button.dataset.agenticPanelControl)
  return buttons.length
}

/** Hydrate declarative icon placeholders without copying SVG paths into consumers. */
export function hydrateDesignIcons(root = globalThis.document) {
  if (!root?.querySelectorAll) throw new TypeError('An icon hydration root is required')
  const placeholders = [...root.querySelectorAll('[data-agentic-design-icon]')]
  for (const placeholder of placeholders) {
    const icon = createDesignIcon(placeholder.getAttribute('data-agentic-design-icon'), placeholder.ownerDocument)
    const className = placeholder.getAttribute('class')
    if (className) icon.setAttribute('class', className)
    placeholder.replaceWith(icon)
  }
  return placeholders.length
}

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
  glyph.setAttribute('role', 'img');
  glyph.setAttribute('aria-label', `${label} icon`);
  glyph.setAttribute('focusable', 'false');
  glyph.setAttribute('stroke', 'currentColor');
  glyph.setAttribute('fill', 'none');
  button.append(glyph);
  return button;
}
