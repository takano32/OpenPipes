'use strict';

/*
 * OpenPipes editor — single vanilla-JS file.
 * State mirrors the pipe JSON exactly ({name, modules, wires}) plus savedId/dirty.
 * Rendering: full re-render on structural changes, direct input binding for values.
 */

(() => {

const state = {
  name: '新しいパイプ',
  modules: [],
  wires: [],
  savedId: null,
  dirty: false,
  counter: 1,          // seeds m<N>/w<N> ids; re-seeded past loaded ids
  catalog: [],
  byType: new Map(),
  selected: new Set(), // ids of the selected modules
  selectedWire: null,  // id of the selected wire, if any
  lastDebug: null,     // debug object from the most recent run
  runParams: {},       // user-input values, kept across runs
  dbgJson: false,
  dbgCollapsed: false,
  config: { readOnly: false },
};

/*
 * Undo/redo history. Snapshots rather than commands: the graph is small and
 * plain JSON, and value edits write straight into state.params from input
 * listeners, so there is no single funnel a command log could hook.
 * `key` coalesces a run of edits to one field into a single step.
 */
const MAX_HISTORY = 60;
// Entries carry a revision number rather than being identified by their slot:
// slots get rewritten by coalescing, discarded when a new edit drops the redo
// tail, and renumbered when the cap trims the oldest, so a saved *slot* stops
// meaning "the state that was saved". A revision only ever names one state.
const history = { stack: [], index: 0, savedRev: 0, lastKey: null, rev: 0 };

// true while a pointer drag owns the state; undo mid-drag would swap the
// object under the drag handler and the rest of the gesture would be lost
let interacting = false;

// The canvas is scaled with a CSS transform, so every measurement taken from
// getBoundingClientRect is in screen pixels and has to be divided by this to
// get back to the canvas coordinates modules and wires are stored in.
const ZOOM_STEPS = [0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
const CANVAS_W = 4000;
const CANVAS_H = 3000;
let zoom = 1;

// Copy/paste stays inside the page: reading the system clipboard needs a
// permission prompt, and a graph fragment is not useful anywhere else.
let clipboard = null;

const dom = {};
const cardEls = new Map();  // module id -> card element
const wireEls = new Map();  // wire id -> svg <g>
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (sel, root) => (root || document).querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function catClass(category) {
  return 'cat-' + String(category).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function descriptorOf(mod) {
  return state.byType.get(mod.type) ||
    { type: mod.type, name: mod.type, category: 'Unknown', inputs: [], outputs: [], params: [] };
}

// User-input modules are the ones with no ports at all.
function isUserInput(mod) {
  const d = descriptorOf(mod);
  return d.inputs.length === 0 && d.outputs.length === 0 && state.byType.has(mod.type);
}

// The sink module (has inputs, no outputs) — debugger fallback target.
function findOutputModule() {
  return state.modules.find((m) => {
    const d = descriptorOf(m);
    return d.inputs.length > 0 && d.outputs.length === 0;
  }) || null;
}

function nextId(prefix) {
  let id;
  do {
    id = prefix + state.counter++;
  } while (state.modules.some((m) => m.id === id) || state.wires.some((w) => w.id === id));
  return id;
}

function seedCounter() {
  let max = 0;
  for (const o of [...state.modules, ...state.wires]) {
    const m = /^[mw](\d+)$/.exec(String(o.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  state.counter = max + 1;
}

/* ---------- history ---------- */

function snapshot() {
  return {
    rev: ++history.rev,
    state: structuredClone({ name: state.name, modules: state.modules, wires: state.wires }),
  };
}

// Records the state as it is now. Pass a `key` for edits that should collapse
// into one step while they continue (typing in one field); consecutive commits
// with the same key overwrite the top entry instead of stacking.
function commit(key = null) {
  if (key && key === history.lastKey && history.index > 0) {
    history.stack[history.index] = snapshot();
  } else {
    history.stack.length = history.index + 1;
    history.stack.push(snapshot());
    if (history.stack.length > MAX_HISTORY) history.stack.shift();
    history.index = history.stack.length - 1;
  }
  history.lastKey = key;
  syncHistoryUI();
  drawMinimap();
}

function resetHistory() {
  history.stack = [snapshot()];
  history.index = 0;
  history.savedRev = history.stack[0].rev;
  history.lastKey = null;
  syncHistoryUI();
}

function restore(snap) {
  state.name = snap.name;
  state.modules = structuredClone(snap.modules);
  state.wires = structuredClone(snap.wires);
  // whatever was selected may not exist in the restored graph
  const ids = new Set(state.modules.map((m) => m.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  if (state.selectedWire && !state.wires.some((w) => w.id === state.selectedWire)) {
    state.selectedWire = null;
  }
  renderPipe();
}

function undo() {
  if (interacting || history.index === 0) return;
  history.index -= 1;
  history.lastKey = null;
  restore(history.stack[history.index].state);
  syncHistoryUI();
}

function redo() {
  if (interacting || history.index >= history.stack.length - 1) return;
  history.index += 1;
  history.lastKey = null;
  restore(history.stack[history.index].state);
  syncHistoryUI();
}

function syncHistoryUI() {
  const current = history.stack[history.index];
  state.dirty = !current || current.rev !== history.savedRev;
  if (dom.undo) dom.undo.disabled = history.index === 0;
  if (dom.redo) dom.redo.disabled = history.index >= history.stack.length - 1;
}

/* ---------- zoom ---------- */

// Screen coordinates -> the canvas coordinates modules and wires are stored in.
function canvasPoint(clientX, clientY) {
  const c = dom.canvas.getBoundingClientRect();
  return { x: (clientX - c.left) / zoom, y: (clientY - c.top) / zoom };
}

// `anchor` is a screen point to keep still, so wheel-zoom pulls toward the
// cursor instead of the top-left corner.
function setZoom(next, anchor) {
  const z = clamp(next, ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  if (Math.abs(z - zoom) < 0.001) return;
  const wrap = dom.canvasWrap;
  const rect = wrap.getBoundingClientRect();
  const at = anchor || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  // where the anchor sits in canvas coordinates, before and after
  const before = canvasPoint(at.x, at.y);

  zoom = z;
  dom.canvas.style.transform = `scale(${zoom})`;
  // the sizer carries the scaled footprint so the scrollbars stay honest
  dom.canvasSizer.style.width = CANVAS_W * zoom + 'px';
  dom.canvasSizer.style.height = CANVAS_H * zoom + 'px';

  const after = canvasPoint(at.x, at.y);
  wrap.scrollLeft += (before.x - after.x) * zoom;
  wrap.scrollTop += (before.y - after.y) * zoom;
  dom.zoomLabel.textContent = Math.round(zoom * 100) + '%';
  drawMinimap();
}

function stepZoom(direction, anchor) {
  const i = ZOOM_STEPS.findIndex((z) => z > zoom + 0.001);
  const next = direction > 0
    ? ZOOM_STEPS[i === -1 ? ZOOM_STEPS.length - 1 : i]
    : ZOOM_STEPS[Math.max(0, (i === -1 ? ZOOM_STEPS.length : i) - 2)];
  setZoom(next, anchor);
}

function bindZoom() {
  dom.zoomOut.addEventListener('click', () => stepZoom(-1));
  dom.zoomIn.addEventListener('click', () => stepZoom(1));
  dom.zoomLabel.addEventListener('click', () => setZoom(1));
  dom.canvasWrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel still scrolls
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1, { x: e.clientX, y: e.clientY });
  }, { passive: false });
}

/* ---------- auto layout ---------- */

const LAYOUT = { x0: 60, y0: 40, gapX: 40, gapY: 60, inputGap: 60 };

// Longest path from any source: a module sits one row below whatever feeds it,
// so wires only ever point downwards and never skip back up a row.
function layerOf(modules, wires) {
  const incoming = new Map(modules.map((m) => [m.id, []]));
  for (const w of wires) {
    if (incoming.has(w.to.module) && incoming.has(w.from.module)) {
      incoming.get(w.to.module).push(w.from.module);
    }
  }
  const layer = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0; // a cycle the editor is holding mid-edit
    visiting.add(id);
    const ups = incoming.get(id) || [];
    const d = ups.length ? Math.max(...ups.map(depth)) + 1 : 0;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const m of modules) depth(m.id);
  return layer;
}

function autoLayout() {
  if (!state.modules.length) return;
  // user inputs are not part of the flow; they get their own column on the left
  const flow = state.modules.filter((m) => !isUserInput(m));
  const inputs = state.modules.filter((m) => isUserInput(m));
  const size = (m) => {
    const card = cardEls.get(m.id);
    return { w: card ? card.offsetWidth : 260, h: card ? card.offsetHeight : 120 };
  };

  const layer = layerOf(flow, state.wires);
  const rows = new Map();
  for (const m of flow) {
    const d = layer.get(m.id) || 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(m);
  }

  const inputWidth = inputs.length ? Math.max(...inputs.map((m) => size(m).w)) + LAYOUT.inputGap : 0;
  const left = LAYOUT.x0 + inputWidth;
  let y = LAYOUT.y0;
  for (const d of [...rows.keys()].sort((a, b) => a - b)) {
    // keep the left-to-right order the user already had within the row
    const row = rows.get(d).sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
    let x = left;
    let tallest = 0;
    for (const m of row) {
      const { w, h } = size(m);
      m.x = Math.round(x);
      m.y = Math.round(y);
      x += w + LAYOUT.gapX;
      tallest = Math.max(tallest, h);
    }
    y += tallest + LAYOUT.gapY;
  }

  let iy = LAYOUT.y0;
  for (const m of inputs) {
    m.x = LAYOUT.x0;
    m.y = Math.round(iy);
    iy += size(m).h + LAYOUT.gapY;
  }

  commit(); // one step, however many modules moved
  renderPipe();
  dom.canvasWrap.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  toast('整列しました');
}

/* ---------- minimap ---------- */

// Fits every module into the little canvas and marks where the viewport is.
// Drawn from state plus the cards' measured sizes, so it needs no separate
// bookkeeping — just a redraw whenever the graph or the scroll changes.
const MINIMAP_PAD = 120;

function minimapBounds() {
  if (!state.modules.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const m of state.modules) {
    const card = cardEls.get(m.id);
    x1 = Math.min(x1, m.x);
    y1 = Math.min(y1, m.y);
    x2 = Math.max(x2, m.x + (card ? card.offsetWidth : 260));
    y2 = Math.max(y2, m.y + (card ? card.offsetHeight : 120));
  }
  // include the viewport so the marker is always somewhere on the map
  const wrap = dom.canvasWrap;
  x1 = Math.min(x1, wrap.scrollLeft / zoom);
  y1 = Math.min(y1, wrap.scrollTop / zoom);
  x2 = Math.max(x2, (wrap.scrollLeft + wrap.clientWidth) / zoom);
  y2 = Math.max(y2, (wrap.scrollTop + wrap.clientHeight) / zoom);
  return { x1: x1 - MINIMAP_PAD, y1: y1 - MINIMAP_PAD, x2: x2 + MINIMAP_PAD, y2: y2 + MINIMAP_PAD };
}

let minimapView = null; // { bounds, scale, offsetX, offsetY }

function drawMinimap() {
  const map = dom.minimap;
  if (!map) return;
  const bounds = minimapBounds();
  map.hidden = !bounds;
  minimapView = null;
  if (!bounds) return;

  const w = map.width;
  const h = map.height;
  const scale = Math.min(w / (bounds.x2 - bounds.x1), h / (bounds.y2 - bounds.y1));
  const offsetX = (w - (bounds.x2 - bounds.x1) * scale) / 2;
  const offsetY = (h - (bounds.y2 - bounds.y1) * scale) / 2;
  minimapView = { bounds, scale, offsetX, offsetY };
  const px = (x) => offsetX + (x - bounds.x1) * scale;
  const py = (y) => offsetY + (y - bounds.y1) * scale;

  const g = map.getContext('2d');
  g.clearRect(0, 0, w, h);

  g.strokeStyle = '#b6c0cd';
  g.lineWidth = 1;
  for (const wire of state.wires) {
    const from = state.modules.find((m) => m.id === wire.from.module);
    const to = state.modules.find((m) => m.id === wire.to.module);
    if (!from || !to) continue;
    const fc = cardEls.get(from.id);
    const tc = cardEls.get(to.id);
    g.beginPath();
    g.moveTo(px(from.x + (fc ? fc.offsetWidth : 260) / 2), py(from.y + (fc ? fc.offsetHeight : 120)));
    g.lineTo(px(to.x + (tc ? tc.offsetWidth : 260) / 2), py(to.y));
    g.stroke();
  }

  for (const m of state.modules) {
    const card = cardEls.get(m.id);
    const d = descriptorOf(m);
    g.fillStyle = CATEGORY_COLORS[d.category] || '#8a94a3';
    g.globalAlpha = state.selected.has(m.id) ? 1 : 0.75;
    g.fillRect(px(m.x), py(m.y),
      Math.max(2, (card ? card.offsetWidth : 260) * scale),
      Math.max(2, (card ? card.offsetHeight : 120) * scale));
  }
  g.globalAlpha = 1;

  const wrap = dom.canvasWrap;
  g.strokeStyle = '#2f80ed';
  g.lineWidth = 1.5;
  g.strokeRect(
    px(wrap.scrollLeft / zoom), py(wrap.scrollTop / zoom),
    (wrap.clientWidth / zoom) * scale, (wrap.clientHeight / zoom) * scale,
  );
}

const CATEGORY_COLORS = {
  Sources: '#2f80ed',
  'User Inputs': '#9b51e0',
  Operators: '#f2994a',
  Output: '#27ae60',
};

function bindMinimap() {
  const jump = (e) => {
    if (!minimapView) return;
    const r = dom.minimap.getBoundingClientRect();
    const { bounds, scale, offsetX, offsetY } = minimapView;
    // centre the viewport on the point that was clicked
    const cx = bounds.x1 + ((e.clientX - r.left) - offsetX) / scale;
    const cy = bounds.y1 + ((e.clientY - r.top) - offsetY) / scale;
    dom.canvasWrap.scrollLeft = cx * zoom - dom.canvasWrap.clientWidth / 2;
    dom.canvasWrap.scrollTop = cy * zoom - dom.canvasWrap.clientHeight / 2;
  };
  dom.minimap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dom.minimap.setPointerCapture?.(e.pointerId);
    jump(e);
    const onMove = (ev) => { if (ev.buttons & 1) jump(ev); };
    const stop = () => {
      dom.minimap.removeEventListener('pointermove', onMove);
      dom.minimap.removeEventListener('pointerup', stop);
      dom.minimap.removeEventListener('pointercancel', stop);
    };
    dom.minimap.addEventListener('pointermove', onMove);
    dom.minimap.addEventListener('pointerup', stop);
    dom.minimap.addEventListener('pointercancel', stop);
  });
  dom.canvasWrap.addEventListener('scroll', drawMinimap, { passive: true });
  window.addEventListener('resize', drawMinimap);
}

function toast(message, kind) {
  const t = el('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), text: message });
  dom.toasts.append(t);
  setTimeout(() => t.classList.add('fade'), 3200);
  setTimeout(() => t.remove(), 3800);
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
  return body;
}

function postJSON(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ---------- boot ---------- */

async function init() {
  dom.palette = $('#palette');
  dom.canvasWrap = $('#canvas-wrap');
  dom.canvas = $('#canvas');
  dom.wires = $('#wires');
  dom.ghost = $('#ghost-wire');
  dom.paramsStrip = $('#params-strip');
  dom.debugger = $('#debugger');
  dom.dbgHeader = $('#debugger-header');
  dom.dbgCaret = $('#dbg-caret');
  dom.dbgTitle = $('#dbg-title');
  dom.dbgBody = $('#debugger-body');
  dom.dbgJsonBtn = $('#dbg-json-toggle');
  dom.toasts = $('#toasts');
  dom.pipeName = $('#pipe-name');
  dom.openRss = $('#open-rss');
  dom.loadMenu = $('#load-menu');
  dom.undo = $('#btn-undo');
  dom.redo = $('#btn-redo');
  dom.canvasSizer = $('#canvas-sizer');
  dom.zoomIn = $('#zoom-in');
  dom.zoomOut = $('#zoom-out');
  dom.zoomLabel = $('#zoom-label');
  dom.minimap = $('#minimap');
  dom.layout = $('#btn-layout');

  try {
    state.config = await api('/api/config');
  } catch { /* an older server: assume everything is allowed */ }
  if (state.config.readOnly) {
    const save = $('#btn-save');
    save.disabled = true;
    save.title = 'このインスタンスは読み取り専用です';
    document.body.classList.add('read-only');
  }

  try {
    state.catalog = await api('/api/modules');
  } catch (err) {
    toast('モジュール一覧の取得に失敗しました: ' + err.message, 'error');
    state.catalog = [];
  }
  for (const d of state.catalog) state.byType.set(d.type, d);

  renderPalette();
  bindTopbar();
  bindCanvas();
  bindKeys();
  bindZoom();
  bindMinimap();
  bindDebugger();
  renderPipe();
  resetHistory();

  const deepLink = new URLSearchParams(location.search).get('pipe');
  if (deepLink) loadPipe(deepLink);
}

document.addEventListener('DOMContentLoaded', init);

/* ---------- palette ---------- */

function renderPalette() {
  dom.palette.textContent = '';
  const byCat = new Map();
  for (const d of state.catalog) {
    if (!byCat.has(d.category)) byCat.set(d.category, []);
    byCat.get(d.category).push(d);
  }
  for (const [category, descs] of byCat) {
    const group = el('div', { class: 'pal-group' },
      el('div', { class: 'pal-cat ' + catClass(category), text: category }));
    for (const d of descs) {
      const item = el('div', { class: 'pal-item', draggable: 'true', title: d.description || '' },
        el('span', { class: 'pal-dot ' + catClass(category) }),
        el('span', { class: 'pal-name', text: d.name }));
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', d.type);
        e.dataTransfer.effectAllowed = 'copy';
      });
      group.append(item);
    }
    dom.palette.append(group);
  }
}

/* ---------- canvas & modules ---------- */

function bindCanvas() {
  dom.canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dom.canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!state.byType.has(type)) return;
    const at = canvasPoint(e.clientX, e.clientY);
    addModule(type, Math.round(at.x) - 130, Math.round(at.y) - 16);
  });
  // press on empty canvas: clear, and rubber-band if the pointer moves
  dom.canvas.addEventListener('pointerdown', (e) => {
    if (e.target !== dom.canvas && e.target !== dom.wires) return;
    if (e.button !== 0) return;
    startMarquee(e);
  });
}

function addModule(type, x, y) {
  const d = state.byType.get(type);
  const params = {};
  for (const p of d.params) params[p.name] = structuredClone(p.default);
  const mod = { id: nextId('m'), type, params, x: Math.max(0, x), y: Math.max(0, y) };
  state.modules.push(mod);
  commit();
  dom.canvas.append(renderCard(mod));
  selectModules([mod.id]);
  renderParamsStrip();
  updateHint();
}

function updateHint() {
  const hint = $('#canvas-hint');
  if (hint) hint.hidden = state.modules.length > 0;
}

// Drops the module and its wires without touching history, so deleting a
// whole selection can be recorded as one step.
function removeModuleSilently(id) {
  state.modules = state.modules.filter((m) => m.id !== id);
  state.wires = state.wires.filter((w) => {
    const keep = w.from.module !== id && w.to.module !== id;
    if (!keep) removeWireEl(w.id);
    return keep;
  });
  const card = cardEls.get(id);
  if (card) card.remove();
  cardEls.delete(id);
  state.selected.delete(id);
}

function removeModule(id) {
  removeModuleSilently(id);
  commit();
  renderParamsStrip();
  renderDebugger(); // the deleted module may have been the debugger's target
  updateHint();
}

// Loaded pipes may miss params the catalog defines, or carry malformed
// rows (the save API only shape-checks loosely) — fill in and coerce.
function normalizeParams(mod, d) {
  for (const p of d.params) {
    const v = mod.params[p.name];
    if (v === undefined ||
        ((p.kind === 'list' || p.kind === 'rules') && !Array.isArray(v))) {
      mod.params[p.name] = structuredClone(p.default);
      continue;
    }
    if (p.kind === 'list') {
      mod.params[p.name] = v.map((x) => (x == null ? '' : String(x)));
    } else if (p.kind === 'rules') {
      const proto = Array.isArray(p.default) && p.default.length ? p.default[0] : {};
      mod.params[p.name] = v.map((row) =>
        (row && typeof row === 'object' && !Array.isArray(row)) ? row : structuredClone(proto));
    }
  }
}

// Drop entries a hostile/hand-written saved file could contain that the
// renderer cannot survive: non-object modules/wires, missing or duplicate
// ids, wires pointing at unknown modules.
function sanitizePipe(modules, wires) {
  const ids = new Set();
  const mods = (Array.isArray(modules) ? modules : []).filter((m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    const id = m.id == null ? '' : String(m.id);
    if (!id || ids.has(id)) return false;
    ids.add(id);
    m.id = id;
    if (!m.params || typeof m.params !== 'object' || Array.isArray(m.params)) m.params = {};
    return true;
  });
  const wireIds = new Set();
  const ws = (Array.isArray(wires) ? wires : []).filter((w) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return false;
    const id = w.id == null ? '' : String(w.id);
    if (!id || wireIds.has(id)) return false;
    if (!w.from || typeof w.from !== 'object' || !w.to || typeof w.to !== 'object') return false;
    if (!ids.has(String(w.from.module)) || !ids.has(String(w.to.module))) return false;
    wireIds.add(id);
    w.id = id;
    return true;
  });
  return { modules: mods, wires: ws };
}

function renderCard(mod) {
  const d = descriptorOf(mod);
  if (!mod.params || typeof mod.params !== 'object') mod.params = {};
  normalizeParams(mod, d);
  mod.x = Number(mod.x) || 0;
  mod.y = Number(mod.y) || 0;

  const card = el('div', { class: 'module-card', 'data-id': mod.id });
  card.style.left = mod.x + 'px';
  card.style.top = mod.y + 'px';

  card.append(portRow(mod, d.inputs, 'in'));

  const header = el('div', { class: 'card-header ' + catClass(d.category) },
    el('span', { class: 'card-title', text: d.name, title: d.description || d.name }),
    el('span', { class: 'badge', hidden: '' }),
    (() => {
      const del = el('button', { class: 'card-del', type: 'button', title: '削除', text: '×' });
      del.addEventListener('click', (e) => { e.stopPropagation(); removeModule(mod.id); });
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      return del;
    })());
  header.addEventListener('pointerdown', (e) => startCardDrag(e, mod, card, header));
  card.append(header);

  const body = el('div', { class: 'card-body' });
  renderParams(body, mod, d);
  card.append(body);

  card.append(portRow(mod, d.outputs, 'out'));

  applyRunDecorations(mod.id, card);
  if (state.selected.has(mod.id)) card.classList.add('selected');
  cardEls.set(mod.id, card);
  return card;
}

function portRow(mod, ports, dir) {
  const row = el('div', { class: 'ports ports-' + dir });
  ports.forEach((p, i) => {
    const port = el('div', {
      class: 'port',
      title: p.name,
      'data-dir': dir,
      'data-port': p.name,
      'data-module': mod.id,
    });
    port.style.left = ((i + 1) / (ports.length + 1) * 100) + '%';
    if (dir === 'out') {
      port.addEventListener('pointerdown', (e) => startWireDrag(e, mod.id, p.name, port));
    }
    row.append(port);
  });
  return row;
}

/* ---------- param rendering (schema-driven; the five kinds) ---------- */

function renderParams(body, mod, d) {
  body.textContent = '';
  if (d.params.length === 0) {
    body.append(el('div', { class: 'no-params', text: 'パラメータなし' }));
    return;
  }
  for (const p of d.params) {
    const wrap = el('div', { class: 'param param-' + p.kind },
      el('label', { class: 'param-label', text: p.label }));
    if (p.kind === 'text' || p.kind === 'number') {
      wrap.append(scalarInput(p, mod.params[p.name], (v) => {
        mod.params[p.name] = v;
        commit(`param:${mod.id}:${p.name}`);
        if (isUserInput(mod)) renderParamsStrip();
      }));
    } else if (p.kind === 'select') {
      wrap.append(selectInput(p.options, mod.params[p.name], (v) => {
        mod.params[p.name] = v;
        commit();
      }));
    } else if (p.kind === 'list') {
      wrap.append(listEditor(mod, p));
    } else if (p.kind === 'rules') {
      wrap.append(rulesEditor(mod, p));
    }
    body.append(wrap);
  }
}

function scalarInput(p, value, onChange) {
  const input = el('input', {
    type: p.kind === 'number' ? 'number' : 'text',
    value: value == null ? '' : String(value),
  });
  if (p.placeholder) input.placeholder = p.placeholder;
  if (p.kind === 'number' && p.min !== undefined) input.min = p.min;
  input.addEventListener('input', () => {
    onChange(p.kind === 'number' ? numberValue(input) : input.value);
  });
  return input;
}

function numberValue(input) {
  const n = input.valueAsNumber;
  return Number.isFinite(n) ? n : input.value;
}

function selectInput(options, value, onChange) {
  const sel = el('select');
  for (const o of options || []) sel.append(el('option', { value: o, text: o }));
  if (value != null) sel.value = String(value);
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/* ---------- list / rules editors (structural changes re-render rows only) ---------- */

function rowButtons(arr, i, blank, rebuild) {
  const add = el('button', { class: 'row-btn', type: 'button', title: '行を追加', text: '+' });
  add.addEventListener('click', () => { arr.splice(i + 1, 0, blank()); commit(); rebuild(); });
  const del = el('button', { class: 'row-btn', type: 'button', title: '行を削除', text: '×' });
  del.addEventListener('click', () => { arr.splice(i, 1); commit(); rebuild(); });
  return el('span', { class: 'row-btns' }, add, del);
}

function addRowButton(arr, blank, rebuild) {
  const b = el('button', { class: 'row-add', type: 'button', text: '+ 行を追加' });
  b.addEventListener('click', () => { arr.push(blank()); commit(); rebuild(); });
  return b;
}

function listEditor(mod, p) {
  const box = el('div', { class: 'rows' });
  const blank = () => '';
  const rebuild = () => {
    box.textContent = '';
    const arr = mod.params[p.name];
    arr.forEach((v, i) => {
      const input = el('input', { type: 'text', value: v == null ? '' : String(v) });
      if (p.placeholder) input.placeholder = p.placeholder;
      input.addEventListener('input', () => {
        arr[i] = input.value;
        commit(`param:${mod.id}:${p.name}:${i}`);
      });
      box.append(el('div', { class: 'row' }, input, rowButtons(arr, i, blank, rebuild)));
    });
    if (arr.length === 0) box.append(addRowButton(arr, blank, rebuild));
    updateWiresFor(mod.id); // row count changes the card height, ports move
  };
  rebuild();
  return box;
}

function rulesEditor(mod, p) {
  const box = el('div', { class: 'rows rules' });
  const proto = Array.isArray(p.default) && p.default.length ? p.default[0] : null;
  const blank = () => {
    if (proto) return structuredClone(proto);
    const row = {};
    for (const f of p.fields) {
      row[f.name] = f.kind === 'select' ? ((f.options && f.options[0]) || '')
        : f.kind === 'number' ? 0 : '';
    }
    return row;
  };
  const rebuild = () => {
    box.textContent = '';
    const arr = mod.params[p.name];
    arr.forEach((row, i) => {
      const rowEl = el('div', { class: 'row' });
      for (const f of p.fields) {
        let control;
        if (f.kind === 'select') {
          control = selectInput(f.options, row[f.name], (v) => { row[f.name] = v; commit(); });
        } else {
          control = el('input', {
            type: f.kind === 'number' ? 'number' : 'text',
            value: row[f.name] == null ? '' : String(row[f.name]),
          });
          if (f.placeholder) control.placeholder = f.placeholder;
          control.addEventListener('input', () => {
            row[f.name] = f.kind === 'number' ? numberValue(control) : control.value;
            commit(`param:${mod.id}:${p.name}:${i}:${f.name}`);
          });
        }
        control.title = f.name;
        rowEl.append(control);
      }
      rowEl.append(rowButtons(arr, i, blank, rebuild));
      box.append(rowEl);
    });
    if (arr.length === 0) box.append(addRowButton(arr, blank, rebuild));
    updateWiresFor(mod.id); // row count changes the card height, ports move
  };
  rebuild();
  return box;
}

/* ---------- module dragging ---------- */

function startCardDrag(e, mod, card, header) {
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;

  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (additive) selectModules([mod.id], { additive: true });
  else if (!state.selected.has(mod.id)) selectModules([mod.id]);
  // dragging a member of a multi-selection moves the whole set
  const group = state.selected.has(mod.id)
    ? state.modules.filter((m) => state.selected.has(m.id))
    : [mod];
  const origins = group.map((m) => ({ m, x: m.x, y: m.y }));

  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  interacting = true;
  try { header.setPointerCapture(e.pointerId); } catch { /* inactive pointer (synthetic event) */ }

  const onMove = (ev) => {
    const dx = Math.round((ev.clientX - startX) / zoom);
    const dy = Math.round((ev.clientY - startY) / zoom);
    let changed = false;
    for (const o of origins) {
      const nx = Math.max(0, o.x + dx);
      const ny = Math.max(0, o.y + dy);
      if (nx === o.m.x && ny === o.m.y) continue;
      o.m.x = nx;
      o.m.y = ny;
      changed = true;
      const c = cardEls.get(o.m.id);
      if (c) {
        c.style.left = nx + 'px';
        c.style.top = ny + 'px';
      }
      updateWiresFor(o.m.id);
    }
    if (changed) {
      moved = true;
      drawMinimap();
    }
  };
  const onEnd = () => {
    header.removeEventListener('pointermove', onMove);
    header.removeEventListener('pointerup', onEnd);
    header.removeEventListener('pointercancel', onEnd);
    interacting = false;
    if (moved) commit(); // one step per drag, not per pointermove
  };
  header.addEventListener('pointermove', onMove);
  header.addEventListener('pointerup', onEnd);
  header.addEventListener('pointercancel', onEnd);
}

/* ---------- wires ---------- */

function portCenter(moduleId, portName, dir) {
  const card = cardEls.get(moduleId);
  if (!card) return null;
  const port = card.querySelector(
    '.port[data-dir="' + dir + '"][data-port="' + CSS.escape(portName) + '"]');
  if (!port) return null;
  const r = port.getBoundingClientRect();
  return canvasPoint(r.left + r.width / 2, r.top + r.height / 2);
}

function bezier(a, b) {
  const dy = clamp(Math.abs(b.y - a.y) * 0.5, 40, 160);
  return 'M ' + a.x + ' ' + a.y +
    ' C ' + a.x + ' ' + (a.y + dy) + ', ' + b.x + ' ' + (b.y - dy) + ', ' + b.x + ' ' + b.y;
}

function renderWire(w) {
  let g = wireEls.get(w.id);
  if (!g) {
    g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('wire');
    g.dataset.id = w.id;
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.classList.add('wire-hit');
    const line = document.createElementNS(SVG_NS, 'path');
    line.classList.add('wire-line');
    g.append(hit, line);
    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectWire(w.id);
    });
    dom.wires.append(g);
    wireEls.set(w.id, g);
  }
  const a = portCenter(w.from.module, w.from.port, 'out');
  const b = portCenter(w.to.module, w.to.port, 'in');
  const d = a && b ? bezier(a, b) : '';
  for (const path of g.children) path.setAttribute('d', d);
  g.classList.toggle('selected', state.selectedWire === w.id);
}

function updateWiresFor(moduleId) {
  for (const w of state.wires) {
    if (w.from.module === moduleId || w.to.module === moduleId) renderWire(w);
  }
}

function updateAllWires() {
  for (const w of state.wires) renderWire(w);
}

function removeWireEl(id) {
  const g = wireEls.get(id);
  if (g) g.remove();
  wireEls.delete(id);
}

// Callers commit — replacing a wire is one undo step, not two.
function removeWire(id) {
  state.wires = state.wires.filter((w) => w.id !== id);
  removeWireEl(id);
}

function addWire(from, to) {
  // one wire per input port: replace any existing wire into that input
  const existing = state.wires.find((w) => w.to.module === to.module && w.to.port === to.port);
  if (existing) removeWire(existing.id);
  const w = { id: nextId('w'), from, to };
  state.wires.push(w);
  renderWire(w);
  commit();
}

function startWireDrag(e, moduleId, portName, portEl) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  try { portEl.setPointerCapture(e.pointerId); } catch { /* inactive pointer (synthetic event) */ }
  // input ports only accept pointer events while a wire is being dragged
  document.body.classList.add('wiring');
  interacting = true;
  let target = null; // highlighted input port element under the pointer

  const onMove = (ev) => {
    const a = portCenter(moduleId, portName, 'out');
    if (a) dom.ghost.setAttribute('d', bezier(a, canvasPoint(ev.clientX, ev.clientY)));
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hit = under ? under.closest('.port[data-dir="in"]') : null;
    const next = hit && hit.dataset.module !== moduleId ? hit : null;
    if (next !== target) {
      if (target) target.classList.remove('drop-target');
      target = next;
      if (target) target.classList.add('drop-target');
    }
  };
  const cleanup = () => {
    portEl.removeEventListener('pointermove', onMove);
    portEl.removeEventListener('pointerup', onUp);
    portEl.removeEventListener('pointercancel', cleanup);
    dom.ghost.setAttribute('d', '');
    document.body.classList.remove('wiring');
    interacting = false;
    if (target) target.classList.remove('drop-target');
  };
  const onUp = () => {
    const drop = target;
    cleanup();
    if (drop) {
      addWire({ module: moduleId, port: portName },
        { module: drop.dataset.module, port: drop.dataset.port });
    }
  };
  portEl.addEventListener('pointermove', onMove);
  portEl.addEventListener('pointerup', onUp);
  portEl.addEventListener('pointercancel', cleanup);
}

/* ---------- selection & keyboard ---------- */

function paintSelection() {
  for (const [id, card] of cardEls) card.classList.toggle('selected', state.selected.has(id));
  for (const [id, g] of wireEls) g.classList.toggle('selected', state.selectedWire === id);
  renderDebugger();
  drawMinimap();
}

// `additive` is shift/ctrl-click: toggle this module in or out and leave the
// rest of the selection alone.
function selectModules(ids, { additive = false } = {}) {
  if (!additive) state.selected.clear();
  for (const id of ids) {
    if (additive && state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  }
  state.selectedWire = null;
  paintSelection();
}

function selectWire(id) {
  state.selected.clear();
  state.selectedWire = id;
  paintSelection();
}

function clearSelection() {
  state.selected.clear();
  state.selectedWire = null;
  paintSelection();
}

/* ---------- marquee, delete, clipboard ---------- */

// Rubber-band select. The box lives inside #canvas so it scales with the zoom
// and needs no coordinate conversion of its own once the corners are canvas
// points.
function startMarquee(e) {
  const origin = canvasPoint(e.clientX, e.clientY);
  const box = el('div', { class: 'marquee' });
  let dragged = false;

  const onMove = (ev) => {
    const at = canvasPoint(ev.clientX, ev.clientY);
    if (!dragged && Math.hypot(at.x - origin.x, at.y - origin.y) < 4) return;
    if (!dragged) {
      dragged = true;
      interacting = true;
      dom.canvas.append(box);
    }
    const left = Math.min(origin.x, at.x);
    const top = Math.min(origin.y, at.y);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = Math.abs(at.x - origin.x) + 'px';
    box.style.height = Math.abs(at.y - origin.y) + 'px';

    const right = left + Math.abs(at.x - origin.x);
    const bottom = top + Math.abs(at.y - origin.y);
    const hits = state.modules.filter((m) => {
      const card = cardEls.get(m.id);
      if (!card) return false;
      // offsetWidth/Height are layout pixels, already free of the zoom
      return m.x < right && m.x + card.offsetWidth > left &&
             m.y < bottom && m.y + card.offsetHeight > top;
    });
    selectModules(hits.map((m) => m.id));
  };
  const finish = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    box.remove();
    interacting = false;
    if (!dragged) clearSelection(); // a plain click on empty canvas
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

function deleteSelection() {
  if (state.selectedWire) {
    removeWire(state.selectedWire);
    state.selectedWire = null;
    commit();
    paintSelection();
    return;
  }
  const ids = [...state.selected];
  if (!ids.length) return;
  for (const id of ids) removeModuleSilently(id);
  commit(); // the whole set is one undo step
  clearSelection();
  renderParamsStrip();
  updateHint();
}

function copySelection() {
  const ids = new Set(state.selected);
  if (!ids.size) return;
  clipboard = {
    modules: structuredClone(state.modules.filter((m) => ids.has(m.id))),
    // only wires with both ends inside the selection can be reproduced
    wires: structuredClone(
      state.wires.filter((w) => ids.has(w.from.module) && ids.has(w.to.module))),
  };
  toast(`${clipboard.modules.length} 個のモジュールをコピーしました`);
}

function pasteClipboard() {
  if (!clipboard || !clipboard.modules.length) return;
  const remap = new Map();
  const pasted = clipboard.modules.map((m) => {
    const copy = structuredClone(m);
    copy.id = nextId('m');
    remap.set(m.id, copy.id);
    copy.x = Math.max(0, (Number(m.x) || 0) + 30);
    copy.y = Math.max(0, (Number(m.y) || 0) + 30);
    return copy;
  });
  const wires = clipboard.wires.map((w) => ({
    id: nextId('w'),
    from: { module: remap.get(w.from.module), port: w.from.port },
    to: { module: remap.get(w.to.module), port: w.to.port },
  }));
  state.modules.push(...pasted);
  state.wires.push(...wires);
  commit();
  renderPipe();
  selectModules(pasted.map((m) => m.id)); // so it can be dragged into place
}

// A text field owns its own undo stack and caret keys; a <select> does not,
// so graph shortcuts still apply there.
function isTextField(node) {
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);
}

function isFormField(node) {
  return isTextField(node) || (!!node && node.tagName === 'SELECT');
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const z = e.key === 'z' || e.key === 'Z';
    const y = e.key === 'y' || e.key === 'Y';
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0')) {
      if (isTextField(document.activeElement)) return;
      e.preventDefault();
      if (e.key === '0') setZoom(1); else stepZoom(e.key === '-' ? -1 : 1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (z || y)) {
      // inside a text field the browser's own undo must win
      if (isTextField(document.activeElement)) return;
      e.preventDefault();
      if (y || e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && 'acvx'.includes(e.key.toLowerCase())) {
      if (isFormField(document.activeElement)) return;
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); selectModules(state.modules.map((m) => m.id)); return; }
      if (k === 'c') { e.preventDefault(); copySelection(); return; }
      if (k === 'x') { e.preventDefault(); copySelection(); deleteSelection(); return; }
      if (k === 'v') { e.preventDefault(); pasteClipboard(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      if (isFormField(document.activeElement)) return;
      e.preventDefault();
      autoLayout();
      return;
    }
    if (e.key === 'Escape') {
      clearSelection();
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (isFormField(document.activeElement)) return;
    if (!state.selected.size && !state.selectedWire) return;
    e.preventDefault();
    deleteSelection();
  });

  // leaving a field ends its coalescing run, so returning to it later is a
  // separate undo step
  document.addEventListener('focusout', () => { history.lastKey = null; });

  // Safety net: a drag whose pointerup never reaches the captured element
  // would otherwise leave the editor stuck mid-gesture — undo disabled and
  // input ports still swallowing clicks.
  for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, () => {
      interacting = false;
      document.body.classList.remove('wiring');
    }, true);
  }
}

/* ---------- full pipe render ---------- */

function renderPipe() {
  dom.pipeName.value = state.name;
  for (const card of cardEls.values()) card.remove();
  cardEls.clear();
  for (const g of wireEls.values()) g.remove();
  wireEls.clear();
  for (const mod of state.modules) dom.canvas.append(renderCard(mod));
  updateAllWires();
  updateOpenRss();
  renderParamsStrip();
  renderRunDecorations();
  renderDebugger();
  updateHint();
  drawMinimap();
}

/* ---------- run decorations (badges + error rings) ---------- */

function applyRunDecorations(id, card) {
  const entry = state.lastDebug ? state.lastDebug[id] : null;
  const badge = card.querySelector('.badge');
  badge.hidden = !entry;
  badge.textContent = entry ? String(entry.count) : '';
  card.classList.toggle('error-ring', !!(entry && entry.error));
}

function renderRunDecorations() {
  for (const [id, card] of cardEls) applyRunDecorations(id, card);
}

/* ---------- params strip (user-input modules) ---------- */

function userInputModules() {
  return state.modules.filter(isUserInput);
}

function renderParamsStrip() {
  const inputs = userInputModules();
  dom.paramsStrip.hidden = inputs.length === 0;
  dom.paramsStrip.textContent = '';
  if (inputs.length === 0) return;
  dom.paramsStrip.append(el('span', { class: 'strip-title', text: 'パラメータ' }));
  for (const mod of inputs) {
    const d = descriptorOf(mod);
    const name = String(mod.params.name || '');
    const label = String(mod.params.prompt || name || d.name);
    const defParam = d.params.find((p) => p.name === 'default');
    const isNumber = !!defParam && defParam.kind === 'number';
    const current = Object.prototype.hasOwnProperty.call(state.runParams, name)
      ? state.runParams[name]
      : mod.params.default;
    const input = el('input', {
      type: isNumber ? 'number' : 'text',
      value: current == null ? '' : String(current),
    });
    input.addEventListener('input', () => { state.runParams[name] = input.value; });
    dom.paramsStrip.append(el('label', { class: 'strip-field' },
      el('span', { text: label }), input));
  }
}

function collectRunParams() {
  const params = {};
  for (const mod of userInputModules()) {
    const name = String(mod.params.name || '');
    if (!name) continue;
    params[name] = Object.prototype.hasOwnProperty.call(state.runParams, name)
      ? state.runParams[name]
      : (mod.params.default == null ? '' : mod.params.default);
  }
  return params;
}

/* ---------- debugger panel ---------- */

function bindDebugger() {
  dom.dbgHeader.addEventListener('click', (e) => {
    if (e.target === dom.dbgJsonBtn) return;
    state.dbgCollapsed = !state.dbgCollapsed;
    dom.debugger.classList.toggle('collapsed', state.dbgCollapsed);
    dom.dbgCaret.textContent = state.dbgCollapsed ? '▸' : '▾';
  });
  dom.dbgJsonBtn.addEventListener('click', () => {
    state.dbgJson = !state.dbgJson;
    dom.dbgJsonBtn.classList.toggle('on', state.dbgJson);
    renderDebugger();
  });
}

function debugTargetModule() {
  for (const id of state.selected) {
    const m = state.modules.find((x) => x.id === id);
    if (m) return m;
  }
  return findOutputModule();
}

function renderDebugger() {
  const mod = debugTargetModule();
  const entry = mod && state.lastDebug ? state.lastDebug[mod.id] : null;
  dom.dbgBody.textContent = '';
  if (!mod || !entry) {
    dom.dbgTitle.textContent = 'デバッガー';
    dom.dbgJsonBtn.hidden = true;
    dom.dbgBody.append(el('div', {
      class: 'dbg-empty',
      text: mod ? '実行 ▶ を押すと結果が表示されます'
                : 'モジュールを選択し、実行 ▶ を押すと結果が表示されます',
    }));
    return;
  }
  dom.dbgTitle.textContent = descriptorOf(mod).name + ' — ' + entry.count + ' items';
  dom.dbgJsonBtn.hidden = false;
  if (entry.error) {
    dom.dbgBody.append(el('div', { class: 'dbg-error', text: 'エラー: ' + entry.error }));
  }
  const items = Array.isArray(entry.items) ? entry.items : [];
  if (state.dbgJson) {
    dom.dbgBody.append(el('pre', { class: 'dbg-json', text: JSON.stringify(items, null, 2) }));
    return;
  }
  if (items.length === 0 && !entry.error) {
    dom.dbgBody.append(el('div', { class: 'dbg-empty', text: 'アイテムはありません' }));
  }
  for (const item of items) dom.dbgBody.append(dbgItemCard(item));
  if (entry.count > items.length) {
    dom.dbgBody.append(el('div', { class: 'dbg-more', text: '…他 ' + (entry.count - items.length) + ' 件' }));
  }
}

function dbgItemCard(item) {
  const card = el('div', { class: 'dbg-item' });
  if (!item || typeof item !== 'object') {
    card.append(el('div', { class: 'dbg-item-kv', text: String(item) }));
    return card;
  }
  if (item.title != null) {
    card.append(el('div', { class: 'dbg-item-title', text: String(item.title) }));
  }
  if (item.link != null) {
    const link = String(item.link);
    // feed content is untrusted: only navigable web schemes become anchors
    const attrs = { class: 'dbg-item-link', text: link };
    if (/^(https?|mailto):/i.test(link.trim())) {
      Object.assign(attrs, { href: link, target: '_blank', rel: 'noopener noreferrer' });
      card.append(el('a', attrs));
    } else {
      card.append(el('span', attrs));
    }
  }
  if (item.description != null) {
    const s = String(item.description).replace(/<[^>]*>/g, '');
    card.append(el('div', {
      class: 'dbg-item-desc',
      text: s.length > 200 ? s.slice(0, 200) + '…' : s,
    }));
  }
  for (const [k, v] of Object.entries(item)) {
    if (k === 'title' || k === 'link' || k === 'description') continue;
    if (v == null || typeof v === 'object') continue;
    card.append(el('div', { class: 'dbg-item-kv' },
      el('span', { class: 'k', text: k + ': ' }),
      el('span', { text: String(v) })));
  }
  return card;
}

/* ---------- top bar: run / save / load / new ---------- */

function bindTopbar() {
  dom.pipeName.addEventListener('input', () => {
    state.name = dom.pipeName.value;
    commit('name');
  });
  dom.undo.addEventListener('click', undo);
  dom.redo.addEventListener('click', redo);
  dom.layout.addEventListener('click', autoLayout);
  $('#btn-run').addEventListener('click', runPipe);
  $('#btn-save').addEventListener('click', savePipe);
  $('#btn-new').addEventListener('click', newPipe);
  $('#btn-load').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLoadMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!dom.loadMenu.hidden && !e.target.closest('#load-wrap')) dom.loadMenu.hidden = true;
  });
}

async function runPipe() {
  renderParamsStrip();
  const btn = $('#btn-run');
  btn.disabled = true;
  try {
    const body = { pipe: { name: state.name, modules: state.modules, wires: state.wires } };
    const params = collectRunParams();
    if (Object.keys(params).length) body.params = params;
    const res = await postJSON('/api/run', body);
    state.lastDebug = res.debug || {};
    renderRunDecorations();
    renderDebugger();
    if (res.errors && res.errors.length) {
      toast(res.errors.map((x) => x.module + ': ' + x.message).join(' / '), 'error');
    }
  } catch (err) {
    toast('実行エラー: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function savePipe() {
  try {
    const body = { name: state.name, modules: state.modules, wires: state.wires };
    if (state.savedId) body.id = state.savedId;
    // what the request actually carries — an edit made while it is in flight
    // must not be counted as saved
    const sentRev = history.stack[history.index].rev;
    history.lastKey = null; // typing on either side of a save is not one step
    const res = await postJSON('/api/pipes', body);
    state.savedId = res.id;
    history.savedRev = sentRev;
    syncHistoryUI();
    updateOpenRss();
    toast('保存しました');
  } catch (err) {
    toast('保存エラー: ' + err.message, 'error');
  }
}

function updateOpenRss() {
  dom.openRss.hidden = !state.savedId;
  if (state.savedId) {
    dom.openRss.href = '/pipes/' + encodeURIComponent(state.savedId) + '/run';
  }
}

function newPipe() {
  if (state.dirty && !confirm('未保存の変更があります。破棄して新規作成しますか？')) return;
  state.name = '新しいパイプ';
  state.modules = [];
  state.wires = [];
  state.savedId = null;
  state.counter = 1;
  state.selected.clear();
  state.selectedWire = null;
  state.lastDebug = null;
  state.runParams = {};
  renderPipe();
  resetHistory(); // a fresh document, not an undoable edit
}

async function toggleLoadMenu() {
  if (!dom.loadMenu.hidden) {
    dom.loadMenu.hidden = true;
    return;
  }
  dom.loadMenu.hidden = false;
  dom.loadMenu.textContent = '';
  dom.loadMenu.append(el('div', { class: 'menu-note', text: '読み込み中…' }));
  try {
    const list = await api('/api/pipes');
    dom.loadMenu.textContent = '';
    if (!Array.isArray(list) || list.length === 0) {
      dom.loadMenu.append(el('div', { class: 'menu-note', text: '保存されたパイプはありません' }));
      return;
    }
    for (const p of list) {
      const label = p.name || p.id;
      let dup = null;
      let del = null;
      if (!state.config.readOnly) {
        dup = el('button', {
          class: 'menu-act', type: 'button', text: '⧉',
          title: `「${label}」を複製`, 'aria-label': `${label} を複製`,
        });
        dup.addEventListener('click', (e) => {
          e.stopPropagation();
          duplicatePipe(p.id, label);
        });
        del = el('button', {
          class: 'menu-act menu-del', type: 'button', text: '×',
          title: `「${label}」を削除`, 'aria-label': `${label} を削除`,
        });
        del.addEventListener('click', (e) => {
          e.stopPropagation(); // the row itself loads the pipe
          deletePipe(p.id, label);
        });
      }
      const row = el('div', { class: 'menu-item' },
        el('span', { class: 'menu-name', text: label }),
        el('span', { class: 'menu-date', text: p.savedAt ? new Date(p.savedAt).toLocaleString() : '' }),
        dup, del);
      row.addEventListener('click', () => {
        dom.loadMenu.hidden = true;
        loadPipe(p.id);
      });
      dom.loadMenu.append(row);
    }
  } catch (err) {
    dom.loadMenu.textContent = '';
    dom.loadMenu.append(el('div', { class: 'menu-note', text: '取得エラー: ' + err.message }));
  }
}

// Saves a copy under a new id. Done through the API rather than by loading
// into the editor, so it does not disturb whatever is on the canvas.
async function duplicatePipe(id, label) {
  try {
    const pipe = await api('/api/pipes/' + encodeURIComponent(id));
    const copy = await postJSON('/api/pipes', {
      name: `${pipe.name || label} のコピー`,
      modules: pipe.modules,
      wires: pipe.wires,
    });
    toast(`「${pipe.name || label}」を複製しました`);
    if (!dom.loadMenu.hidden) {
      dom.loadMenu.hidden = true;
      toggleLoadMenu(); // reopen on the refreshed list
    }
    return copy.id;
  } catch (err) {
    toast('複製エラー: ' + err.message, 'error');
    return null;
  }
}

async function deletePipe(id, label) {
  if (!confirm(`「${label}」を削除しますか？この操作は取り消せません。`)) return;
  try {
    await api('/api/pipes/' + encodeURIComponent(id), { method: 'DELETE' });
    // the open pipe was the deleted one: keep the graph on the canvas, but it
    // is no longer backed by a file, so it counts as unsaved again
    if (state.savedId === id) {
      state.savedId = null;
      history.savedRev = 0; // no revision was ever 0
      updateOpenRss();
      syncHistoryUI();
    }
    toast(`「${label}」を削除しました`);
  } catch (err) {
    toast('削除エラー: ' + err.message, 'error');
  }
  if (!dom.loadMenu.hidden) {
    dom.loadMenu.hidden = true;
    toggleLoadMenu(); // reopen on the refreshed list
  }
}

async function loadPipe(id) {
  if (state.dirty && !confirm('未保存の変更があります。破棄して読み込みますか？')) return;
  try {
    const pipe = await api('/api/pipes/' + encodeURIComponent(id));
    const clean = sanitizePipe(pipe.modules, pipe.wires);
    state.name = typeof pipe.name === 'string' ? pipe.name : '';
    state.modules = clean.modules;
    state.wires = clean.wires;
    state.savedId = pipe.id || id;
    state.selected.clear();
    state.selectedWire = null;
    state.lastDebug = null;
    state.runParams = {};
    seedCounter();
    renderPipe();
    resetHistory(); // history belongs to the document you opened
  } catch (err) {
    toast('読み込みエラー: ' + err.message, 'error');
  }
}

})();
