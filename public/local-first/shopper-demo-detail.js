import { getOrCreateSingleton } from './workspace-singleton.js'

const OFFER_TYPES = Object.freeze({ digital: 'Digital download', product: 'Small-batch product', service: 'Local service' })
let detailInstance = 0

function element(tag, text, className) {
  const result = document.createElement(tag)
  if (text !== undefined) result.textContent = text
  if (className) result.className = className
  return result
}

function namespaceArtworkIds(root) {
  const nodes = [...(root.matches('[id]') ? [root] : []), ...root.querySelectorAll('[id]')]
  const namespace = `offer-detail-${++detailInstance}`
  const ids = new Map(nodes.map(node => [node.id, `${namespace}-${node.id}`]))
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      let value = attribute.value
      for (const [source, target] of ids) {
        value = value.replaceAll(`url(#${source})`, `url(#${target})`)
        if (attribute.name === 'href' || attribute.name === 'xlink:href') value = value.replaceAll(`#${source}`, `#${target}`)
      }
      if (value !== attribute.value) node.setAttribute(attribute.name, value)
    }
  }
  for (const node of nodes) node.id = ids.get(node.id)
}

function bind({ dialog, onError }) {
  const shelf = document.querySelector('#shop-demo-shelf')
  if (!(shelf instanceof HTMLElement) || !(dialog instanceof HTMLDialogElement) || typeof onError !== 'function') {
    throw Error('shopper_demo_detail_binding_invalid')
  }
  let opener = null
  const open = card => {
    const art = card.querySelector('.demo-product-art')?.cloneNode(true)
    const name = card.querySelector('h3')?.textContent.trim()
    const outcome = card.querySelector('.offer-outcome')?.textContent.trim()
    const type = OFFER_TYPES[card.dataset.demoType]
    if (!(art instanceof HTMLElement) || !name || !outcome || !type) throw Error('shopper_demo_detail_data_invalid')
    namespaceArtworkIds(art)
    art.classList.remove('demo-product-art')
    art.classList.add('detail-demo-art')
    const heading = element('h2', name)
    heading.id = 'detail-heading'
    heading.tabIndex = -1
    const action = element('a', 'Start a private offer →', 'button detail-demo-action')
    action.href = '#vendor-editor'
    const body = dialog.querySelector('#detail-content')
    if (!(body instanceof HTMLElement)) throw Error('shopper_demo_detail_content_missing')
    body.replaceChildren(
      art,
      element('small', `${type} · Example`),
      heading,
      element('p', 'An illustrative offer format for planning.' , 'muted'),
      element('p', outcome, 'detail-outcome'),
      element('p', 'Build your own version around a buyer, outcome, and cost estimate.', 'detail-audience muted'),
      element('p', 'Example only. No price, inventory, or customer activity is represented.', 'muted'),
      action,
    )
    dialog.classList.add('detail-split')
    opener = card
    dialog.showModal()
    heading.focus({ preventScroll: true })
  }
  const activate = event => {
    const isKeyboard = event.type === 'keydown'
    if (isKeyboard && !['Enter', ' '].includes(event.key)) return
    const target = event.target instanceof Element ? event.target.closest('[data-demo-detail]') : null
    if (!(target instanceof HTMLElement) || !shelf.contains(target)) return
    if (isKeyboard) event.preventDefault()
    try { open(target) } catch (error) { onError(error) }
  }
  const restoreFocus = () => {
    if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus({ preventScroll: true })
    opener = null
  }
  shelf.addEventListener('click', activate)
  shelf.addEventListener('keydown', activate)
  dialog.addEventListener('close', restoreFocus)
  return () => {
    shelf.removeEventListener('click', activate)
    shelf.removeEventListener('keydown', activate)
    dialog.removeEventListener('close', restoreFocus)
  }
}

export function bindDemoOfferDetails(options) {
  return getOrCreateSingleton('shopper-demo-details', () => bind(options))
}
