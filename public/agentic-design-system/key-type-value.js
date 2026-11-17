/** Shared semantic structure; responsive geometry belongs to shared-ui-profile.css. */
export const KTV_CONTAINER_CLASS = 'agentic-ktv-container'
export const KTV_ROW_CLASS = 'agentic-ktv-row'
export const KTV_ROW_PARTS = Object.freeze([
  Object.freeze({ slot: 'key', tag: 'dt', className: 'agentic-ktv-key' }),
  Object.freeze({ slot: 'type', tag: 'dd', className: 'agentic-ktv-type' }),
  Object.freeze({ slot: 'value', tag: 'dd', className: 'agentic-ktv-value' }),
])

export function validateKeyTypeValueAlign(align) {
  if (!['center', 'start'].includes(align)) throw new TypeError('Invalid KTV row alignment')
  return align
}

/** Preserve control identity, labels, listeners and product-owned state. */
export function createKeyTypeValueRow({ keyNode, typeNode, valueNode, id, dataKgAnchor, align = 'center', ownerDocument = globalThis.document }) {
  validateKeyTypeValueAlign(align)
  if (!ownerDocument?.createElement) throw new TypeError('KTV row requires an owner document')
  const content = { key: keyNode, type: typeNode, value: valueNode }, nodes = new Set()
  for (const value of Object.values(content)) {
    if (typeof value === 'string' || typeof value === 'number') continue
    if (!value || ![1, 3, 11].includes(value.nodeType) || value.ownerDocument !== ownerDocument || nodes.has(value))
      throw new TypeError('KTV cells require distinct nodes from their owner document or text')
    nodes.add(value)
  }
  const container = ownerDocument.createElement('section'), row = ownerDocument.createElement('dl')
  container.className = KTV_CONTAINER_CLASS; row.className = KTV_ROW_CLASS
  row.dataset.panelFieldRow = 'true'; row.dataset.align = align
  if (id) row.id = id
  if (dataKgAnchor) row.dataset.kgAnchor = dataKgAnchor
  for (const part of KTV_ROW_PARTS) {
    const cell = ownerDocument.createElement(part.tag); cell.className = part.className
    cell.append(content[part.slot]); row.append(cell)
  }
  container.append(row)
  return container
}
