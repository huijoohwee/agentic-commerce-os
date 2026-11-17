
export function normalizeHexColor(value) {
  const hex = String(value || '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex
  if (/^#[0-9a-f]{3}$/.test(hex)) return '#' + [...hex.slice(1)].map(part => part + part).join('')
  return null
}

export const colorChannel = (value, max = 255) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0))
export const rgbToHex = (rgb) => '#' + rgb.map(value => Math.round(colorChannel(value)).toString(16).padStart(2, '0')).join('')
export const hexToRgb = (hex) => [1, 3, 5].map(offset => parseInt((normalizeHexColor(hex) || '#000000').slice(offset, offset + 2), 16))

export function hexToHsv(hex) {
  const [r, g, b] = hexToRgb(hex).map(value => value / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  const hue = delta === 0 ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { h: (hue * 60 + 360) % 360, s: max === 0 ? 0 : delta / max * 100, v: max * 100 }
}

export function hsvToHex({ h, s, v }) {
  const hue = ((h % 360) + 360) % 360 / 60, saturation = colorChannel(s, 100) / 100, value = colorChannel(v, 100) / 100
  const c = value * saturation, x = c * (1 - Math.abs(hue % 2 - 1)), m = value - c
  const rgb = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x]
  return rgbToHex(rgb.map(channel => (channel + m) * 255))
}

/** Resolve host CSS palette tokens without changing the stored source value. */
export function resolvePaletteColor(value) {
  let current = String(value || '').trim()
  for (let depth = 0; depth < 4; depth++) {
    const normalized = normalizeHexColor(current)
    if (normalized) return normalized
    const variable = /^var\((--[\w-]+)\)$/.exec(current)
    if (!variable || typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null
    current = getComputedStyle(document.documentElement).getPropertyValue(variable[1]).trim()
  }
  return null
}

export const DEFAULT_COLOR_SWATCHES = Object.freeze(['#000000', '#ffffff', '#808080', '#60a5fa', '#f59e0b', '#22c55e', '#f97316', '#ef4444', '#9ca3af'])
/** Accessible native palette. Frameworks mount this same implementation. */
export function createColorPalette(root, { value, onValueChange, swatches = DEFAULT_COLOR_SWATCHES }) {
  const doc = root?.ownerDocument
  if (!doc?.createElement || typeof onValueChange !== 'function' || !Array.isArray(swatches) || swatches.length > 64) throw new TypeError('Invalid palette contract')
  let color = normalizeHexColor(value)
  if (!color) throw new TypeError('A valid hex colour is required')
  let hsv = hexToHsv(color), destroyed = false
  const nodes = [], inputs = [], buttons = []
  const make = (tag, attrs = {}, text) => {
    const el = doc.createElement(tag)
    for (const [key, item] of Object.entries(attrs)) el.setAttribute(key, String(item))
    if (text !== undefined) el.textContent = text
    return el
  }
  const add = el => { nodes.push(el); root.append(el); return el }
  const spectrum = add(make('button', { type: 'button', class: 'agentic-color-spectrum', 'aria-label': 'Saturation and brightness', 'aria-description': 'Arrow left or right adjusts saturation; arrow up or down adjusts brightness. Hold Shift for larger steps.' }))
  const marker = make('span', { class: 'agentic-color-spectrum-marker', 'aria-hidden': 'true' }); spectrum.append(marker)
  const hueLabel = add(make('label', { class: 'agentic-color-channel' }, 'Hue'))
  const hue = make('input', { type: 'range', class: 'agentic-color-hue', min: 0, max: 359, step: 1, 'aria-label': 'Hue' }); hueLabel.append(hue)
  const palette = add(make('fieldset')); palette.append(make('legend', {}, 'Palette'))
  const menu = make('menu', { class: 'agentic-color-swatches' }); palette.append(menu)
  const refresh = () => {
    spectrum.style.backgroundColor = hsvToHex({ h: hsv.h, s: 100, v: 100 })
    marker.style.left = `${hsv.s}%`; marker.style.top = `${100 - hsv.v}%`; marker.style.backgroundColor = color
    spectrum.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s)}%, brightness ${Math.round(hsv.v)}%`)
    hue.value = String(Math.round(hsv.h)); hex.value = color; hex.removeAttribute('aria-invalid'); alert.hidden = true
    const rgb = hexToRgb(color); inputs.forEach((input, index) => { input.value = String(rgb[index]) })
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.value === color)))
    output.value = color
  }
  const commit = (next, keepHsv = false) => {
    if (destroyed) return
    const normalized = normalizeHexColor(next)
    if (!normalized) throw new TypeError('A valid hex colour is required')
    color = normalized; if (!keepHsv) hsv = hexToHsv(color); refresh(); onValueChange(color)
  }
  const updateHsv = next => { hsv = next; commit(hsvToHex(next), true) }
  for (const swatch of [...new Set(swatches.map(resolvePaletteColor).filter(Boolean))]) {
    const li = make('li'), button = make('button', { type: 'button', class: 'agentic-color-swatch', 'aria-label': `Choose ${swatch}`, title: swatch, value: swatch })
    button.style.backgroundColor = swatch; button.onclick = () => commit(swatch)
    buttons.push(button); li.append(button); menu.append(li)
  }
  const rgbFields = add(make('fieldset', { class: 'agentic-color-rgb' })); rgbFields.append(make('legend', {}, 'RGB'))
  for (const [index, name] of ['Red', 'Green', 'Blue'].entries()) {
    const label = make('label', {}, name), input = make('input', { type: 'number', class: 'agentic-form-control', min: 0, max: 255, step: 1, 'aria-label': name })
    input.oninput = () => { if (!input.value.trim()) return; const rgb = hexToRgb(color); rgb[index] = colorChannel(Number(input.value)); commit(rgbToHex(rgb)) }
    inputs.push(input); label.append(input); rgbFields.append(label)
  }
  const hexLabel = add(make('label', { class: 'agentic-color-channel' }, 'Hex'))
  const hex = make('input', { class: 'agentic-form-control', 'aria-label': 'Hex colour', maxlength: 7, spellcheck: false }); hexLabel.append(hex)
  const alert = add(make('p', { role: 'alert', hidden: '' }, 'Enter a hex colour, such as #336699.'))
  const output = add(make('output', { 'aria-live': 'polite' }))
  const commitHex = () => { const normalized = normalizeHexColor(hex.value); if (normalized) commit(normalized); else { hex.setAttribute('aria-invalid', 'true'); alert.hidden = false } }
  hex.oninput = () => { hex.removeAttribute('aria-invalid'); alert.hidden = true; if (/^#[0-9a-f]{6}$/i.test(hex.value)) commit(hex.value) }
  hex.onblur = commitHex; hex.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); commitHex() } }
  hue.oninput = () => updateHsv({ ...hsv, h: Number(hue.value) })
  const fromPointer = event => {
    const bounds = spectrum.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    updateHsv({ ...hsv, s: colorChannel((event.clientX - bounds.left) / bounds.width * 100, 100), v: colorChannel((1 - (event.clientY - bounds.top) / bounds.height) * 100, 100) })
  }
  spectrum.onpointerdown = event => { spectrum.setPointerCapture(event.pointerId); fromPointer(event) }
  spectrum.onpointermove = event => { if (spectrum.hasPointerCapture(event.pointerId)) fromPointer(event) }
  spectrum.onpointerup = event => { if (spectrum.hasPointerCapture(event.pointerId)) spectrum.releasePointerCapture(event.pointerId) }
  spectrum.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); const step = event.shiftKey ? 10 : 1
    updateHsv({ ...hsv, s: colorChannel(hsv.s + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), 100), v: colorChannel(hsv.v + (event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0), 100) })
  }
  refresh()
  return { update(next) { if (destroyed) throw new Error('Palette is destroyed'); color = normalizeHexColor(next); if (!color) throw new TypeError('Invalid palette colour'); hsv = hexToHsv(color); refresh() }, destroy() { destroyed = true; nodes.forEach(node => node.remove()) } }
}
