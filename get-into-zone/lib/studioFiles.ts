// The files of a YouTube Studio job from the popup, kept in the extension's
// IndexedDB: the popup closes once a Studio tab comes to the front, so it saves
// the files here and the service worker uploads them from here.

const DB_NAME = "browse-hack-studio"
const DB_STORE = "files"

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(database.transaction(DB_STORE, mode).objectStore(DB_STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    database.close()
  }
}

export const putJobFile = (key: string, file: File) => withStore("readwrite", (store) => store.put(file, key))
export const getJobFile = (key: string) => withStore<File | undefined>("readonly", (store) => store.get(key))

/** Drops every file of earlier jobs. */
export const clearJobFiles = () => withStore("readwrite", (store) => store.clear()).catch(() => undefined)
