/* RangeViewer 2027 — visor de rangos (PWA). Las imágenes se importan desde ALL Ranges.zip y se guardan en IndexedDB. */
'use strict';

const VERSION = '2.1.0';
const POS = ['utg', 'utg1', 'lj', 'hj', 'co', 'btn', 'sb', 'bb'];
const POS_LABEL = { utg: 'UTG', utg1: 'UTG+1', lj: 'LJ', hj: 'HJ', co: 'CO', btn: 'BU', sb: 'SB', bb: 'BB' };
const TYPE_ORDER = ['rfi', 'vslimp', 'vsrfi', 'vsopenjam', 'vslimp-allin', 'vs3bet', 'vsallin', 'limp-vsraise', 'limp-vsallin'];
const TYPE_GROUP = {
  rfi: ['t-open', 'Abres'],
  vsrfi: ['t-face', 'vs open'], vsopenjam: ['t-face', 'vs jam'], vslimp: ['t-face', 'vs limp'], 'vslimp-allin': ['t-face', 'vs limp+jam'],
  vs3bet: ['t-after', 'Abres'], vsallin: ['t-after', 'Abres'], 'limp-vsraise': ['t-after', 'Limp'], 'limp-vsallin': ['t-after', 'Limp'],
};

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const vsLabel = (vs) => (vs || '').split('-').map(p => POS_LABEL[p] || p).join(' + ');
function spotLabel(e) {
  const v = vsLabel(e.vs);
  switch (e.type) {
    case 'rfi': return 'RFI — abres primero';
    case 'vsrfi': return `vs open de ${v}`;
    case 'vsopenjam': return `vs open-jam de ${v}`;
    case 'vslimp': return `vs limp de ${v}`;
    case 'vslimp-allin': { const [a, b] = (e.vs || '').split('-'); return `vs limp de ${POS_LABEL[a]} + POL de ${POS_LABEL[b]}`; }
    case 'vs3bet': return `Abres → 3bet de ${v}`;
    case 'vsallin': return `Abres → all-in de ${v}`;
    case 'limp-vsraise': return `Limp → ROL (raise over limp) de ${v}`;
    case 'limp-vsallin': return `Limp → POL (push over limp) de ${v}`;
    default: return `${e.type} ${v}`;
  }
}
const spotKey = (e) => e.type + ':' + (e.vs || '');
const fullLabel = (e) => `${POS_LABEL[e.pos]} · ${e.stack}bb · ${spotLabel(e)}`;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const store = {
  get(k, d) { try { const v = localStorage.getItem('rv27_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('rv27_' + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('rangeviewer2027', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('img'); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb(storeName, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(storeName, mode);
    const out = fn(tx.objectStore(storeName));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const getMeta = (k) => idb('meta', 'readonly', s => s.get(k));
const setMeta = (k, v) => idb('meta', 'readwrite', s => s.put(v, k));

const urlCache = new Map();
async function imgURL(file) {
  if (urlCache.has(file)) return urlCache.get(file);
  const blob = await idb('img', 'readonly', s => s.get(file));
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  urlCache.set(file, u);
  if (urlCache.size > 160) { const [k, v] = urlCache.entries().next().value; URL.revokeObjectURL(v); urlCache.delete(k); }
  return u;
}
async function setImg(imgEl, file) { imgEl.src = await imgURL(file); }

// ---------- datos ----------
let INDEX = [];
let BY = {};            // BY[pos][stack] = [entries]
function buildIndex(list) {
  INDEX = list.slice().sort((a, b) => POS.indexOf(a.pos) - POS.indexOf(b.pos) || b.stack - a.stack || a.order - b.order);
  BY = {};
  for (const e of INDEX) { ((BY[e.pos] ||= {})[e.stack] ||= []).push(e); }
}
const stacksOf = (pos) => Object.keys(BY[pos] || {}).map(Number).sort((a, b) => b - a);
const allStacks = () => [...new Set(INDEX.map(e => e.stack))].sort((a, b) => b - a);

// ---------- importación ----------
async function importZip(file, onProgress) {
  const zip = await JSZip.loadAsync(file);
  const idxFile = zip.file(/(^|\/)ranges\.json$/)[0];
  if (!idxFile) throw new Error('No encuentro ranges.json dentro del zip. ¿Es el archivo ALL Ranges.zip?');
  const prefix = idxFile.name.slice(0, idxFile.name.length - 'ranges.json'.length);
  const list = JSON.parse(await idxFile.async('string'));
  await idb('img', 'readwrite', s => s.clear());
  const ok = [];
  const BATCH = 20;
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const blobs = await Promise.all(chunk.map(async e => {
      const f = zip.file(prefix + e.file);
      if (!f) return null;
      const ab = await f.async('arraybuffer');
      return new Blob([ab], { type: 'image/webp' });
    }));
    await idb('img', 'readwrite', s => { chunk.forEach((e, j) => { if (blobs[j]) { s.put(blobs[j], e.file); ok.push(e); } }); });
    onProgress(Math.min(1, (i + BATCH) / list.length));
  }
  await setMeta('index', ok);
  await setMeta('importedAt', new Date().toISOString());
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  return ok;
}

function pickZip() {
  return new Promise(res => {
    const inp = $('#zip-input');
    inp.value = '';
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}

async function runImport() {
  const file = await pickZip();
  if (!file) return;
  const m = $('#main');
  m.innerHTML = '';
  const box = h(`<div class="welcome card"><div class="big">📦</div><h2>Importando rangos…</h2>
    <p class="muted" id="imp-msg">Leyendo ${esc(file.name)}. No cierres la app.</p>
    <div class="progress"><div id="imp-bar"></div></div></div>`);
  m.append(box);
  try {
    const list = await importZip(file, p => {
      $('#imp-bar').style.width = (p * 100).toFixed(0) + '%';
      $('#imp-msg').textContent = `Guardando imágenes… ${(p * 100).toFixed(0)}%`;
    });
    buildIndex(list);
    urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
    show('study');
  } catch (err) {
    box.innerHTML = `<div class="big">⚠️</div><h2>No se pudo importar</h2><p class="muted">${esc(err.message || err)}</p>
      <button class="btn" id="retry">Intentar de nuevo</button>`;
    $('#retry').onclick = runImport;
  }
}

function welcome() {
  const m = $('#main');
  m.innerHTML = '';
  m.append(h(`<div class="welcome card">
    <div class="big">♠</div>
    <h2>Bienvenida a RangeViewer 2027</h2>
    <p class="muted">Para empezar, importa tu archivo <b>ALL Ranges.zip</b> desde Archivos.
    Las imágenes se guardan solo en este dispositivo y la app funciona sin internet.</p>
    <button class="btn" id="imp">Importar rangos</button>
    <p class="muted" style="font-size:13px;margin-top:18px">Consejo: añade la app a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) para que el iPad conserve los rangos.</p>
  </div>`));
  $('#imp').onclick = runImport;
}

// ---------- lightbox ----------
let lbZoom = 1;
function openLightbox(e) {
  lbZoom = 1;
  $('#lb-title').textContent = fullLabel(e);
  const img = $('#lb-img');
  img.style.width = '100%';
  setImg(img, e.file);
  $('#lightbox').classList.remove('hidden');
}
function zoomLB(d) { lbZoom = Math.max(1, Math.min(3, lbZoom + d)); $('#lb-img').style.width = (lbZoom * 100) + '%'; }

// ---------- navegación ----------
let current = 'study';
function show(view) {
  current = view;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  const m = $('#main');
  m.innerHTML = '';
  if (!INDEX.length && view !== 'settings') return welcome();
  ({ study: viewStudy, compare: viewCompare, test: viewTest, settings: viewSettings })[view](m);
  window.scrollTo(0, 0);
}

function chipRow(values, active, label, onPick, disabledFn) {
  const row = h('<div class="chips"></div>');
  values.forEach(v => {
    const b = h(`<button class="chip">${esc(label(v))}</button>`);
    if (v === active) b.classList.add('on');
    if (disabledFn && disabledFn(v)) b.disabled = true;
    b.onclick = () => onPick(v);
    row.append(b);
  });
  return row;
}

// ---------- línea de mesa (selector de acción) ----------
const CHIP = {
  rfi:            { cls: 'me',  icon: '▶',    txt: 'RFI' },
  vslimp:         { cls: 'lp',  icon: '=',          txt: 'limp' },
  vsrfi:          { cls: 'op',  icon: '↗', txt: 'open' },
  vsopenjam:      { cls: 'jm',  icon: '⚡',           txt: 'jam' },
  'vslimp-allin': { cls: 'pol', icon: '⚡',           txt: 'POL' },
  vs3bet:         { cls: 'tb',  icon: '⇈',      txt: '3bet', band: 'bR' },
  vsallin:        { cls: 'jm',  icon: '⚡',           txt: 'jam',  band: 'bR' },
  'limp-vsraise': { cls: 'rol', icon: '↗', txt: 'ROL', band: 'bL' },
  'limp-vsallin': { cls: 'pol', icon: '⚡',           txt: 'POL',  band: 'bL' },
};
const CHIP_ORDER = ['vslimp', 'vsrfi', 'vsopenjam', 'vslimp-allin', 'limp-vsraise', 'limp-vsallin', 'vs3bet', 'vsallin'];
function seatOf(e) {
  if (e.type === 'rfi') return null;
  const parts = (e.vs || '').split('-');
  return e.type === 'vslimp-allin' ? parts[parts.length - 1] : parts[0];
}
function tableLine(hero, list, cur, onPick, badge) {
  const wrap = h('<div class="tline"></div>');
  const hi = POS.indexOf(hero);
  POS.forEach((p, i) => {
    const seat = h(`<div class="seat${p === hero ? ' hero' : ''}"><div class="sn">${p === hero ? POS_LABEL[p] + ' · tú' : POS_LABEL[p]}</div></div>`);
    const mine = p === hero ? list.filter(e => e.type === 'rfi') : list.filter(e => seatOf(e) === p)
      .sort((a, b) => CHIP_ORDER.indexOf(a.type) - CHIP_ORDER.indexOf(b.type));
    if (!mine.length) seat.classList.add('empty');
    mine.forEach(e => {
      const c = CHIP[e.type] || { cls: 'op', icon: '•', txt: e.type };
      let txt = c.txt;
      if (e.type === 'vslimp' && (e.vs || '').includes('-')) txt = 'limp ×2';
      const n = badge ? badge(e) : '';
      const b = h(`<button class="m ${c.cls} ${c.band || ''}" title="${esc(spotLabel(e))}"><span class="ic" aria-hidden="true">${c.icon}</span>${esc(txt)}${n ? `<span class="cnt">${n}</span>` : ''}</button>`);
      if (e === cur) b.classList.add('sel');
      b.onclick = () => onPick(e);
      seat.append(b);
    });
    if (i === hi && i > 0) wrap.append(h('<div class="sep"></div>'));
    wrap.append(seat);
    if (i === hi && i < POS.length - 1) wrap.append(h('<div class="sep"></div>'));
  });
  const box = h('<div class="tbox"></div>');
  box.append(wrap);
  return box;
}

// ---------- ESTUDIAR ----------
const S = store.get('study', { pos: 'utg', stack: 100, file: null });
function viewStudy(m) {
  if (!BY[S.pos]) S.pos = POS.find(p => BY[p]);
  if (!BY[S.pos][S.stack]) S.stack = stacksOf(S.pos)[0];
  const list = BY[S.pos][S.stack];
  let cur = list.find(e => e.file === S.file) || list[0];
  S.file = cur.file; store.set('study', S);

  m.append(chipRow(POS, S.pos, p => POS_LABEL[p], p => { S.pos = p; S.file = null; show('study'); }, p => !BY[p]));
  m.append(h('<div style="height:8px"></div>'));
  m.append(chipRow(allStacks(), S.stack, s => s + 'bb', s => { S.stack = s; S.file = null; show('study'); }, s => !BY[S.pos][s]));
  m.append(h('<div style="height:10px"></div>'));
  m.append(tableLine(S.pos, list, cur, e => { S.file = e.file; store.set('study', S); show('study'); }));
  const favs = new Set(store.get('fav', []));

  const viewer = h(`<div class="viewer" id="viewer">
    <div class="viewer-head">
      <div class="viewer-title">${esc(fullLabel(cur))}</div>
      <div class="nav-row">
        <button class="icon-btn" id="fav" title="Favorito">☆</button>
        <button class="icon-btn" id="prev">‹</button>
        <button class="icon-btn" id="next">›</button>
      </div>
    </div>
    <div class="frame"><img id="study-img" alt=""></div>
    <p class="muted" style="font-size:13px">Toca la imagen para verla en grande. Desliza a izquierda/derecha para cambiar de rango.</p>
  </div>`);
  m.append(viewer);
  const img = $('#study-img');
  setImg(img, cur.file);
  img.onclick = () => openLightbox(cur);
  const favBtn = $('#fav');
  const paintFav = () => { const on = favs.has(cur.file); favBtn.textContent = on ? '★' : '☆'; favBtn.classList.toggle('on', on); };
  paintFav();
  favBtn.onclick = () => { favs.has(cur.file) ? favs.delete(cur.file) : favs.add(cur.file); store.set('fav', [...favs]); paintFav(); };
  const go = (d) => { const i = list.indexOf(cur); const n = list[(i + d + list.length) % list.length]; S.file = n.file; store.set('study', S); show('study'); $('#viewer').scrollIntoView(); };
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  swipe(viewer, go);
}

function swipe(el, go) {
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });
}

// ---------- COMPARATIVAS ----------
const C = store.get('compare', { mode: 'evo', pos: 'utg', key: 'rfi:', stack: 20, type: 'rfi', vs: '', a: null, b: null, view: 'slider', layout: 'grid' });
if (!C.layout) C.layout = 'grid';
let selected = [];
const saveC = () => store.set('compare', C);
function viewCompare(m) {
  const modes = { evo: '⇣ Por stack', pos: '⇢ Por posición', duo: '⇄ Cara a cara' };
  m.append(chipRow(Object.keys(modes), C.mode, k => modes[k], k => { C.mode = k; selected = []; saveC(); show('compare'); }));
  const body = h('<div style="margin-top:8px"></div>');
  m.append(body);
  if (C.mode === 'evo') compareEvo(body);
  else if (C.mode === 'pos') comparePos(body);
  else compareDuo(body);
}

function layoutToggle(body) {
  const row = h('<div class="row" style="justify-content:flex-end;margin:10px 0 6px"></div>');
  [['row', '↔ Fila'], ['grid', '▦ Cuadrícula']].forEach(([k, t]) => {
    const b = h(`<button class="chip small${C.layout === k ? ' on' : ''}">${t}</button>`);
    b.onclick = () => { C.layout = k; saveC(); show('compare'); };
    row.append(b);
  });
  body.append(row);
}

function tiles(container, entries, labelFn) {
  const g = h(`<div class="${C.layout === 'row' ? 'strip' : 'grid'}"></div>`);
  entries.forEach(e => {
    const t = h(`<button class="tile"><div class="lbl"><span>${esc(labelFn(e))}</span><span class="badge"></span></div><div class="frame"><img alt=""></div></button>`);
    setImg($('img', t), e.file);
    const paint = () => {
      const i = selected.indexOf(e);
      t.classList.toggle('sel', i >= 0);
      const b = $('.badge', t); b.textContent = i === 0 ? 'A' : i === 1 ? 'B' : ''; b.style.display = i >= 0 ? '' : 'none';
    };
    t.onclick = () => {
      const i = selected.indexOf(e);
      if (i >= 0) selected.splice(i, 1); else { selected.push(e); if (selected.length > 2) selected.shift(); }
      g.querySelectorAll('.tile').forEach(x => x._paint());
      paintBar();
    };
    t._paint = paint; paint();
    g.append(t);
  });
  container.append(g);
  const bar = h(`<div class="bar"><button class="btn ghost" id="cmp-big">Ver grande</button><button class="btn" id="cmp-go">A vs B</button></div>`);
  container.append(bar);
  const paintBar = () => {
    $('#cmp-big').disabled = selected.length !== 1;
    $('#cmp-go').disabled = selected.length !== 2;
  };
  $('#cmp-big').onclick = () => selected[0] && openLightbox(selected[0]);
  $('#cmp-go').onclick = () => { C.a = selected[0].file; C.b = selected[1].file; C.mode = 'duo'; saveC(); selected = []; show('compare'); };
  paintBar();
}

function compareEvo(body) {
  body.append(chipRow(POS, C.pos, p => POS_LABEL[p], p => { C.pos = p; selected = []; saveC(); show('compare'); }, p => !BY[p]));
  const entries = INDEX.filter(e => e.pos === C.pos);
  const keys = {};
  entries.forEach(e => { (keys[spotKey(e)] ||= []).push(e); });
  if (!keys[C.key]) C.key = keys['rfi:'] ? 'rfi:' : Object.keys(keys)[0];
  const reps = Object.values(keys).map(l => l[0]);
  body.append(h('<div style="height:10px"></div>'));
  body.append(tableLine(C.pos, reps, keys[C.key][0], e => { C.key = spotKey(e); selected = []; saveC(); show('compare'); }, e => keys[spotKey(e)].length));
  layoutToggle(body);
  tiles(body, keys[C.key].slice().sort((a, b) => b.stack - a.stack), e => e.stack + 'bb');
}

function comparePos(body) {
  const stacks = allStacks();
  if (!stacks.includes(C.stack)) C.stack = stacks[0];
  body.append(chipRow(stacks, C.stack, s => s + 'bb', s => { C.stack = s; selected = []; saveC(); show('compare'); }));
  const atStack = INDEX.filter(e => e.stack === C.stack);
  const types = TYPE_ORDER.filter(t => atStack.some(e => e.type === t));
  if (!types.includes(C.type)) C.type = types[0];
  const trow = h('<div class="chips" style="margin-top:10px"></div>');
  types.forEach(t => {
    const c = CHIP[t];
    const b = h(`<button class="m ${c.cls} ${c.band || ''}" style="width:auto;padding:8px 14px"><span class="ic">${c.icon}</span>${esc(c.txt)}</button>`);
    if (t === C.type) b.classList.add('sel');
    b.onclick = () => { C.type = t; C.vs = ''; selected = []; saveC(); show('compare'); };
    trow.append(b);
  });
  body.append(trow);
  const ofType = atStack.filter(e => e.type === C.type);
  const vss = [...new Set(ofType.map(e => e.vs || ''))].sort((a, b) => POS.indexOf(a.split('-')[0]) - POS.indexOf(b.split('-')[0]));
  if (vss.length > 1 || (vss.length === 1 && vss[0])) {
    if (!vss.includes(C.vs)) C.vs = vss[0];
    const vrow = h('<div class="chips" style="margin-top:8px"><span class="muted" style="align-self:center;font-size:13px">vs</span></div>');
    vss.forEach(v => {
      const b = h(`<button class="chip small${v === C.vs ? ' on' : ''}">${esc(vsLabel(v))}</button>`);
      b.onclick = () => { C.vs = v; selected = []; saveC(); show('compare'); };
      vrow.append(b);
    });
    body.append(vrow);
  } else C.vs = '';
  const list = ofType.filter(e => (e.vs || '') === C.vs).sort((a, b) => POS.indexOf(a.pos) - POS.indexOf(b.pos));
  layoutToggle(body);
  tiles(body, list, e => POS_LABEL[e.pos]);
}

function entryPicker(slot, title) {
  const file = C[slot];
  let e = INDEX.find(x => x.file === file) || INDEX[0];
  const wrap = h(`<div class="card"><div style="font-weight:800;margin-bottom:8px"><span class="ab">${slot.toUpperCase()}</span>${esc(title)}</div><div class="row"></div></div>`);
  const row = $('.row', wrap);
  const pSel = h('<select></select>'), sSel = h('<select></select>'), eSel = h('<select style="flex:1"></select>');
  POS.filter(p => BY[p]).forEach(p => pSel.append(new Option(POS_LABEL[p], p, false, p === e.pos)));
  stacksOf(e.pos).forEach(s => sSel.append(new Option(s + 'bb', s, false, s === e.stack)));
  BY[e.pos][e.stack].forEach(x => eSel.append(new Option(spotLabel(x), x.file, false, x === e)));
  const choose = (pos, stack, keyPref) => {
    const st = BY[pos][stack] ? stack : stacksOf(pos)[0];
    const l = BY[pos][st];
    const n = l.find(x => spotKey(x) === keyPref) || l[0];
    C[slot] = n.file; store.set('compare', C); show('compare');
  };
  pSel.onchange = () => choose(pSel.value, e.stack, spotKey(e));
  sSel.onchange = () => choose(e.pos, Number(sSel.value), spotKey(e));
  eSel.onchange = () => { C[slot] = eSel.value; store.set('compare', C); show('compare'); };
  row.append(pSel, sSel, eSel);
  return [wrap, e];
}

function compareDuo(body) {
  const [pa, ea] = entryPicker('a', 'Rango A');
  const [pb, eb] = entryPicker('b', 'Rango B');
  C.a = ea.file; C.b = eb.file; store.set('compare', C);
  const duo = h('<div class="duo" style="margin-top:12px"></div>');
  duo.append(pa, pb);
  body.append(duo);
  body.append(h('<div style="height:10px"></div>'));
  body.append(chipRow(['slider', 'side'], C.view, v => v === 'slider' ? 'Deslizador (A encima de B)' : 'Lado a lado', v => { C.view = v; store.set('compare', C); show('compare'); }));
  const swap = h('<button class="btn ghost" style="margin-top:10px">⇄ Intercambiar A y B</button>');
  swap.onclick = () => { [C.a, C.b] = [C.b, C.a]; store.set('compare', C); show('compare'); };
  body.append(swap);

  if (C.view === 'side') {
    const d = h(`<div class="duo" style="margin-top:14px">
      <div><div class="viewer-title"><span class="ab">A</span>${esc(fullLabel(ea))}</div><div class="frame"><img id="ia"></div></div>
      <div><div class="viewer-title"><span class="ab">B</span>${esc(fullLabel(eb))}</div><div class="frame"><img id="ib"></div></div></div>`);
    body.append(d);
    setImg($('#ia'), ea.file); setImg($('#ib'), eb.file);
    $('#ia').onclick = () => openLightbox(ea); $('#ib').onclick = () => openLightbox(eb);
  } else {
    const d = h(`<div style="margin-top:14px">
      <div class="row" style="justify-content:space-between"><div><span class="ab">A</span>${esc(fullLabel(ea))}</div><div><span class="ab">B</span>${esc(fullLabel(eb))}</div></div>
      <div class="frame slider-wrap" style="margin-top:8px">
        <img id="ib" alt="">
        <div class="over" id="over"><img id="ia" alt=""></div>
        <div class="slider-line" id="sline"></div>
      </div>
      <input type="range" min="0" max="100" value="50" id="sl">
      <p class="muted" style="font-size:13px">Mueve el deslizador: a la izquierda ves A, a la derecha ves B. Así se ve qué manos entran o salen del rango.</p></div>`);
    body.append(d);
    setImg($('#ia'), ea.file); setImg($('#ib'), eb.file);
    const upd = () => { const v = $('#sl').value; $('#over').style.clipPath = `inset(0 ${100 - v}% 0 0)`; $('#sline').style.left = `calc(${v}% - 1px)`; };
    $('#sl').oninput = upd; upd();
  }
}

// ---------- TEST ----------
const T = store.get('test', { mode: 'flash', pos: 'all', stack: 'all' });
const SRS = store.get('srs', {});
let session = { ok: 0, mid: 0, bad: 0 };
function pool() {
  return INDEX.filter(e => (T.pos === 'all' || e.pos === T.pos) && (T.stack === 'all' || e.stack === Number(T.stack)));
}
function viewTest(m) {
  m.append(h('<h2>Test</h2>'));
  const modes = { flash: 'Flashcards', guess: '¿Qué spot es?' };
  m.append(chipRow(Object.keys(modes), T.mode, k => modes[k], k => { T.mode = k; store.set('test', T); session = { ok: 0, mid: 0, bad: 0 }; show('test'); }));
  m.append(h('<h3>Practicar</h3>'));
  const row = h('<div class="row"></div>');
  const pSel = h('<select></select>'); pSel.append(new Option('Todas las posiciones', 'all'));
  POS.filter(p => BY[p]).forEach(p => pSel.append(new Option(POS_LABEL[p], p, false, p === T.pos)));
  const sSel = h('<select></select>'); sSel.append(new Option('Todos los stacks', 'all'));
  allStacks().forEach(s => sSel.append(new Option(s + 'bb', String(s), false, String(s) === String(T.stack))));
  pSel.onchange = () => { T.pos = pSel.value; store.set('test', T); show('test'); };
  sSel.onchange = () => { T.stack = sSel.value; store.set('test', T); show('test'); };
  row.append(pSel, sSel);
  m.append(row);
  const p = pool();
  if (!p.length) { m.append(h('<div class="empty">No hay rangos con ese filtro.</div>')); return; }
  const area = h('<div style="margin-top:16px"></div>');
  m.append(area);
  T.mode === 'flash' ? flash(area, p) : guess(area, p);
}

function weightOf(e) { const s = SRS[e.file]; if (!s) return 3; return [6, 4, 2, 1, 0.5][Math.min(s.box, 4)]; }
function weightedPick(list) {
  const total = list.reduce((a, e) => a + weightOf(e), 0);
  let r = Math.random() * total;
  for (const e of list) { r -= weightOf(e); if (r <= 0) return e; }
  return list[list.length - 1];
}

function flash(area, p) {
  const e = weightedPick(p);
  const box = (SRS[e.file] || { box: -1 }).box;
  const card = h(`<div class="card">
    <div class="score"><span>✅ ${session.ok}</span><span>🟡 ${session.mid}</span><span>❌ ${session.bad}</span></div>
    <p class="muted" style="margin:14px 0 0">Piensa el rango antes de mirarlo: ¿qué abres, qué pagas, qué foldeas?</p>
    <div class="prompt">${esc(POS_LABEL[e.pos])} · ${e.stack}bb<br>${esc(spotLabel(e))}</div>
    <p class="muted" style="font-size:13px">${box < 0 ? 'Nuevo' : 'Nivel ' + box + ' de 4'}</p>
    <button class="btn" id="reveal">Ver rango</button>
    <div id="ans" style="display:none;margin-top:14px">
      <div class="frame"><img id="fimg" alt=""></div>
      <p style="font-weight:700;margin:14px 0 8px">¿Cómo te fue?</p>
      <div class="row"><button class="btn bad" data-g="0">Mal</button><button class="btn mid" data-g="1">Regular</button><button class="btn" data-g="2">Bien</button></div>
    </div></div>`);
  area.append(card);
  $('#reveal').onclick = () => { $('#reveal').style.display = 'none'; $('#ans').style.display = ''; setImg($('#fimg'), e.file); };
  $('#fimg').onclick = () => openLightbox(e);
  card.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
    const g = Number(b.dataset.g);
    const s = SRS[e.file] || { box: 0 };
    s.box = g === 0 ? 0 : g === 1 ? Math.max(0, s.box) : Math.min(4, s.box + 1);
    s.last = Date.now();
    SRS[e.file] = s; store.set('srs', SRS);
    session[['bad', 'mid', 'ok'][g]]++;
    show('test');
  });
}

function guess(area, p) {
  const e = pick(p);
  const posOpts = shuffle([e.pos, ...shuffle(POS.filter(x => x !== e.pos && BY[x])).slice(0, 3)]);
  const stacks = allStacks();
  const si = stacks.indexOf(e.stack);
  const near = stacks.filter(s => s !== e.stack).sort((a, b) => Math.abs(stacks.indexOf(a) - si) - Math.abs(stacks.indexOf(b) - si)).slice(0, 3);
  const stackOpts = [e.stack, ...near].sort((a, b) => b - a);
  const sameStack = (BY[e.pos][e.stack] || []).filter(x => spotKey(x) !== spotKey(e));
  const pool2 = sameStack.length >= 3 ? sameStack : INDEX.filter(x => x.pos === e.pos && spotKey(x) !== spotKey(e));
  const spotOpts = shuffle([spotLabel(e), ...[...new Set(shuffle(pool2.slice()).map(spotLabel))].filter(l => l !== spotLabel(e)).slice(0, 3)]);
  const ans = { pos: null, stack: null, spot: null };

  const card = h(`<div class="card">
    <div class="score"><span>✅ ${session.ok}</span><span>❌ ${session.bad}</span></div>
    <p class="muted" style="margin:12px 0">Mira el rango y adivina de qué spot es.</p>
    <div class="frame" id="gframe"><img id="gimg" alt=""><div class="cover" id="gcover">?</div></div>
    <div class="qgroup"><h3>Posición</h3><div class="chips" id="q-pos"></div></div>
    <div class="qgroup"><h3>Stack</h3><div class="chips" id="q-stack"></div></div>
    <div class="qgroup"><h3>Situación</h3><div class="chips" id="q-spot"></div></div>
    <div class="row" style="margin-top:16px"><button class="btn" id="check" disabled>Comprobar</button><button class="btn ghost" id="nextq" style="display:none">Siguiente →</button></div>
    <div id="result" style="margin-top:10px;font-weight:700"></div></div>`);
  area.append(card);
  setImg($('#gimg'), e.file);
  const group = (id, opts, lab, key) => {
    const c = $('#' + id);
    opts.forEach(o => {
      const b = h(`<button class="opt">${esc(lab(o))}</button>`);
      b._v = o;
      b.onclick = () => { if (card._done) return; ans[key] = o; c.querySelectorAll('.opt').forEach(x => x.classList.toggle('on', x === b)); $('#check').disabled = !(ans.pos && ans.stack && ans.spot); };
      c.append(b);
    });
  };
  group('q-pos', posOpts, x => POS_LABEL[x], 'pos');
  group('q-stack', stackOpts, x => x + 'bb', 'stack');
  group('q-spot', spotOpts, x => x, 'spot');
  $('#check').onclick = () => {
    card._done = true;
    const right = { pos: e.pos, stack: e.stack, spot: spotLabel(e) };
    let hits = 0;
    [['q-pos', 'pos'], ['q-stack', 'stack'], ['q-spot', 'spot']].forEach(([id, k]) => {
      $('#' + id).querySelectorAll('.opt').forEach(b => {
        b.classList.remove('on');
        if (b._v === right[k]) b.classList.add('right');
        else if (b._v === ans[k]) b.classList.add('wrong');
      });
      if (ans[k] === right[k]) hits++;
    });
    hits === 3 ? session.ok++ : session.bad++;
    $('#gcover').remove();
    $('#result').textContent = `${hits}/3 correctas — era ${fullLabel(e)}`;
    $('#check').style.display = 'none';
    $('#nextq').style.display = '';
    $('#gimg').onclick = () => openLightbox(e);
  };
  $('#nextq').onclick = () => show('test');
}

// ---------- AJUSTES ----------
async function viewSettings(m) {
  const imported = await getMeta('importedAt').catch(() => null);
  let persisted = false;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) {}
  let usage = '';
  try { if (navigator.storage && navigator.storage.estimate) { const est = await navigator.storage.estimate(); usage = (est.usage / 1048576).toFixed(0) + ' MB usados'; } } catch (e) {}
  const dark = store.get('dark', false);
  const learned = Object.values(SRS).filter(s => s.box >= 3).length;
  m.append(h(`<div class="card">
    <h2>Ajustes</h2>
    <p><b>${INDEX.length}</b> rangos guardados en este dispositivo${imported ? ' · importados el ' + new Date(imported).toLocaleDateString('es') : ''}.</p>
    <p class="muted">${usage}${usage ? ' · ' : ''}${persisted ? 'Almacenamiento protegido ✓' : 'Añade la app a la pantalla de inicio para que el iPad no borre los rangos.'}</p>
    <p class="muted">Flashcards dominadas: ${learned} · Favoritos: ${store.get('fav', []).length}</p>
    <div class="row" style="margin-top:14px">
      <button class="btn" id="s-imp">${INDEX.length ? 'Volver a importar zip' : 'Importar rangos'}</button>
      <button class="btn ghost" id="s-dark">${dark ? 'Modo claro' : 'Modo oscuro'}</button>
      <button class="btn ghost" id="s-srs">Reiniciar progreso del test</button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:18px">RangeViewer 2027 · v${VERSION}</p>
  </div>`));
  $('#s-imp').onclick = runImport;
  $('#s-dark').onclick = () => { store.set('dark', !dark); document.body.classList.toggle('dark', !dark); show('settings'); };
  $('#s-srs').onclick = () => { if (confirm('¿Borrar el progreso de las flashcards?')) { for (const k in SRS) delete SRS[k]; store.set('srs', SRS); show('settings'); } };
}

// ---------- arranque ----------
async function boot() {
  document.body.classList.toggle('dark', store.get('dark', false));
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => show(b.dataset.view));
  $('#lb-close').onclick = () => $('#lightbox').classList.add('hidden');
  $('#lb-zoom-in').onclick = () => zoomLB(0.5);
  $('#lb-zoom-out').onclick = () => zoomLB(-0.5);
  try {
    const list = await getMeta('index');
    if (list && list.length) buildIndex(list);
  } catch (e) { console.warn(e); }
  show(INDEX.length ? 'study' : 'study');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
