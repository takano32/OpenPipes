// OpenPipes engine: module catalog + pipe executor. See docs/SPEC.md.

import { decodeEntities, fetchURL, parseFeed } from './feed.js';
import { innerHTML, parseHTML, queryAll, queryOne, textOf } from './html.js';

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
    type: 'fetch_page',
    name: 'Fetch Page',
    category: 'Sources',
    description: 'Scrape a web page with CSS selectors',
    inputs: [],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'url', label: 'URL', kind: 'text', default: '' },
      { name: 'item', label: 'Item selector', kind: 'text', default: '', placeholder: 'article.post' },
      {
        name: 'fields', label: 'Fields', kind: 'rules',
        fields: [
          { name: 'name', kind: 'text', placeholder: 'title' },
          { name: 'selector', kind: 'text', placeholder: 'h2 a' },
          { name: 'attr', kind: 'text', placeholder: 'text' },
        ],
        default: [{ name: 'title', selector: '', attr: 'text' }],
      },
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
    type: 'string_builder',
    name: 'String Builder',
    category: 'Operators',
    description: 'Join parts into one field; {path} inserts a field of the item',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'parts', label: 'Parts', kind: 'list', default: [''] },
      { name: 'to', label: 'Write to', kind: 'text', default: 'title' },
    ],
  },
  {
    type: 'date_builder',
    name: 'Date Builder',
    category: 'Operators',
    description: 'Reformat a date field',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'field', label: 'Field', kind: 'text', default: 'pubDate' },
      {
        name: 'format', label: 'Format', kind: 'select',
        options: ['iso', 'rfc822', 'date', 'datetime', 'epoch'], default: 'iso',
      },
      { name: 'to', label: 'Write to', kind: 'text', default: 'pubDate' },
    ],
  },
  {
    type: 'url_builder',
    name: 'URL Builder',
    category: 'Operators',
    description: 'Build a URL with query parameters; {path} inserts a field',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'base', label: 'Base URL', kind: 'text', default: '', placeholder: 'https://example.com/search' },
      {
        name: 'query', label: 'Query', kind: 'rules',
        fields: [
          { name: 'name', kind: 'text', placeholder: 'q' },
          { name: 'value', kind: 'text', placeholder: '{title}' },
        ],
        default: [{ name: '', value: '' }],
      },
      { name: 'to', label: 'Write to', kind: 'text', default: 'link' },
    ],
  },
  {
    type: 'term_extractor',
    name: 'Term Extractor',
    category: 'Operators',
    description: 'Pull the most distinctive words out of a field',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'field', label: 'Field', kind: 'text', default: 'description' },
      { name: 'to', label: 'Write to', kind: 'text', default: 'terms' },
      { name: 'count', label: 'How many', kind: 'number', min: 1, default: 5 },
    ],
  },
  {
    type: 'loop',
    name: 'Loop',
    category: 'Operators',
    description: 'Run a saved pipe once per item, with the item as its parameters',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'pipe', label: 'Pipe id', kind: 'text', default: '', placeholder: 'demo-tech-filter' },
      { name: 'mode', label: 'Mode', kind: 'select', options: ['replace', 'assign'], default: 'replace' },
      { name: 'to', label: 'Assign to', kind: 'text', default: 'items' },
      { name: 'limit', label: 'Max items', kind: 'number', min: 1, default: 20 },
    ],
  },
  {
    type: 'strip_html',
    name: 'Strip HTML',
    category: 'Operators',
    description: 'Remove markup and decode entities in the given fields',
    inputs: [{ name: 'in' }],
    outputs: [{ name: 'out' }],
    params: [
      { name: 'fields', label: 'Fields', kind: 'list', default: ['description'] },
    ],
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

// `{a.b}` inserts a field of the item being processed. Distinct from the
// engine's `${name}`, which is a pipe parameter substituted once before the
// run; this one varies per item. `{{` and `}}` are literal braces.
function interpolate(template, item) {
  return String(template ?? '').replace(/\{\{|\}\}|\{([^{}]*)\}/g, (match, path) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    const v = getPath(item, path.trim());
    return v === undefined || v === null ? '' : String(v);
  });
}

function formatDate(value, format) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  switch (format) {
    case 'rfc822': return d.toUTCString();
    case 'date': return d.toISOString().slice(0, 10);
    case 'datetime': return d.toISOString().slice(0, 19).replace('T', ' ');
    case 'epoch': return t;
    default: return d.toISOString();
  }
}

const MAX_LOOP_DEPTH = 3;

// A looped item reaches its sub-pipe as parameters, so `${link}` inside the
// sub-pipe means "this item's link". Only top-level scalars: a `${...}`
// placeholder can only ever produce a string anyway.
function itemParams(item) {
  const params = {};
  if (!item || typeof item !== 'object') return params;
  for (const [k, v] of Object.entries(item)) {
    if (v === null || typeof v === 'object') continue;
    params[k] = String(v);
  }
  return params;
}

// A short stopword list rather than a real one: the aim is to drop the words
// every feed item has, not to do linguistics.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'was', 'were', 'are', 'been', 'being', 'its', 'it', 'they', 'them', 'their',
  'you', 'your', 'our', 'ours', 'but', 'not', 'all', 'any', 'can', 'will',
  'would', 'could', 'should', 'may', 'might', 'more', 'most', 'other', 'into',
  'over', 'after', 'before', 'than', 'then', 'when', 'where', 'which', 'who',
  'what', 'how', 'why', 'about', 'said', 'says', 'new', 'one', 'two', 'also',
  'out', 'up', 'off', 'on', 'in', 'of', 'to', 'at', 'by', 'as', 'is', 'be',
  'する', 'した', 'して', 'ある', 'いる', 'これ', 'それ', 'その', 'この',
  'ため', 'こと', 'もの', 'よう', 'および', 'または', 'ます', 'です',
]);

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
// Hiragana is where the grammar lives — particles, inflections, auxiliaries.
// Cutting a Japanese run on it leaves the kanji and katakana compounds, which
// is what someone scanning a feed is actually looking for.
const HIRAGANA_RUN = /[\u3040-\u309f\u30fb\u3005]+/u;

function extractTerms(text, count) {
  const plain = stripHtml(text).toLowerCase();
  const counts = new Map();
  const bump = (term) => counts.set(term, (counts.get(term) || 0) + 1);

  for (const token of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    if (CJK.test(token)) {
      for (const run of token.split(HIRAGANA_RUN)) {
        if (run.length < 2 || STOPWORDS.has(run)) continue;
        bump(run);
      }
      continue;
    }
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    bump(token);
  }

  return [...counts.entries()]
    // by frequency, then by length: a longer word said as often says more
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([term]) => term);
}

function stripHtml(s) {
  return decodeEntities(
    String(s)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>|<\/p\s*>|<\/div\s*>|<\/li\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  ).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function toCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The page's own URL, so href="/two" on it becomes an absolute link.
function absoluteBase(url, baseUrl) {
  try {
    return new URL(url, baseUrl || undefined).href;
  } catch {
    return baseUrl || undefined;
  }
}

// `attr` is "text", "html", or the name of an attribute. Link-bearing
// attributes are resolved against the page they were found on, since a
// republished feed is read somewhere else entirely.
const URL_ATTRS = new Set(['href', 'src', 'poster', 'data-src']);

function extractFrom(node, attr, base) {
  if (attr === 'text') return textOf(node).replace(/\s+/g, ' ').trim();
  if (attr === 'html') return innerHTML(node).trim();
  const raw = node.attrs?.[attr.toLowerCase()];
  if (raw === undefined) return undefined;
  if (!URL_ATTRS.has(attr.toLowerCase()) || !base) return raw;
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

async function fetchText(url, ctx) {
  const res = await ctx.fetcher(url, { baseUrl: ctx.baseUrl, allowPrivate: ctx.allowPrivate });
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

  async fetch_page(params, inputs, ctx) {
    const url = String(params.url ?? '').trim();
    if (!url) return [];
    const rows = asRows(params.fields)
      .map((r) => ({
        name: String(r?.name ?? '').trim(),
        selector: String(r?.selector ?? '').trim(),
        attr: String(r?.attr ?? '').trim() || 'text',
      }))
      .filter((r) => r.name);

    const html = await fetchText(url, ctx);
    const doc = parseHTML(html);
    const base = absoluteBase(url, ctx.baseUrl);
    const itemSelector = String(params.item ?? '').trim();
    // no item selector: the page itself is the one item
    const scopes = itemSelector ? queryAll(doc, itemSelector) : [doc];

    return scopes.map((scope) => {
      const item = {};
      for (const row of rows) {
        const node = row.selector ? queryOne(scope, row.selector) : scope;
        if (!node) continue;
        const value = extractFrom(node, row.attr, base);
        if (value !== undefined) setPath(item, row.name, value);
      }
      return item;
    });
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

  async string_builder(params, inputs) {
    const parts = (Array.isArray(params.parts) ? params.parts : []).map((p) => String(p ?? ''));
    const to = String(params.to ?? '');
    if (!to) return inputs.in;
    return inputs.in.map((item) => {
      const clone = structuredClone(item);
      setPath(clone, to, parts.map((p) => interpolate(p, item)).join(''));
      return clone;
    });
  },

  async date_builder(params, inputs) {
    const field = String(params.field ?? '');
    const to = String(params.to ?? '') || field;
    const format = String(params.format ?? 'iso');
    if (!field || !to) return inputs.in;
    return inputs.in.map((item) => {
      const formatted = formatDate(getPath(item, field), format);
      if (formatted === undefined) return item; // leave unparseable dates alone
      const clone = structuredClone(item);
      setPath(clone, to, formatted);
      return clone;
    });
  },

  async url_builder(params, inputs) {
    const base = String(params.base ?? '');
    const to = String(params.to ?? '');
    const query = asRows(params.query).map((r) => ({
      name: String(r?.name ?? ''),
      value: String(r?.value ?? ''),
    }));
    if (!base || !to) return inputs.in;
    return inputs.in.map((item) => {
      const url = interpolate(base, item);
      const pairs = [];
      for (const q of query) {
        const name = interpolate(q.name, item);
        const value = interpolate(q.value, item);
        // an empty value means the item had nothing to say, not "send blank"
        if (!name || value === '') continue;
        pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
      }
      const joined = pairs.length
        ? url + (url.includes('?') ? '&' : '?') + pairs.join('&')
        : url;
      const clone = structuredClone(item);
      setPath(clone, to, joined);
      return clone;
    });
  },

  async loop(params, inputs, ctx) {
    const id = String(params.pipe ?? '').trim();
    if (!id) return inputs.in;
    if (!ctx.loadPipe) throw new Error('Loop is not available here (no pipe loader)');
    if (ctx.depth >= MAX_LOOP_DEPTH) {
      throw new Error(`Loop nested deeper than ${MAX_LOOP_DEPTH} levels`);
    }
    if (ctx.running.has(id)) throw new Error(`Loop: pipe "${id}" is already running`);

    const mode = params.mode === 'assign' ? 'assign' : 'replace';
    const to = String(params.to ?? '') || 'items';
    const limit = Math.max(1, toCount(params.limit) || 20);

    const source = inputs.in.slice(0, limit);
    if (inputs.in.length > source.length) {
      ctx.report(`Loop stopped after ${limit} of ${inputs.in.length} items (raise "Max items")`);
    }

    const sub = await ctx.loadPipe(id);
    const running = new Set(ctx.running).add(id);
    let reported = 0;

    // A sub-pipe usually fetches, so run a few at a time rather than serially.
    const out = new Array(source.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < source.length; i = next++) {
        const item = source[i];
        try {
          const result = await runPipe(sub, {
            fetcher: ctx.fetcher,
            baseUrl: ctx.baseUrl,
            allowPrivate: ctx.allowPrivate,
            loadPipe: ctx.loadPipe,
            depth: ctx.depth + 1,
            running,
            debugLimit: 0,
            params: { ...ctx.params, ...itemParams(item) },
          });
          // a failure inside the sub-pipe would otherwise be invisible here:
          // the run "succeeds" and simply yields nothing
          for (const e of result.errors) {
            if (reported++ >= 5) break;
            ctx.report(`Loop item ${i + 1} (${e.module}): ${e.message}`);
          }
          if (mode === 'assign') {
            const clone = structuredClone(item);
            setPath(clone, to, result.items);
            out[i] = [clone];
          } else {
            out[i] = result.items;
          }
        } catch (err) {
          out[i] = [];
          if (reported++ < 5) {
            ctx.report(`Loop item ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, source.length) }, worker));
    return out.flatMap((chunk) => chunk ?? []);
  },

  async term_extractor(params, inputs) {
    const field = String(params.field ?? '');
    const to = String(params.to ?? '') || 'terms';
    const count = Math.max(1, toCount(params.count) || 5);
    if (!field) return inputs.in;
    return inputs.in.map((item) => {
      const value = getPath(item, field);
      if (value === undefined || value === null) return item;
      const clone = structuredClone(item);
      setPath(clone, to, extractTerms(String(value), count));
      return clone;
    });
  },

  async strip_html(params, inputs) {
    const fields = (Array.isArray(params.fields) ? params.fields : [])
      .map((f) => String(f ?? '')).filter(Boolean);
    if (!fields.length) return inputs.in;
    return inputs.in.map((item) => {
      const clone = structuredClone(item);
      for (const field of fields) {
        const v = getPath(clone, field);
        if (v === undefined || v === null) continue;
        setPath(clone, field, stripHtml(v));
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
  const {
    params: runtimeParams = {}, fetcher = fetchURL, baseUrl, debugLimit = 20,
    loadPipe, depth = 0, running = new Set(), allowPrivate = false,
  } = options;
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

  const ctx = { fetcher, baseUrl, loadPipe, depth, running, allowPrivate, params: runtimeParams };
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
      const report = (message) => errors.push({ module: id, message });
      items = await evaluators[module.type](effectiveParams.get(module), inputs, { ...ctx, report });
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
