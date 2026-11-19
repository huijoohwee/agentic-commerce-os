/** Activate the rendered element in place. Parsing, source writes and cancellation belong to the host. */
export function attachViewerSurface(root, options = {}) {
  if (!root || root.nodeType !== 1) throw new TypeError('A rendered Viewer element is required')
  const original = new Map(['contenteditable','role','aria-multiline','tabindex','data-agentic-viewer-surface','data-agentic-viewer-dirty'].map(name=>[name,root.getAttribute(name)]))
  const restore = name => { const value=original.get(name); if(value===null)root.removeAttribute(name);else root.setAttribute(name,value) }
  let active=false, dirty=false, disposed=false, baseline
  const read = () => options.readValue ? options.readValue(root) : root.textContent || ''
  const setEditing = (next, {focus=false} = {}) => {
    if(disposed) throw new Error('Viewer surface is disposed')
    next=Boolean(next && options.editable !== false)
    if(next===active)return
    const selection=root.ownerDocument.defaultView?.getSelection()
    const ranges=selection?Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index).cloneRange()).filter(range=>root.contains(range.commonAncestorContainer)):[]
    active=next;dirty=false;root.removeAttribute('data-agentic-viewer-dirty')
    root.setAttribute('data-agentic-viewer-surface',active?'edit':'view')
    if(active){
      baseline=read();root.setAttribute('contenteditable','true');root.setAttribute('role','textbox');root.setAttribute('aria-multiline','true')
      if(focus){root.focus({preventScroll:true});if(selection&&ranges.length){selection.removeAllRanges();ranges.forEach(range=>selection.addRange(range))}}
    }else{restore('contenteditable');restore('role');restore('aria-multiline')}
    options.onEditingChange?.(active)
  }
  const onInput=()=>{if(!active)return;dirty=true;root.setAttribute('data-agentic-viewer-dirty','true');options.onInput?.(read())}
  const commit=()=>{if(!active)return;const changed=dirty&&read()!==baseline;if(changed)options.onCommit?.(read());setEditing(false);return changed}
  const cancel=()=>{if(!active)return;options.onCancel?.({dirty,baseline});setEditing(false)}
  const click=event=>{
    if(options.activation==='manual'||active||event.defaultPrevented||event.detail>1)return
    if(event.target.closest?.('a,button,input,textarea,select,[contenteditable="false"]'))return
    setEditing(true,{focus:true})
  }
  const keydown=event=>{
    if(options.activation==='manual'||options.editable===false||event.defaultPrevented)return
    if(event.key==='Escape'&&active&&options.onCancel){event.preventDefault();cancel()}
    else if(!active&&event.key==='Enter'&&event.target===root){event.preventDefault();setEditing(true,{focus:true})}
  }
  const blur=event=>{if(options.activation!=='manual'&&!root.contains(event.relatedTarget))commit()}
  root.setAttribute('data-agentic-viewer-surface','view')
  if(options.editable!==false&&!root.hasAttribute('tabindex'))root.setAttribute('tabindex','0')
  root.addEventListener('input',onInput);root.addEventListener('click',click);root.addEventListener('keydown',keydown);root.addEventListener('focusout',blur)
  return {setEditing,commit,cancel,get editing(){return active},get dirty(){return dirty},destroy(){
    if(disposed)return;disposed=true
    root.removeEventListener('input',onInput);root.removeEventListener('click',click);root.removeEventListener('keydown',keydown);root.removeEventListener('focusout',blur)
    for(const name of original.keys())restore(name)
  }}
}

export function readViewerCaretRange(root, point) {
  const doc=root.ownerDocument, supported=typeof doc.caretPositionFromPoint==='function'||typeof doc.caretRangeFromPoint==='function'
  try{
    let range
    if(typeof doc.caretPositionFromPoint==='function'){
      const position=doc.caretPositionFromPoint(point.x,point.y)
      if(position){range=doc.createRange();range.setStart(position.offsetNode,position.offset);range.collapse(true)}
    }else range=doc.caretRangeFromPoint?.(point.x,point.y)
    return {range:range&&(range.startContainer===root||root.contains(range.startContainer))?range:null,supported}
  }catch{return {range:null,supported}}
}
export function applyViewerSelection(root, range, options={}) {
  const selection=root.ownerDocument.defaultView?.getSelection();if(!selection)return false
  if(options.focus!==false)root.focus({preventScroll:true})
  selection.removeAllRanges();selection.addRange(range);return true
}
