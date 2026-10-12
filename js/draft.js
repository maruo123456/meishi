// 送れなかった撮影の下書き（IndexedDB）。使えない環境では何もしない。

const DB = 'meishi', STORE = 'drafts';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'shotId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const TIMEOUT_MS = 2000;  // 下書きの保存で待つのはここまで（送信を止めないため）

async function run(mode, fn) {
  const work = (async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);  // 容量不足などで中止されたとき
    });
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), TIMEOUT_MS));
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return undefined;
  }
}

export const saveDraft = (shot) => run('readwrite', (s) => s.put(shot));
export const deleteDraft = (shotId) => run('readwrite', (s) => s.delete(shotId));
export async function listDrafts() { return (await run('readonly', (s) => s.getAll())) || []; }
