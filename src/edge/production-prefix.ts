export const PRODUCTION_STOREFRONT_PREFIX = '/agentic-commerce-os' as const

export type EdgeRouteProjection = Readonly<{
  basePath: '' | typeof PRODUCTION_STOREFRONT_PREFIX
  url: URL
}>

export function projectEdgeRoute(value: URL): EdgeRouteProjection {
  const url = new URL(value)
  if (url.pathname !== PRODUCTION_STOREFRONT_PREFIX
    && !url.pathname.startsWith(`${PRODUCTION_STOREFRONT_PREFIX}/`)) {
    return Object.freeze({ basePath: '', url })
  }
  const projected = url.pathname.slice(PRODUCTION_STOREFRONT_PREFIX.length)
  url.pathname = projected === '' ? '/' : projected
  return Object.freeze({ basePath: PRODUCTION_STOREFRONT_PREFIX, url })
}

export function prefixedPath(basePath: string, path: string): string {
  if (path === '/') return basePath ? `${basePath}/` : '/'
  return `${basePath}${path}`
}
