// Apps Script との通信

export class ApiError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export const settings = {
  get url() { return read('meishi.url'); },
  get token() { return read('meishi.token'); },
  save(url, token) { write('meishi.url', url); write('meishi.token', token); },
};

export function read(key, fallback = '') {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
export function write(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* 保存できない環境では覚えない */ }
}

// 試験用ページでは window.__meishiTransport に差し替える
async function fetchTransport(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  return res.json();
}

export async function call(action, params = {}, conn = settings) {
  const transport = window.__meishiTransport || fetchTransport;
  let data;
  try {
    data = await transport(conn.url, { action, token: conn.token, ...params });
  } catch (e) {
    throw new ApiError('network', '通信できませんでした');
  }
  if (!data || !data.ok) throw new ApiError((data && data.error) || 'server_error', data && data.message);
  return data.data;
}
