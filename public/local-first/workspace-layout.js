import {applyDashboardColumns, createDashboardColumnEditor, dashboardEditorActions, isColumnLayout} from './dashboard-columns.js'

export function mountWorkspaceLayout({panel, toolbar, create, roles, packPage}) {
  const views = [...Object.entries(roles).map(([key,{label}])=>({key,label})),
    {key:'builder',label:'Workspace'},{key:'formats',label:'Included files'}]
  const api = new URL('../../dashboard-layout',toolbar.dataset.packService)
  const cache = 'commerce.dashboard-layout.v1', box = create('section'), sources = new Set()
  let layout = {revision:0, columns:{}}, authoring=false, editToken='', turn=0, generation=0, reads=0
  const admin = () => !packPage && document.body.dataset.workspaceRole==='admin' && /^#admin(?:$|[-?])/.test(location.hash)
  panel.querySelector('.agentic-base-floating-panel-inner').append(box); box.hidden=true
  function apply() {
    for (const root of [document,document.getElementById('pack-view')?.shadowRoot].filter(Boolean)) {
      applyDashboardColumns(root,layout)
      if (sources.has(root)) continue
      sources.add(root)
      new MutationObserver(records=>{
        if (!Object.keys(layout.columns).length) return
        for (const r of records) for (const node of r.addedNodes) if(node.nodeType===1) {
          if(node.hasAttribute('data-dashboard-columns-for'))applyDashboardColumns(node.parentNode||root,layout)
          else applyDashboardColumns(node,layout)
        }
      }).observe(root,{subtree:true,childList:true})
    }
  }
  const accept = ({revision,columns}) => {
    layout={revision,columns}
    try {
      if (Object.keys(columns).length) localStorage.setItem(cache,JSON.stringify(layout))
      else localStorage.removeItem(cache)
    } catch {}
    apply()
  }
  try {const cached=JSON.parse(localStorage.getItem(cache));if(isColumnLayout(cached)) layout=cached}catch{}
  const end = () => {turn++;editToken='';box.replaceChildren();box.hidden=!(admin() && authoring);if(!box.hidden)box.append(start)}
  const start=create('button','Enter admin edit mode','agentic-toolbar-item');start.type='button'
  start.onclick=()=>{
    if (!admin() || !authoring) return
    const ticket=++turn, form=create('form'), label=create('label','Layout admin key'), input=create('input')
    input.type='password';input.autocomplete='off';input.required=true;input.maxLength=64;label.append(input)
    const connect=create('button','Unlock layout editing'), cancel=create('button','Cancel'), status=create('p')
    cancel.type='button';cancel.onclick=end;status.setAttribute('role','status');form.append(label,dashboardEditorActions(connect,cancel),status);box.replaceChildren(form);input.focus()
    form.onsubmit=async event=>{
      event.preventDefault();const token=input.value;input.value='';connect.disabled=true
      try {
        const snapshot=await request(new URL(api.href+'/session'),token)
        if(ticket!==turn || !admin())return
        editToken=token;accept(snapshot)
        const editor=createDashboardColumnEditor({views,layout:snapshot,end,save:async change=>{
          if(ticket!==turn || !admin() || !editToken)throw Error('Re-enter admin edit mode.')
          return request(api,editToken,change)
        },onSaved:next=>{generation++;accept(next)}})
        box.replaceChildren(editor);editor.querySelector('select').focus()
      }catch(error){if(ticket===turn)status.textContent=error.message}
      finally{connect.disabled=false}
    }
  }
  async function request(url,token,change) {
    const response=await fetch(url,{method:change?'PUT':'POST',credentials:'omit',cache:'no-store',redirect:'error',
      headers:{authorization:'Bearer '+token,...(change?{'content-type':'application/json'}:{})},body:change?JSON.stringify(change):undefined,signal:AbortSignal.timeout(4500)})
    if(!response.ok)throw Error(response.status===409?'Layout changed. Exit and reopen edit mode to reload.':response.status===403?'Layout admin key refused.':'Layout service unavailable.')
    const result=await response.json();if(!isColumnLayout(result))throw Error('Invalid layout response.');return result
  }
  async function refresh() {
    const ticket=++reads, version=generation
    apply()
    try{
      const r=await fetch(api,{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(4000)})
      if(!r.ok)throw Error();const next=await r.json();if(!isColumnLayout(next))throw Error()
      if(ticket!==reads||generation!==version)return
      authoring=next.authoring===true; accept(next)
    }catch{if(ticket!==reads||generation!==version)return;authoring=false}
    if ((!editToken && !box.querySelector('form')) || !authoring) end()
  }
  // Credentials stay in the open Admin panel only and never enter offline storage.
  panel.addEventListener('beforetoggle',event=>{if(event.newState==='closed')end();else void refresh()})
  addEventListener('hashchange',()=>{end();void refresh()});addEventListener('pagehide',end)
  addEventListener('online',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh()})
  queueMicrotask(refresh)
}
