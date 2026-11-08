// The local-first shell only transports layout requests. Design System verifies writes and owns the revision.
export type LayoutBinding = { fetch(request: Request): Promise<Response> }
export async function dashboardLayout(request: Request, release: string, binding?: LayoutBinding): Promise<Response> {
  const url = new URL(request.url), session = url.pathname.endsWith('/session')
  const fail = (status: number, error: string) => Response.json({error}, {status})
  if (request.headers.has('origin') && request.headers.get('origin') !== url.origin) return fail(403,'origin_refused')
  if (session ? request.method !== 'POST' : !['GET','PUT'].includes(request.method)) return fail(405,'method_refused')
  const write = request.method !== 'GET', headers = new Headers()
  if (write) {
    const auth = request.headers.get('authorization') || ''
    if (!/^Bearer [a-f0-9]{64}$/.test(auth)) return fail(403,'admin_required')
    headers.set('authorization',auth)
    if (!session && request.headers.get('content-type') !== 'application/json') return fail(415,'json_required')
  }
  const dev = release === 'local-unreleased' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)
  if (!dev && !binding) return write ? fail(403,'authoring_disabled') : Response.json({revision:0,columns:{},authoring:false})
  const path = '/dashboard-layout'+(session ? '/session' : '')
  try {
    if (request.method === 'PUT') headers.set('content-type','application/json')
    const target = new Request((binding ? 'https://design-layout.internal' : 'http://127.0.0.1:4173')+path, {
      method:request.method, headers, body:request.method==='PUT'?request.body:null,
      redirect:'manual', signal:AbortSignal.timeout(2500),
    })
    const response = await (binding ? binding.fetch(target) : fetch(target))
    if (response.status >= 300 && response.status < 400 || !response.headers.get('content-type')?.startsWith('application/json')) return fail(503,'layout_unavailable')
    return new Response(response.body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}})
  } catch { return fail(503,'layout_unavailable') }
}
