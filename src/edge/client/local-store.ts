export const MAXIMUM_PENDING_CHANGES = 500
const DATABASE_NAME = 'agentic-commerce-storefront'
const DATABASE_VERSION = 1
const CHANGE_STORE = 'pending-changes'
const SNAPSHOT_STORE = 'completed-sync'

export type PendingChange = Readonly<{
  sequence: number
  scope: string
  payload: unknown
  recordedAtMs: number
}>

export type LastSyncSnapshot = Readonly<{
  scope: string
  value: unknown
  completedAtMs: number
}> | null

export type RecordOutcome =
  | Readonly<{ ok: true; sequence: number }>
  | Readonly<{ ok: false; code: 'local_change_capacity_reached'; retained: number }>

export type ReplayOutcome = Readonly<{
  submittedSequences: readonly number[]
  acknowledgedSequences: readonly number[]
  retainedSequences: readonly number[]
}>

export type SubmitFn = (change: PendingChange) => Promise<boolean>

export type LocalStore = Readonly<{
  recordChange(change: Omit<PendingChange, 'sequence'>): Promise<RecordOutcome>
  replayOnReconnect(submit: SubmitFn): Promise<ReplayOutcome>
  renderableSnapshot(scope?: string): Promise<LastSyncSnapshot>
  recordCompletedSync(snapshot: Exclude<LastSyncSnapshot, null>): Promise<void>
}>

type LocalStoreBackend = Readonly<{
  listChanges(): Promise<readonly PendingChange[]>
  appendChangeWithinLimit(
    change: Omit<PendingChange, 'sequence'>,
    maximum: number,
  ): Promise<RecordOutcome>
  deleteChanges(sequences: readonly number[]): Promise<void>
  readSnapshot(scope: string): Promise<LastSyncSnapshot>
  writeSnapshot(snapshot: Exclude<LastSyncSnapshot, null>): Promise<void>
}>

let defaultStore: LocalStore | null = null

export function createLocalStore(backend: LocalStoreBackend): LocalStore {
  return Object.freeze({
    async recordChange(change): Promise<RecordOutcome> {
      return backend.appendChangeWithinLimit(Object.freeze({
        scope: change.scope,
        payload: change.payload,
        recordedAtMs: change.recordedAtMs,
      }), MAXIMUM_PENDING_CHANGES)
    },

    async replayOnReconnect(submit): Promise<ReplayOutcome> {
      const retained = [...await backend.listChanges()].sort((left, right) => left.sequence - right.sequence)
      const submittedSequences: number[] = []
      const acknowledgedSequences: number[] = []
      for (const change of retained) {
        submittedSequences.push(change.sequence)
        let acknowledged = false
        try {
          acknowledged = await submit(change)
        } catch {
          acknowledged = false
        }
        if (!acknowledged) break
        acknowledgedSequences.push(change.sequence)
        await backend.deleteChanges([change.sequence])
      }
      const remaining = [...await backend.listChanges()]
        .sort((left, right) => left.sequence - right.sequence)
        .map((change) => change.sequence)
      return Object.freeze({
        submittedSequences: Object.freeze(submittedSequences),
        acknowledgedSequences: Object.freeze(acknowledgedSequences),
        retainedSequences: Object.freeze(remaining),
      })
    },

    renderableSnapshot(scope = 'storefront'): Promise<LastSyncSnapshot> {
      return backend.readSnapshot(scope)
    },

    recordCompletedSync(snapshot): Promise<void> {
      return backend.writeSnapshot(Object.freeze(snapshot))
    },
  })
}

export function createMemoryLocalStore(): LocalStore {
  let sequence = 0
  const changes: PendingChange[] = []
  const snapshots = new Map<string, Exclude<LastSyncSnapshot, null>>()
  return createLocalStore({
    async listChanges() {
      return Object.freeze(changes.map((change) => Object.freeze({ ...change })))
    },
    async appendChangeWithinLimit(change, maximum) {
      if (changes.length >= maximum) {
        return Object.freeze({ ok: false, code: 'local_change_capacity_reached', retained: changes.length })
      }
      sequence += 1
      changes.push(Object.freeze({ ...change, sequence }))
      return Object.freeze({ ok: true, sequence })
    },
    async deleteChanges(sequences) {
      const removed = new Set(sequences)
      for (let index = changes.length - 1; index >= 0; index -= 1) {
        if (removed.has(changes[index]?.sequence ?? -1)) changes.splice(index, 1)
      }
    },
    async readSnapshot(scope) {
      return snapshots.get(scope) ?? null
    },
    async writeSnapshot(snapshot) {
      snapshots.set(snapshot.scope, Object.freeze({ ...snapshot }))
    },
  })
}

export function recordChange(change: Omit<PendingChange, 'sequence'>): Promise<RecordOutcome> {
  return getDefaultStore().recordChange(change)
}

export function replayOnReconnect(submit: SubmitFn): Promise<ReplayOutcome> {
  return getDefaultStore().replayOnReconnect(submit)
}

export function renderableSnapshot(scope = 'storefront'): Promise<LastSyncSnapshot> {
  return getDefaultStore().renderableSnapshot(scope)
}

export function recordCompletedSync(snapshot: Exclude<LastSyncSnapshot, null>): Promise<void> {
  return getDefaultStore().recordCompletedSync(snapshot)
}

export function settlementBlockedOffline(): Readonly<{ ok: false; code: 'connectivity_absent' }> {
  return Object.freeze({ ok: false, code: 'connectivity_absent' })
}

function getDefaultStore(): LocalStore {
  if (defaultStore) return defaultStore
  defaultStore = typeof indexedDB === 'undefined'
    ? createMemoryLocalStore()
    : createLocalStore(createIndexedDbBackend())
  return defaultStore
}

function createIndexedDbBackend(): LocalStoreBackend {
  const database = openDatabase()
  return Object.freeze({
    async listChanges() {
      const db = await database
      const transaction = db.transaction(CHANGE_STORE, 'readonly')
      const rows = await requestResult<PendingChange[]>(transaction.objectStore(CHANGE_STORE).getAll())
      await transactionDone(transaction)
      return Object.freeze(rows
        .sort((left, right) => left.sequence - right.sequence)
        .map((row) => Object.freeze({ ...row })))
    },
    async appendChangeWithinLimit(change, maximum) {
      const db = await database
      const transaction = db.transaction(CHANGE_STORE, 'readwrite')
      const store = transaction.objectStore(CHANGE_STORE)
      const retained = await requestResult<number>(store.count())
      if (retained >= maximum) {
        await transactionDone(transaction)
        return Object.freeze({ ok: false, code: 'local_change_capacity_reached', retained })
      }
      const sequence = await requestResult<IDBValidKey>(store.add(change))
      await transactionDone(transaction)
      if (typeof sequence !== 'number') throw new Error('local_change_sequence_invalid')
      return Object.freeze({ ok: true, sequence })
    },
    async deleteChanges(sequences) {
      const db = await database
      const transaction = db.transaction(CHANGE_STORE, 'readwrite')
      const store = transaction.objectStore(CHANGE_STORE)
      for (const sequence of sequences) store.delete(sequence)
      await transactionDone(transaction)
    },
    async readSnapshot(scope) {
      const db = await database
      const transaction = db.transaction(SNAPSHOT_STORE, 'readonly')
      const value = await requestResult<Exclude<LastSyncSnapshot, null> | undefined>(
        transaction.objectStore(SNAPSHOT_STORE).get(scope),
      )
      await transactionDone(transaction)
      return value ? Object.freeze(value) : null
    },
    async writeSnapshot(snapshot) {
      const db = await database
      const transaction = db.transaction(SNAPSHOT_STORE, 'readwrite')
      transaction.objectStore(SNAPSHOT_STORE).put(snapshot)
      await transactionDone(transaction)
    },
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(CHANGE_STORE)) {
        database.createObjectStore(CHANGE_STORE, { keyPath: 'sequence', autoIncrement: true })
      }
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'scope' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb_request_failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb_transaction_failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb_transaction_aborted'))
  })
}
