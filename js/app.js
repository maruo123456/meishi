// 画面の切り替えとイベント
import { ApiError, call, read, settings, write } from './api.js';
import { blobToBase64, resizePhoto } from './camera.js';
import { filterCards, locationText, sortCards } from './cards.js';
import { deleteDraft, listDrafts, saveDraft } from './draft.js';

const FIELDS = [
  ['company', '社名'], ['department', '部署'], ['title', '役職'], ['name', '名前'],
  ['tel', '電話（会社）'], ['mobile', '携帯'], ['fax', 'FAX'], ['email', 'メール'],
  ['address', '住所'], ['web', 'Web サイト'], ['receivedDate', 'もらった日'], ['memo', '備考（手書きメモ）'],
];
const EDIT_EXTRA = [['fileNo', 'ファイル番号'], ['pageNo', 'ページ番号'], ['storageMemo', '保管メモ'], ['reviewNote', '確認メモ']];

const state = {
  cards: [], counts: {}, shots: null, loaded: false,
  query: '', order: read('meishi.order', 'new'),
  images: new Map(),
  current: { front: null, back: null, frontUrl: '', backUrl: '' },
  sending: false, failedShot: null,
};

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $tabs = document.getElementById('tabs');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');

// ---------------------------------------------------------------- 小さな部品

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 空の部品（null など）を除いて画面に並べる
function setView(...nodes) {
  $view.replaceChildren(...nodes.filter(Boolean));
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}

function errorText(e) {
  if (e instanceof ApiError) {
    if (e.code === 'bad_token') return '合言葉が違います。設定を確かめてください。';
    if (e.code === 'network') return '通信できませんでした。電波のよい場所でもう一度お試しください。';
    if (e.code === 'not_found') return '見つかりませんでした（ほかの画面で削除された可能性があります）。';
  }
  return '問題が起きました（' + (e.code || e.message) + '）。';
}

function handleError(e) {
  toast(errorText(e));
  if (e instanceof ApiError && e.code === 'bad_token') showTab('settings');
}

function openSheet(title, ...content) {
  $sheet.replaceChildren(
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: closeSheet }, '×')),
    h('div', { class: 'sheet-body' }, ...content));
  if (!$sheet.open) $sheet.showModal();
  $sheet.scrollTop = 0;
}
function closeSheet() { if ($sheet.open) $sheet.close(); }

async function loadImage(fileId) {
  if (!fileId) return '';
  if (!state.images.has(fileId)) {
    state.images.set(fileId, call('getImage', { fileId }).then((d) => `data:${d.mimeType};base64,${d.base64}`)
      .catch((e) => { state.images.delete(fileId); throw e; }));
  }
  return state.images.get(fileId);
}

function imageBox(fileId, alt) {
  const box = h('div', { class: 'img-box' });
  if (!fileId) { box.append(h('span', { class: 'muted' }, alt + 'なし')); return box; }
  box.append(h('span', { class: 'muted' }, '読み込み中…'));
  loadImage(fileId).then((src) => {
    const img = h('img', { src, alt, onclick: () => openZoom(src, alt) });
    box.replaceChildren(img);
  }).catch(() => box.replaceChildren(h('span', { class: 'muted' }, '画像を読み込めませんでした')));
  return box;
}

function openZoom(src, alt) {
  const z = h('div', { class: 'zoom', onclick: () => z.remove() }, h('img', { src, alt }));
  document.body.append(z);
}

function nowText() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- タブ

function activeTab() {
  const b = $tabs.querySelector('button.active');
  return b ? b.dataset.tab : '';
}

function showTab(name) {
  for (const b of $tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
  $tabs.hidden = false;
  if (name === 'cards') renderCards();
  else if (name === 'shoot') renderShoot();
  else renderSettings();
}
$tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------------------------------------------------------------- 名刺（一覧）

async function refreshCards() {
  const data = await call('listCards');
  state.cards = data.cards;
  state.counts = data.counts || {};
  state.loaded = true;
}

function renderCards() {
  $title.textContent = '名刺';
  const list = h('ul', { class: 'card-list' });
  const status = h('div', { class: 'status-line' });
  const search = h('input', { type: 'search', placeholder: '社名・名前・部署・備考で探す', value: state.query,
    'aria-label': '検索', oninput: (e) => { state.query = e.target.value; drawList(); } });
  const sortBtns = [['new', '新しい順'], ['company', '社名順']].map(([v, label]) =>
    h('button', { class: 'seg' + (state.order === v ? ' on' : ''), onclick: () => {
      state.order = v; write('meishi.order', v); renderCards();
    } }, label));

  function drawStatus() {
    const pending = state.counts['未処理'] || 0, errors = state.counts['エラー'] || 0;
    status.replaceChildren(...[
      h('span', {}, `全 ${state.cards.length} 枚`),
      pending ? h('span', { class: 'chip' }, `未処理：${pending} 組`) : null,
      errors ? h('button', { class: 'chip danger', onclick: openErrors }, `エラー：${errors} 組`) : null,
    ].filter(Boolean));
  }
  function drawList() {
    const cards = sortCards(filterCards(state.cards, state.query), state.order);
    if (!state.loaded) { list.replaceChildren(h('li', { class: 'empty' }, '読み込み中…')); return; }
    if (cards.length === 0) {
      list.replaceChildren(h('li', { class: 'empty' },
        state.cards.length ? '見つかりませんでした' : 'まだ名刺がありません。「撮影」から撮ってください。'));
      return;
    }
    list.replaceChildren(...cards.map((c) => h('li', {},
      h('button', { class: 'card-row', onclick: () => openCard(c) },
        h('div', { class: 'row-main' },
          h('span', { class: 'row-company' }, c.company || '（社名なし）'),
          c.needsReview ? h('span', { class: 'badge' }, '要確認') : null),
        h('div', { class: 'row-name' }, c.name || '（名前なし）'),
        h('div', { class: 'row-sub' }, [c.department, c.title].filter(Boolean).join(' '))))));
  }

  setView(
    h('div', { class: 'toolbar' }, search, h('div', { class: 'segs' }, ...sortBtns)),
    status, list);
  drawStatus();
  drawList();
  refreshCards().then(() => { drawStatus(); drawList(); }).catch(handleError);
}

function openCard(c) {
  const rows = FIELDS.filter(([k]) => c[k]).map(([k, label]) => {
    let value = c[k];
    if (k === 'email') value = h('a', { href: 'mailto:' + c.email }, c.email);
    else if (k === 'address') value = h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(c.address), target: '_blank', rel: 'noopener' }, c.address);
    else if (k === 'web') value = /^https?:\/\//.test(c.web) ? h('a', { href: c.web, target: '_blank', rel: 'noopener' }, c.web) : c.web;
    else if (k === 'memo') value = h('span', { class: 'pre' }, c.memo);
    return [h('dt', {}, label), h('dd', {}, value)];
  });
  openSheet(c.name || c.company || '名刺',
    c.needsReview ? h('p', { class: 'review' }, '要確認：' + (c.reviewNote || '内容を確かめてください')) : null,
    h('div', { class: 'img-pair' }, imageBox(c.frontImageId, '表'), imageBox(c.backImageId, '裏')),
    h('dl', { class: 'fields' }, ...rows.flat(),
      h('dt', {}, '場所'), h('dd', {}, locationText(c)),
      c.shotDate ? [h('dt', {}, '撮影日'), h('dd', {}, c.shotDate)] : null),
    h('div', { class: 'actions' },
      h('button', { onclick: () => openPage(c) }, 'ページ全体を見る'),
      h('button', { onclick: () => openEdit(c) }, '修正'),
      h('button', { class: 'danger', onclick: () => removeCard(c) }, '削除')));
}

async function getShots(force = false) {
  if (!state.shots || force) state.shots = (await call('listShots')).shots;
  return state.shots;
}

async function openPage(c) {
  openSheet('ページ全体', h('p', { class: 'muted' }, '読み込み中…'));
  try {
    let shot = (await getShots()).find((s) => s.shotId === c.shotId);
    if (!shot) shot = (await getShots(true)).find((s) => s.shotId === c.shotId);
    if (!shot) throw new ApiError('not_found');
    openSheet('ページ全体',
      h('p', { class: 'muted' }, locationText(c)),
      h('h3', {}, '表'), imageBox(shot.frontPhotoId, '表の写真'),
      h('h3', {}, '裏'), imageBox(shot.backPhotoId, '裏の写真'),
      h('div', { class: 'actions' }, h('button', { onclick: () => openCard(c) }, '名刺に戻る')));
  } catch (e) { handleError(e); openCard(c); }
}

function openEdit(c) {
  const inputs = {};
  const field = ([k, label]) => {
    const multi = k === 'memo' || k === 'address' || k === 'reviewNote';
    inputs[k] = multi ? h('textarea', { rows: 3 }, c[k] || '') : h('input', { value: c[k] || '' });
    return h('label', { class: 'field' }, h('span', {}, label), inputs[k]);
  };
  const keep = h('input', { type: 'checkbox' });
  const saveBtn = h('button', { class: 'primary', onclick: async () => {
    const card = { id: c.id, needsReview: keep.checked };
    for (const k of Object.keys(inputs)) card[k] = inputs[k].value.trim();
    saveBtn.disabled = true;
    try {
      const updated = (await call('updateCard', { card })).card;
      const i = state.cards.findIndex((x) => x.id === c.id);
      if (i >= 0) state.cards[i] = updated;
      toast('保存しました');
      renderCards();
      openCard(updated);
    } catch (e) { saveBtn.disabled = false; handleError(e); }
  } }, '保存');
  openSheet('修正', ...FIELDS.map(field),
    ...EDIT_EXTRA.filter(([k]) => c.mode === 'ファイル' ? k !== 'storageMemo' : k !== 'fileNo' && k !== 'pageNo').map(field),
    h('label', { class: 'check' }, keep, '要確認のままにする'),
    h('div', { class: 'actions' }, h('button', { onclick: () => openCard(c) }, 'やめる'), saveBtn));
}

async function removeCard(c) {
  if (!confirm(`「${c.name || c.company}」の名刺を削除しますか？\n切り出し画像はドライブのゴミ箱へ移します。`)) return;
  try {
    await call('deleteCard', { id: c.id });
    state.cards = state.cards.filter((x) => x.id !== c.id);
    closeSheet();
    toast('削除しました');
    renderCards();
  } catch (e) { handleError(e); }
}

async function openErrors() {
  openSheet('エラーの撮影', h('p', { class: 'muted' }, '読み込み中…'));
  try {
    const shots = (await getShots(true)).filter((s) => s.status === 'エラー');
    openSheet('エラーの撮影',
      h('p', {}, '読み取れなかった撮影です。削除してから撮り直してください。'),
      ...shots.map((s) => h('div', { class: 'shot-item' },
        h('div', {}, h('strong', {}, s.shotAt), ' ', shotPlace(s)),
        h('div', { class: 'review' }, s.statusNote || '理由は記録されていません'),
        h('button', { class: 'danger', onclick: () => removeShot(s, openErrors) }, '撮影を削除して撮り直す'))));
  } catch (e) { handleError(e); }
}

function shotPlace(s) {
  return s.mode === 'ファイル' ? `ファイル ${s.fileNo || '?'}・${s.pageNo || '?'} ページ` : `机（${s.storageMemo || '保管メモなし'}）`;
}

async function removeShot(s, after) {
  const n = s.cardCount ? `この撮影の名刺 ${s.cardCount} 枚も削除されます。\n` : '';
  if (!confirm(`${s.shotAt} の撮影（${shotPlace(s)}）を削除しますか？\n${n}写真はドライブのゴミ箱へ移します。`)) return;
  try {
    await call('deleteShot', { shotId: s.shotId });
    state.shots = null;
    toast('削除しました');
    await refreshCards().catch(() => {});
    if (activeTab() === 'cards') renderCards();
    after();
  } catch (e) { handleError(e); }
}

// ---------------------------------------------------------------- 撮影

function renderShoot() {
  $title.textContent = '撮影';
  const cur = state.current;
  const mode = read('meishi.mode', 'ファイル');

  const modeBtns = ['ファイル', '机'].map((m) => h('button', { class: 'seg' + (mode === m ? ' on' : ''),
    onclick: () => { write('meishi.mode', m); renderShoot(); } }, m));

  const place = mode === 'ファイル'
    ? h('div', { class: 'two' },
      h('label', { class: 'field' }, h('span', {}, 'ファイル番号'),
        h('input', { inputmode: 'numeric', value: read('meishi.fileNo', '1'), oninput: (e) => write('meishi.fileNo', e.target.value) })),
      h('label', { class: 'field' }, h('span', {}, 'ページ番号'),
        h('input', { inputmode: 'numeric', value: read('meishi.pageNo', '1'), oninput: (e) => write('meishi.pageNo', e.target.value) })))
    : h('label', { class: 'field' }, h('span', {}, '保管メモ（空欄でもよい）'),
      h('input', { placeholder: '例：名刺箱 A', value: read('meishi.storageMemo', ''), oninput: (e) => write('meishi.storageMemo', e.target.value) }));

  const hint = mode === 'ファイル'
    ? '照明が写り込まない角度で、真上から撮ってください。裏はページをめくって撮ります。'
    : '名刺は少し離して、無地の背景に置いてください。裏はその場で 1 枚ずつ裏返してください。';

  const picker = (side) => {
    const onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        toast('写真を準備しています…');
        const blob = await resizePhoto(file);
        if (cur[side + 'Url']) URL.revokeObjectURL(cur[side + 'Url']);
        cur[side] = blob;
        cur[side + 'Url'] = URL.createObjectURL(blob);
        // 送れなかった撮影の写真を撮り直したら、その下書きは捨てて新しい撮影として送る
        if (state.failedShot) { await deleteDraft(state.failedShot.shotId); state.failedShot = null; }
        cur.shotId = '';
        renderShoot();
      } catch (err) { toast('写真を読み込めませんでした。別の写真でお試しください。'); }
    };
    return h('div', { class: 'pick' },
      h('label', { class: 'btn' }, '📷 カメラで撮る',
        h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange })),
      h('label', { class: 'btn' }, '🖼 写真から選ぶ',
        h('input', { type: 'file', accept: 'image/*', hidden: true, onchange })));
  };
  const preview = (side, label) => cur[side]
    ? h('div', { class: 'preview' }, h('img', { src: cur[side + 'Url'], alt: label }),
      h('button', { class: 'link', onclick: () => { URL.revokeObjectURL(cur[side + 'Url']); cur[side] = null; cur[side + 'Url'] = ''; renderShoot(); } }, '撮り直す'))
    : null;

  const progress = h('p', { class: 'progress', 'aria-live': 'polite' });
  const send = (withBack) => sendCurrent(withBack, progress);
  const retry = state.failedShot
    ? h('button', { class: 'primary', disabled: state.sending, onclick: (e) => { if (!state.sending) resend(state.failedShot, progress, e.currentTarget); } }, 'もう一度送る')
    : null;

  const drafts = h('div');
  listDrafts().then((list) => {
    const others = list.filter((d) => !state.failedShot || d.shotId !== state.failedShot.shotId);
    if (others.length) drafts.replaceChildren(h('div', { class: 'notice' },
      `送れていない撮影が ${others.length} 件あります。`,
      h('button', { onclick: () => resendAll(others, progress) }, 'まとめて送る')));
  });

  setView(
    drafts,
    h('section', { class: 'panel' },
      h('h3', {}, '1. 撮り方'), h('div', { class: 'segs' }, ...modeBtns), place,
      h('p', { class: 'hint' }, hint, ' 1 枚の写真に写す名刺は 10 枚までがおすすめです。')),
    h('section', { class: 'panel' }, h('h3', {}, '2. 表'), preview('front', '表の写真') || picker('front')),
    cur.front ? h('section', { class: 'panel' }, h('h3', {}, '3. 裏'), preview('back', '裏の写真') || picker('back')) : null,
    cur.front ? h('div', { class: 'actions sticky' },
      retry || (cur.back
        ? h('button', { class: 'primary', disabled: state.sending, onclick: (e) => { e.currentTarget.disabled = true; send(true); } }, '送る')
        : h('button', { disabled: state.sending, onclick: (e) => { e.currentTarget.disabled = true; send(false); } }, '裏なしで送る'))) : null,
    progress);
}

async function sendCurrent(withBack, progress) {
  if (state.sending) return;  // 二度押しを防ぐ（画面の描き直しを待たずに止める）
  state.sending = true;
  const cur = state.current;
  if (!cur.shotId) cur.shotId = crypto.randomUUID();
  const mode = read('meishi.mode', 'ファイル');
  const shot = {
    shotId: cur.shotId, shotAt: nowText(), mode,
    fileNo: mode === 'ファイル' ? read('meishi.fileNo', '1') : '',
    pageNo: mode === 'ファイル' ? read('meishi.pageNo', '1') : '',
    storageMemo: mode === '机' ? read('meishi.storageMemo', '') : '',
    front: cur.front, back: withBack ? cur.back : null,
  };
  await saveDraft(shot);
  await resend(shot, progress);
}

async function upload(shot, progress) {
  for (const side of ['front', 'back']) {
    if (!shot[side] || shot[side + 'PhotoId']) continue;
    progress.textContent = (side === 'front' ? '表' : '裏') + 'の写真を送っています…';
    const base64 = await blobToBase64(shot[side]);
    shot[side + 'PhotoId'] = (await call('uploadPhoto', { shotId: shot.shotId, side, base64 })).fileId;
    await saveDraft(shot);
  }
  progress.textContent = '登録しています…';
  const { front, back, ...meta } = shot;
  await call('createShot', meta);
  await deleteDraft(shot.shotId);
}

async function resend(shot, progress, button) {
  state.sending = true;
  if (button) button.disabled = true;
  try {
    await upload(shot, progress);
    state.failedShot = null;
    const cur = state.current;
    for (const side of ['front', 'back']) { if (cur[side + 'Url']) URL.revokeObjectURL(cur[side + 'Url']); cur[side] = null; cur[side + 'Url'] = ''; }
    cur.shotId = '';
    if (shot.mode === 'ファイル' && shot.pageNo === read('meishi.pageNo', '1') && /^\d+$/.test(shot.pageNo)) {
      write('meishi.pageNo', String(Number(shot.pageNo) + 1));
    }
    state.counts['未処理'] = (state.counts['未処理'] || 0) + 1;
    toast(`送りました（${shotPlace(shot)}）`);
  } catch (e) {
    state.failedShot = shot;
    toast(errorText(e));
    if (e instanceof ApiError && e.code === 'bad_token') { state.sending = false; showTab('settings'); return; }
  } finally {
    state.sending = false;
  }
  if (activeTab() === 'shoot') renderShoot();
}

async function resendAll(list, progress) {
  if (state.sending) return;
  state.sending = true;
  try {
    for (const shot of list) await upload(shot, progress);
    toast(`${list.length} 件を送りました`);
  } catch (e) {
    toast(errorText(e));
  } finally {
    state.sending = false;
  }
  renderShoot();
}

// ---------------------------------------------------------------- 設定・初回設定

function connectionForm(onSaved) {
  const url = h('input', { type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', value: settings.url });
  const token = h('input', { type: 'password', autocomplete: 'off', value: settings.token });
  const btn = h('button', { class: 'primary', onclick: async () => {
    const conn = { url: url.value.trim(), token: token.value.trim() };
    if (!/^https:\/\//.test(conn.url) || !conn.token) { toast('接続先と合言葉を入れてください'); return; }
    btn.disabled = true;
    try {
      await call('ping', {}, conn);
      settings.save(conn.url, conn.token);
      toast('つながりました');
      onSaved();
    } catch (e) { toast(errorText(e)); } finally { btn.disabled = false; }
  } }, '接続を確かめて保存');
  return h('section', { class: 'panel' },
    h('label', { class: 'field' }, h('span', {}, '接続先（Apps Script の URL）'), url),
    h('label', { class: 'field' }, h('span', {}, '合言葉'), token), btn);
}

function renderSetup() {
  $title.textContent = '名刺管理';
  $tabs.hidden = true;
  setView(
    h('p', {}, 'はじめに、準備手順書にある接続先と合言葉を入れてください。'),
    connectionForm(() => showTab('cards')));
}

function renderSettings() {
  $title.textContent = '設定';
  const list = h('div', {}, h('p', { class: 'muted' }, '読み込み中…'));
  setView(
    h('h3', {}, '接続'), connectionForm(() => renderSettings()),
    h('h3', {}, '撮影の一覧'), list);
  getShots(true).then((shots) => {
    if (!shots.length) { list.replaceChildren(h('p', { class: 'muted' }, 'まだ撮影はありません')); return; }
    list.replaceChildren(...shots.map((s) => h('div', { class: 'shot-item' },
      h('div', {}, h('strong', {}, s.shotAt), ' ', shotPlace(s)),
      h('div', { class: 'muted' }, `状態：${s.status}` + (s.cardCount ? `・名刺 ${s.cardCount} 枚` : '') + (s.backPhotoId ? '' : '・裏なし')),
      h('button', { class: 'danger small', onclick: () => removeShot(s, renderSettings) }, '削除'))));
  }).catch(handleError);
}

// ---------------------------------------------------------------- 開始

if (settings.url && settings.token) showTab('cards');
else renderSetup();
