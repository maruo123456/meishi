// 名刺の検索・並べ替え・場所の表示文（純粋関数）

const SEARCH_KEYS = ['company', 'name', 'department', 'title', 'memo', 'storageMemo'];
const COMPANY_FORMS = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|\(株\)|\(有\)|㈱|㈲/g;

export function normalize(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export function filterCards(cards, query) {
  const words = String(query || '').normalize('NFKC').split(/\s+/).map(normalize).filter(Boolean);
  if (words.length === 0) return cards.slice();
  return cards.filter((c) => {
    const text = SEARCH_KEYS.map((k) => normalize(c[k])).join('\n');
    return words.every((w) => text.includes(w));
  });
}

// 「上から2段目の右」→ [2, 3]（左=1・中央=2・右=3、「左から4列目」=4）
function positionKey(pos) {
  const m = /上から(\d+)段目(?:の(?:(左|中央|右)|左から(\d+)列目))?/.exec(pos || '');
  if (!m) return [Infinity, Infinity];
  const col = m[2] ? { 左: 1, 中央: 2, 右: 3 }[m[2]] : m[3] ? Number(m[3]) : 0;
  return [Number(m[1]), col];
}

function comparePosition(a, b) {
  const [ra, ca] = positionKey(a.position), [rb, cb] = positionKey(b.position);
  return ra - rb || ca - cb;
}

function companyKey(c) {
  return normalize(c.company).replace(COMPANY_FORMS, '');
}

export function sortCards(cards, order) {
  const list = cards.slice();
  if (order === 'company') {
    list.sort((a, b) => {
      const ka = companyKey(a), kb = companyKey(b);
      if (!ka !== !kb) return ka ? -1 : 1;  // 社名が空欄のものは最後
      return ka.localeCompare(kb, 'ja') || normalize(a.name).localeCompare(normalize(b.name), 'ja');
    });
  } else {
    list.sort((a, b) =>
      (b.shotDate || '').localeCompare(a.shotDate || '') ||
      (b.shotId || '').localeCompare(a.shotId || '') ||
      comparePosition(a, b));
  }
  return list;
}

export function locationText(c) {
  const pos = c.position || '';
  let place;
  if (c.mode === 'ファイル') place = `ファイル ${c.fileNo || '?'}・${c.pageNo || '?'} ページ`;
  else place = c.storageMemo ? `保管メモ：${c.storageMemo}` : '机';
  return pos ? `${place}・${pos}` : place;
}
