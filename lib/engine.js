// OpenPipes engine: module catalog + pipe executor. See docs/SPEC.md.

import { fetchURL, parseFeed } from './feed.js';

export class PipeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PipeError';
    this.status = 400;
  }
}

const INPUT_TYPES = new Set(['text_input', 'number_input', 'url_input']);

const userInputParams = (nameDefault, defaultKind, defaultDefault) => [
  { name: 'name', label: 'Name', kind: 'text', default: nameDefault },
  { name: 'prompt', label: 'Prompt', kind: 'text', default: '' },
  { name: 'default', label: 'Default', kind: defaultKind, default: defaultDefault },
];

const CATALOG = [
  {
    type: 'fetch_feed',
    name: 'Fetch Feed',
    category: 'Sources',
    description: 'Fetch one or more RSS/Atom/RDF feeds and combine their items',
    inputs: [],
    outputs: [{ name: 'out' }],
    params: [{ name: 'urls', label: 'URLs', kind: 'list', default: [''] }],
  },
  {
    type: 'fetch_json',
    name: 'Fetch JSON',
    category: 'Sources',
    description: 'Fetch a URL and turn JSON data into items',
    inputs: [],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'url', label: 'URL', kind: 'text', default: '' },
      { name: 'path', label: 'Path', kind: 'text', default: '' },
    ],
  },
  {
    type: 'item_builder',
    name: 'Item Builder',
    category: 'Sources',
    description: 'Build a single item from named fields',
    inputs: [],
    outputs: [{ name: 'out' }],
    params: [
      {
        name: 'fields',
        label: 'Fields',
        kind: 'rules',
        fields: [
          { name: 'name', kind: 'text' },
          { name: 'value', kind: 'text' },
        ],
        default: [{ name: 'title', value: '' }],
      },
    ],
  },
  {
    type: 'text_input',
    name: 'Text Input',
    category: 'User Inputs',
    description: 'Declare a text pipe parameter usable as ${name}',
    inputs: [],
    outputs: [],
    params: userInputParams('text1', 'text', ''),
  },
  {
    type: 'number_input',
    name: 'Number Input',
    category: 'User Inputs',
    description: 'Declare a numeric pipe parameter usable as ${name}',
    inputs: [],
    outputs: [],
    params: userInputParams('text1', 'number', 0),
  },
  {
    type: 'url_input',
    name: 'URL Input',
    category: 'User Inputs',
    description: 'Declare a URL pipe parameter usable as ${name}',
    inputs: [],
    outputs: [],
    params: userInputParams('url1', 'text', ''),
  },
  {
    type: 'filter',
    name: 'Filter',
    category: 'Operators',
    description: 'Permit or block items that match rules',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'mode', label: 'Mode', kind: 'select', options: ['permit', 'block'], default: 'permit' },
      { name: 'combine', label: 'Combine', kind: 'select', options: ['all', 'any'], default: 'all' },
      {
        name: 'rules',
        label: 'Rules',
        kind: 'rules',
        fields: [
          { name: 'field', kind: 'text', placeholder: 'title' },
          {
            name: 'op',
            kind: 'select',
            options: ['contains', 'not_contains', 'matches_regex', 'equals', 'not_equals', 'greater_than', 'less_than'],
          },
          { name: 'value', kind: 'text' },
        ],
        default: [{ field: 'title', op: 'contains', value: '' }],
      },
    ],
  },
  {
    type: 'sort',
    name: 'Sort',
    category: 'Operators',
    description: 'Sort items by one or more fields',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      {
        name: 'rules',
        label: 'Rules',
        kind: 'rules',
        fields: [
          { name: 'field', kind: 'text' },
          { name: 'dir', kind: 'select', options: ['asc', 'desc'] },
        ],
        default: [{ field: 'pubDate', dir: 'desc' }],
      },
    ],
  },
  {
    type: 'truncate',
    name: 'Truncate',
    category: 'Operators',
    description: 'Keep only the first N items',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [{ name: 'count', label: 'Count', kind: 'number', min: 0, default: 10 }],
  },
  {
    type: 'tail',
    name: 'Tail',
    category: 'Operators',
    description: 'Keep only the last N items',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [{ name: 'count', label: 'Count', kind: 'number', min: 0, default: 10 }],
  },
  {
    type: 'unique',
    name: 'Unique',
    category: 'Operators',
    description: 'Keep the first item per distinct field value',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [{ name: 'field', label: 'Field', kind: 'text', default: 'title' }],
  },
  {
    type: 'reverse',
    name: 'Reverse',
    category: 'Operators',
    description: 'Reverse the order of items',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [],
  },
  {
    type: 'union',
    name: 'Union',
    category: 'Operators',
    description: 'Concatenate items from up to five inputs',
    inputs: [{ name: 'in1' }, { name: 'in2' }, { name: 'in3' }, { name: 'in4' }, { name: 'in5' }],
    outputs: [{ name: 'out' }],
    params: [],
  },
  {
    type: 'count',
    name: 'Count',
    category: 'Operators',
    description: 'Emit a single item holding the number of input items',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [],
  },
  {
    type: 'rename',
    name: 'Rename',
    category: 'Operators',
    description: 'Rename or copy item fields',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      {
        name: 'rules',
        label: 'Rules',
        kind: 'rules',
        fields: [
          { name: 'from', kind: 'text' },
          { name: 'op', kind: 'select', options: ['rename', 'copy'] },
          { name: 'to', kind: 'text' },
        ],
        default: [{ from: '', op: 'rename', to: '' }],
      },
    ],
  },
  {
    type: 'regex',
    name: 'Regex',
    category: 'Operators',
    description: 'Apply regex replacements to item fields',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      {
        name: 'rules',
        label: 'Rules',
        kind: 'rules',
        fields: [
          { name: 'field', kind: 'text' },
          { name: 'pattern', kind: 'text' },
          { name: 'replace', kind: 'text' },
          { name: 'flags', kind: 'text', placeholder: 'gi' },
        ],
        default: [{ field: 'title', pattern: '', replace: '', flags: 'g' }],
      },
    ],
  },
  {
    type: 'sub_element',
    name: 'Sub-element',
    category: 'Operators',
    description: 'Replace each item with the value at a path inside it',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [{ name: 'path', label: 'Path', kind: 'text', default: '' }],
  },
  {
    type: 'output',
    name: 'Pipe Output',
    category: 'Output',
    description: "The pipe's result",
    inputs: [{ name: 'in' }],
    outputs: [],
    params: [],
  },
];

export function catalog() {
  return structuredClone(CATALOG);
}

// ---------------------------------------------------------------------------
// Path helpers (dot-separated, numeric segments index arrays)

// Field paths come from pipe params, i.e. from untrusted request bodies:
// a segment that reaches into an object's prototype must never be followed,
// or a single request could corrupt Object.prototype process-wide.
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function splitPath(path) {
  const keys = String(path).split('.');
  return keys.some((k) => UNSAFE_SEGMENTS.has(k)) ? null : keys;
}

function getPath(obj, path) {
  if (path == null || path === '') return obj;
  const keys = splitPath(path);
  if (!keys) return undefined;
  let cur = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, path, value) {
  const keys = splitPath(path);
  if (!keys) return;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(cur, key) ||
        cur[key] === null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

function deletePath(obj, path) {
  const keys = splitPath(path);
  if (!keys) return;
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    if (!Object.prototype.hasOwnProperty.call(cur, keys[i])) return;
    cur = cur[keys[i]];
  }
  if (cur === null || typeof cur !== 'object') return;
  const last = keys[keys.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cur, last)) return;
  if (Array.isArray(cur) && /^\d+$/.test(last)) cur.splice(Number(last), 1);
  else delete cur[last];
}

// ---------------------------------------------------------------------------
// Smart comparator (filter greater_than/less_than and sort)

function numericValue(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN; // empty/whitespace strings and other types are not numeric
}

function smartCompare(a, b) {
  const na = numericValue(a);
  const nb = numericValue(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  const da = Date.parse(String(a));
  const db = Date.parse(String(b));
  if (!Number.isNaN(da) && !Number.isNaN(db)) {
    return da < db ? -1 : da > db ? 1 : 0;
  }
  return String(a).localeCompare(String(b));
}

// ---------------------------------------------------------------------------
// Module evaluators: async (params, inputs, ctx) -> items

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asRows(v) {
  return Array.isArray(v) ? v : [];
}

function toCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchText(url, ctx) {
  const res = await ctx.fetcher(url, { baseUrl: ctx.baseUrl });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Fetch failed (HTTP ${res.status}): ${url}`);
  }
  return res.text;
}

function jsonToItems(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((el) => (isPlainObject(el) ? el : { value: el }));
  }
  if (isPlainObject(value)) return [value];
  return [{ value }];
}

function lower(v) {
  return String(v).toLowerCase();
}

function compileFilterRules(rows) {
  return rows.map((r) => {
    const rule = {
      field: String(r?.field ?? ''),
      op: String(r?.op ?? 'contains'),
      value: String(r?.value ?? ''),
    };
    if (rule.op === 'matches_regex') rule.regex = new RegExp(rule.value);
    return rule;
  });
}

function ruleMatches(item, rule) {
  const v = getPath(item, rule.field);
  if (v == null) return false;
  switch (rule.op) {
    case 'contains':
      return lower(v).includes(lower(rule.value));
    case 'not_contains':
      return !lower(v).includes(lower(rule.value));
    case 'matches_regex':
      return rule.regex.test(String(v));
    case 'equals':
      return lower(v) === lower(rule.value);
    case 'not_equals':
      return lower(v) !== lower(rule.value);
    case 'greater_than':
      return smartCompare(v, rule.value) > 0;
    case 'less_than':
      return smartCompare(v, rule.value) < 0;
    default:
      return false;
  }
}

const noItems = async () => [];

const evaluators = {
  async fetch_feed(params, inputs, ctx) {
    const urls = asRows(params.urls).filter((u) => typeof u === 'string' && u.trim() !== '');
    const feeds = await Promise.all(
      urls.map(async (url) => parseFeed(await fetchText(url, ctx))),
    );
    const items = [];
    for (const feed of feeds) {
      for (const item of feed.items) {
        if (feed.title) item.source = feed.title;
        items.push(item);
      }
    }
    return items;
  },

  async fetch_json(params, inputs, ctx) {
    const url = String(params.url ?? '').trim();
    if (!url) return [];
    const data = JSON.parse(await fetchText(url, ctx));
    return jsonToItems(getPath(data, String(params.path ?? '')));
  },

  async item_builder(params) {
    const item = {};
    for (const row of asRows(params.fields)) {
      const name = String(row?.name ?? '').trim();
      if (!name) continue;
      setPath(item, name, String(row?.value ?? ''));
    }
    return [item];
  },

  text_input: noItems,
  number_input: noItems,
  url_input: noItems,

  async filter(params, inputs) {
    const block = params.mode === 'block';
    const any = params.combine === 'any';
    const rules = compileFilterRules(asRows(params.rules));
    return inputs.in.filter((item) => {
      const matched = any
        ? rules.some((r) => ruleMatches(item, r))
        : rules.every((r) => ruleMatches(item, r));
      return block ? !matched : matched;
    });
  },

  async sort(params, inputs) {
    const rules = asRows(params.rules).map((r) => ({
      field: String(r?.field ?? ''),
      dir: r?.dir === 'desc' ? -1 : 1,
    }));
    return inputs.in.slice().sort((a, b) => {
      for (const { field, dir } of rules) {
        const va = getPath(a, field);
        const vb = getPath(b, field);
        const aMissing = va == null;
        const bMissing = vb == null;
        if (aMissing || bMissing) {
          if (aMissing && bMissing) continue;
          return aMissing ? 1 : -1; // missing sorts last regardless of direction
        }
        const c = smartCompare(va, vb);
        if (c !== 0) return c * dir;
      }
      return 0;
    });
  },

  async truncate(params, inputs) {
    return inputs.in.slice(0, toCount(params.count));
  },

  async tail(params, inputs) {
    const n = toCount(params.count);
    return n > 0 ? inputs.in.slice(-n) : [];
  },

  async unique(params, inputs) {
    const field = String(params.field ?? '');
    const seen = new Set();
    const out = [];
    for (const item of inputs.in) {
      const v = getPath(item, field);
      const key = v == null ? '' : String(v);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  },

  async reverse(params, inputs) {
    return inputs.in.slice().reverse();
  },

  async union(params, inputs) {
    return ['in1', 'in2', 'in3', 'in4', 'in5'].flatMap((port) => inputs[port]);
  },

  async count(params, inputs) {
    return [{ count: inputs.in.length }];
  },

  async rename(params, inputs) {
    const rules = asRows(params.rules).map((r) => ({
      from: String(r?.from ?? ''),
      op: r?.op === 'copy' ? 'copy' : 'rename',
      to: String(r?.to ?? ''),
    }));
    return inputs.in.map((item) => {
      const clone = structuredClone(item);
      for (const rule of rules) {
        if (!rule.from || !rule.to) continue;
        const v = getPath(clone, rule.from);
        if (v === undefined) continue;
        setPath(clone, rule.to, v);
        // deleting `from` would undo the set when the target is `from` itself
        // or lives underneath it (e.g. a -> a.b)
        const nested = rule.to === rule.from || rule.to.startsWith(rule.from + '.');
        if (rule.op === 'rename' && !nested) deletePath(clone, rule.from);
      }
      return clone;
    });
  },

  async regex(params, inputs) {
    const rules = asRows(params.rules).map((r) => ({
      field: String(r?.field ?? ''),
      re: new RegExp(String(r?.pattern ?? ''), String(r?.flags ?? '')),
      replace: String(r?.replace ?? ''),
    }));
    return inputs.in.map((item) => {
      const clone = structuredClone(item);
      for (const rule of rules) {
        if (!rule.field) continue;
        const v = getPath(clone, rule.field);
        if (v === undefined) continue; // missing field: skipped, never created
        setPath(clone, rule.field, String(v).replace(rule.re, rule.replace));
      }
      return clone;
    });
  },

  async sub_element(params, inputs) {
    const path = String(params.path ?? '');
    const out = [];
    for (const item of inputs.in) {
      const v = getPath(item, path);
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const el of v) {
          out.push(isPlainObject(el) ? structuredClone(el) : { value: structuredClone(el) });
        }
      } else if (isPlainObject(v)) {
        out.push(structuredClone(v));
      } else {
        out.push({ value: structuredClone(v) });
      }
    }
    return out;
  },

  async output(params, inputs) {
    return inputs.in;
  },
};

// ---------------------------------------------------------------------------
// Template substitution: ${name} -> runtime param -> input-module default -> ""

function substituteDeep(value, resolve) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => resolve(name));
  }
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, resolve));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, resolve);
    return out;
  }
  return value;
}

function buildResolver(modules, runtimeParams) {
  const defaults = new Map();
  for (const m of modules) {
    if (!INPUT_TYPES.has(m?.type)) continue;
    const name = String(m.params?.name ?? '');
    if (name && !defaults.has(name)) defaults.set(name, String(m.params?.default ?? ''));
  }
  return (name) => {
    if (Object.prototype.hasOwnProperty.call(runtimeParams, name)) {
      return String(runtimeParams[name]);
    }
    return defaults.has(name) ? defaults.get(name) : '';
  };
}

// ---------------------------------------------------------------------------
// Validation + topological sort

function portNames(ports) {
  return ports.map((p) => p.name);
}

function validate(modules, wires, byType) {
  const byId = new Map();
  let outputCount = 0;
  for (const m of modules) {
    if (typeof m?.id !== 'string' || m.id === '') throw new PipeError('Module without a valid id');
    if (byId.has(m.id)) throw new PipeError(`Duplicate module id: ${m.id}`);
    if (!byType.has(m.type)) throw new PipeError(`Unknown module type: ${m.type}`);
    byId.set(m.id, m);
    if (m.type === 'output') outputCount++;
  }
  if (outputCount > 1) throw new PipeError('A pipe may contain at most one output module');

  const wireByInput = new Map(); // "moduleId:port" -> wire
  for (const w of wires) {
    const from = w?.from ?? {};
    const to = w?.to ?? {};
    const fromMod = byId.get(from.module);
    if (!fromMod) throw new PipeError(`Wire from unknown module: ${from.module}`);
    if (!portNames(byType.get(fromMod.type).outputs).includes(from.port)) {
      throw new PipeError(`Wire from unknown port: ${from.module}.${from.port}`);
    }
    const toMod = byId.get(to.module);
    if (!toMod) throw new PipeError(`Wire to unknown module: ${to.module}`);
    if (!portNames(byType.get(toMod.type).inputs).includes(to.port)) {
      throw new PipeError(`Wire to unknown port: ${to.module}.${to.port}`);
    }
    const key = `${to.module}:${to.port}`;
    if (wireByInput.has(key)) {
      throw new PipeError(`Input port already wired: ${to.module}.${to.port}`);
    }
    wireByInput.set(key, w);
  }
  return { byId, wireByInput };
}

function topoSort(modules, wires) {
  const indegree = new Map(modules.map((m) => [m.id, 0]));
  const adjacent = new Map(modules.map((m) => [m.id, []]));
  for (const w of wires) {
    adjacent.get(w.from.module).push(w.to.module);
    indegree.set(w.to.module, indegree.get(w.to.module) + 1);
  }
  const queue = modules.filter((m) => indegree.get(m.id) === 0).map((m) => m.id);
  const order = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const next of adjacent.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== modules.length) throw new PipeError('Cycle detected');
  return order;
}

// ---------------------------------------------------------------------------
// Executor

export async function runPipe(pipe, options = {}) {
  const { params: runtimeParams = {}, fetcher = fetchURL, baseUrl, debugLimit = 20 } = options;
  if (!pipe || typeof pipe !== 'object' || !Array.isArray(pipe.modules)) {
    throw new PipeError('Invalid pipe: "modules" must be an array');
  }
  const modules = pipe.modules;
  const wires = Array.isArray(pipe.wires) ? pipe.wires : [];
  const byType = new Map(CATALOG.map((d) => [d.type, d]));

  const resolve = buildResolver(modules, runtimeParams);
  const effectiveParams = new Map(
    modules.map((m) => [m, substituteDeep(m?.params ?? {}, resolve)]),
  );

  const { byId, wireByInput } = validate(modules, wires, byType);
  const order = topoSort(modules, wires);

  const ctx = { fetcher, baseUrl };
  const results = new Map();
  // null-prototype: a module whose id is "__proto__" must get its own debug
  // entry instead of silently reassigning this object's prototype
  const debug = Object.create(null);
  const errors = [];

  for (const id of order) {
    const module = byId.get(id);
    const descriptor = byType.get(module.type);
    const inputs = {};
    for (const port of descriptor.inputs) {
      const wire = wireByInput.get(`${id}:${port.name}`);
      inputs[port.name] = wire ? results.get(wire.from.module) : [];
    }

    const start = performance.now();
    let items = [];
    let errorMessage;
    try {
      items = await evaluators[module.type](effectiveParams.get(module), inputs, ctx);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      errors.push({ module: id, message: errorMessage });
      items = [];
    }
    const ms = Math.round(performance.now() - start);

    results.set(id, items);
    debug[id] = { count: items.length, items: items.slice(0, debugLimit), ms };
    if (errorMessage !== undefined) debug[id].error = errorMessage;
  }

  const outputModule = modules.find((m) => m.type === 'output');
  const items = outputModule ? results.get(outputModule.id) : [];
  return { items, debug, errors };
}
