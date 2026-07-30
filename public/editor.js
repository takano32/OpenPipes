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
  selection: null,     // { kind: 'module' | 'wire', id }
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
  // the selected module/wire may not exist in the restored graph
  if (state.selection) {
    const list = state.selection.kind === 'module' ? state.modules : state.wires;
    if (!list.some((o) => o.id === state.selection.id)) state.selection = null;
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
    const rect = dom.canvas.getBoundingClientRect();
    addModule(type, Math.round(e.clientX - rect.left) - 130, Math.round(e.clientY - rect.top) - 16);
  });
  // click on empty canvas (or bare wire layer) clears the selection
  dom.canvas.addEventListener('pointerdown', (e) => {
    if (e.target === dom.canvas || e.target === dom.wires) select(null);
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
  select({ kind: 'module', id: mod.id });
  renderParamsStrip();
  updateHint();
}

function updateHint() {
  const hint = $('#canvas-hint');
  if (hint) hint.hidden = state.modules.length > 0;
}

function removeModule(id) {
  state.modules = state.modules.filter((m) => m.id !== id);
  state.wires = state.wires.filter((w) => {
    const keep = w.from.module !== id && w.to.module !== id;
    if (!keep) removeWireEl(w.id);
    return keep;
  });
  const card = cardEls.get(id);
  if (card) card.remove();
  cardEls.delete(id);
  commit();
  renderParamsStrip();
  if (state.selection && state.selection.kind === 'module' && state.selection.id === id) {
    select(null);
  } else {
    renderDebugger(); // the deleted module may have been the fallback target
  }
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
  if (state.selection && state.selection.kind === 'module' && state.selection.id === mod.id) {
    card.classList.add('selected');
  }
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
  select({ kind: 'module', id: mod.id });
  const startX = e.clientX;
  const startY = e.clientY;
  const origX = mod.x;
  const origY = mod.y;
  let moved = false;
  interacting = true;
  try { header.setPointerCapture(e.pointerId); } catch { /* inactive pointer (synthetic event) */ }

  const onMove = (ev) => {
    const nx = Math.max(0, origX + Math.round(ev.clientX - startX));
    const ny = Math.max(0, origY + Math.round(ev.clientY - startY));
    if (nx === mod.x && ny === mod.y) return;
    mod.x = nx;
    mod.y = ny;
    moved = true;
    card.style.left = nx + 'px';
    card.style.top = ny + 'px';
    updateWiresFor(mod.id);
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
  const c = dom.canvas.getBoundingClientRect();
  return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
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
      select({ kind: 'wire', id: w.id });
    });
    dom.wires.append(g);
    wireEls.set(w.id, g);
  }
  const a = portCenter(w.from.module, w.from.port, 'out');
  const b = portCenter(w.to.module, w.to.port, 'in');
  const d = a && b ? bezier(a, b) : '';
  for (const path of g.children) path.setAttribute('d', d);
  g.classList.toggle('selected',
    !!(state.selection && state.selection.kind === 'wire' && state.selection.id === w.id));
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
    const c = dom.canvas.getBoundingClientRect();
    const a = portCenter(moduleId, portName, 'out');
    if (a) dom.ghost.setAttribute('d', bezier(a, { x: ev.clientX - c.left, y: ev.clientY - c.top }));
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

function select(sel) {
  state.selection = sel;
  for (const [id, card] of cardEls) {
    card.classList.toggle('selected', !!(sel && sel.kind === 'module' && sel.id === id));
  }
  for (const [id, g] of wireEls) {
    g.classList.toggle('selected', !!(sel && sel.kind === 'wire' && sel.id === id));
  }
  renderDebugger();
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
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (z || y)) {
      // inside a text field the browser's own undo must win
      if (isTextField(document.activeElement)) return;
      e.preventDefault();
      if (y || e.shiftKey) redo(); else undo();
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (isFormField(document.activeElement)) return;
    const sel = state.selection;
    if (!sel) return;
    e.preventDefault();
    if (sel.kind === 'wire') {
      removeWire(sel.id);
      commit();
    } else {
      removeModule(sel.id);
    }
    select(null);
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
  if (state.selection && state.selection.kind === 'module') {
    const m = state.modules.find((x) => x.id === state.selection.id);
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
  state.selection = null;
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
      let del = null;
      if (!state.config.readOnly) {
        del = el('button', {
          class: 'menu-del', type: 'button', text: '×',
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
        del);
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
    state.selection = null;
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
