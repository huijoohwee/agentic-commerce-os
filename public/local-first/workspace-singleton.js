const registryKey = Symbol.for('agentic-commerce-os.singleton-registry')
const registry = globalThis[registryKey] ?? Object.defineProperty(globalThis, registryKey, {
  configurable: false,
  enumerable: false,
  value: new Map(),
  writable: false,
})[registryKey]
const creating = Symbol.for('agentic-commerce-os.singleton-creating')
const failuresKey = Symbol.for('agentic-commerce-os.singleton-failures')
const failures = globalThis[failuresKey] ?? Object.defineProperty(globalThis, failuresKey, {
  configurable: false,
  enumerable: false,
  value: new WeakMap(),
  writable: false,
})[failuresKey]

function rememberFailure(name, error) {
  const entry = Object.freeze({})
  failures.set(entry, error)
  registry.set(name, entry)
}

export function getOrCreateSingleton(name, create) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9.-]{1,80}$/i.test(name)
    || typeof create !== 'function') throw Error('workspace_singleton_binding_invalid')
  if (!(registry instanceof Map) || !(failures instanceof WeakMap)) throw Error('workspace_singleton_registry_invalid')
  if (registry.has(name)) {
    const instance = registry.get(name)
    if (instance === creating) throw Error('workspace_singleton_reentrant_create')
    if (instance && typeof instance === 'object' && failures.has(instance)) throw failures.get(instance)
    return instance
  }
  registry.set(name, creating)
  let instance, thenable
  try {
    instance = create()
    thenable = instance && typeof instance.then === 'function'
  }
  catch (error) {
    if (registry.get(name) === creating) rememberFailure(name, error)
    throw error
  }
  if (thenable) {
    const pending = Promise.resolve(instance)
    registry.set(name, pending)
    // A failed initializer may already have attached listeners or mounted DOM.
    // Keep the rejection fenced until an explicit release or document reload.
    void pending.catch(() => {})
    return pending
  }
  registry.set(name, instance)
  return instance
}

export function releaseSingleton(name, instance) {
  const current = registry.get(name)
  if (current === instance || (current && typeof current === 'object' && failures.get(current) === instance)) {
    registry.delete(name)
  }
}
