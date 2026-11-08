// A view may commit once its authored CSS (including imports) is ready to paint.
export function prepareViewStylesheet(url, parent = document.head) {
  let ready
  return () => {
    if (ready) return ready
    ready = new Promise((resolve, reject) => {
      const link = document.createElement('link')
      const failed = () => {
        clearTimeout(timer); link.remove(); ready = undefined
        reject(Error('Workspace stylesheet could not load.'))
      }
      const timer = setTimeout(failed, 10000)
      link.rel = 'stylesheet'; link.href = url
      link.onload = () => { clearTimeout(timer); resolve() }
      link.onerror = failed
      parent.append(link)
    })
    return ready
  }
}
