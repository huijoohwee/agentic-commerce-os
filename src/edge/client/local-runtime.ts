export const LOCAL_DATABASE_RUNTIME = String.raw`
const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('agentic-commerce-storefront', 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('completed-sync')) {
      database.createObjectStore('completed-sync', { keyPath: 'scope' });
    }
    if (!database.objectStoreNames.contains('pending-changes')) {
      database.createObjectStore('pending-changes', { keyPath: 'sequence', autoIncrement: true });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
});

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error('indexeddb_transaction_failed'));
  transaction.onabort = () => reject(transaction.error || new Error('indexeddb_transaction_aborted'));
});

`
