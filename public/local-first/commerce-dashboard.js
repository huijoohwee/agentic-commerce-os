import { createNativeDashboard } from './dashboard.js'

// Move the authored controls before the workspace binds them, including views mounted in a shadow root.
export function mountCommerceDashboards(root) {
  const document = root.ownerDocument ?? root
  const { DashboardCanvasLayout } = createNativeDashboard(document)
  for (const page of root.querySelectorAll('[data-commerce-dashboard]')) {
    const header = page.querySelector(':scope > header')
    const heading = header?.querySelector('h1, h2')
    if (!heading) throw Error('Commerce dashboard requires a heading')
    const group = heading.parentElement
    const title = document.createDocumentFragment(), actions = document.createDocumentFragment()
    const description = group.querySelector(':scope > [data-dashboard-primitive="text"]:last-child')
    description?.remove()
    title.append(...group.childNodes)
    if (group !== header) {
      group.remove()
      actions.append(...header.children)
    }
    const pageAttributes = Object.fromEntries([...page.attributes]
      .filter(attr => !['class', 'data-commerce-dashboard'].includes(attr.name))
      .map(attr => [attr.name, attr.value]))
    header.remove()
    const content = document.createDocumentFragment()
    content.append(...page.childNodes)
    const layout = DashboardCanvasLayout({ ...pageAttributes, className: page.className, ariaLabel: heading.textContent.trim(),
      title, description, hero: actions.childElementCount ? actions : undefined, children: content })
    const sharedHeader = layout.querySelector(':scope > header')
    for (const { name, value } of header.attributes) {
      if (name === 'class') sharedHeader.classList.add(...header.classList)
      else sharedHeader.setAttribute(name, value)
    }
    page.replaceWith(layout)
  }
}
