const DB_NAME = 'stock-rebound-lab', VERSION = 1;
let db;
export let storageMode = 'IndexedDB';
export async function openStorage() {
  try {
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('data')) r.result.createObjectStore('data'); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  } catch { storageMode = 'localStorage'; }
}
export async function get(key) {
  try {
    if (!db) return JSON.parse(localStorage.getItem(DB_NAME + ':' + key) || 'null');
    return await new Promise((resolve,reject) => { const r = db.transaction('data').objectStore('data').get(key); r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => reject(r.error); });
  } catch { return null; }
}
export async function set(key, value) {
  if (!db) { localStorage.setItem(DB_NAME + ':' + key, JSON.stringify(value)); return; }
  return new Promise((resolve,reject) => { const tx = db.transaction('data','readwrite'); tx.objectStore('data').put(value,key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
export async function getAll() {
  if (!db) return Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith(DB_NAME + ':')).map(k => [k.slice(DB_NAME.length + 1), JSON.parse(localStorage.getItem(k))]));
  return new Promise((resolve,reject) => { const result = {}; const tx = db.transaction('data'); const r = tx.objectStore('data').openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { result[c.key] = c.value; c.continue(); } else resolve(result); }; r.onerror = () => reject(r.error); });
}
