// lib/html.js — a tolerant HTML parser and a small CSS selector engine, for
// the Fetch Page module. Zero dependencies; see docs/SPEC.md.
//
// Real pages are not XML: tags are unclosed, attributes unquoted, <script>
// contains anything. The XML parser in feed.js would give up on all of that,
// so this one recovers instead of throwing.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Content is text, not markup, until the matching close tag.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

// Opening one of these implicitly closes the tags listed with it, which is how
// <li>a<li>b and <p>one<p>two are meant to be read.
const IMPLIED_CLOSE = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['optgroup', 'option'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  p: ['p'],
};
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

const NAMED = Object.assign(Object.create(null), {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
});

function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, dec, hex, name) => {
      try {
        if (dec !== undefined) return String.fromCodePoint(Number(dec));
        if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      } catch { return match; }
      return NAMED[name.toLowerCase()] ?? match;
    });
}

function element(tag) {
  return { type: 'element', tag, attrs: Object.create(null), children: [], parent: null };
}

function appendTo(parent, node) {
  node.parent = parent;
  parent.children.push(node);
}

// Reads the attributes of an open tag starting just past the tag name.
// Returns { attrs, next, selfClosing }.
function readAttrs(html, i) {
  const attrs = Object.create(null);
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) break;
    if (html[i] === '>') return { attrs, next: i + 1, selfClosing: false };
    if (html[i] === '/' && html[i + 1] === '>') return { attrs, next: i + 2, selfClosing: true };

    let k = i;
    while (k < html.length && !/[\s=/>]/.test(html[k])) k++;
    if (k === i) { i++; continue; } // a stray character; skip it
    const name = html.slice(i, k).toLowerCase();
    i = k;
    while (i < html.length && /\s/.test(html[i])) i++;

    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        value = decode(html.slice(i + 1, end === -1 ? html.length : end));
        i = end === -1 ? html.length : end + 1;
      } else {
        let e = i;
        while (e < html.length && !/[\s>]/.test(html[e])) e++;
        value = decode(html.slice(i, e));
        i = e;
      }
    }
    if (!(name in attrs)) attrs[name] = value; // first wins, as browsers do
  }
  return { attrs, next: i, selfClosing: false };
}

export function parseHTML(html) {
  const root = element('#document');
  const stack = [root];
  const open = () => stack[stack.length - 1];
  const popTo = (tag) => {
    for (let d = stack.length - 1; d > 0; d--) {
      if (stack[d].tag === tag) {
        stack.length = d;
        return true;
      }
    }
    return false; // a close tag with nothing to close: ignore it
  };

  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const text = next === -1 ? html.slice(i) : html.slice(i, next);
      if (text.trim()) appendTo(open(), { type: 'text', text: decode(text) });
      else if (text) appendTo(open(), { type: 'text', text: ' ' }); // keep word gaps
      i = next === -1 ? html.length : next;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i + 2);
      const tag = html.slice(i + 2, end === -1 ? html.length : end).trim().toLowerCase();
      if (tag) popTo(tag);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    let k = i + 1;
    while (k < html.length && !/[\s/>]/.test(html[k])) k++;
    const tag = html.slice(i + 1, k).toLowerCase();
    if (!tag) { // a bare '<' in text
      appendTo(open(), { type: 'text', text: '<' });
      i++;
      continue;
    }

    const closes = IMPLIED_CLOSE[tag] || [];
    if (closes.includes(open().tag)) stack.pop();
    if (CLOSES_P.has(tag) && open().tag === 'p') stack.pop();

    const { attrs, next, selfClosing } = readAttrs(html, k);
    const node = element(tag);
    node.attrs = attrs;
    appendTo(open(), node);
    i = next;

    if (selfClosing || VOID_TAGS.has(tag)) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const text = html.slice(i, close === -1 ? html.length : close);
      if (text) appendTo(node, { type: 'text', text: tag === 'title' ? decode(text) : text });
      if (close === -1) { i = html.length; continue; }
      const end = html.indexOf('>', close);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    stack.push(node);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Reading values out of the tree

export function textOf(node) {
  if (node.type === 'text') return node.text;
  let out = '';
  for (const c of node.children) out += textOf(c);
  return out;
}

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function serialize(node) {
  if (node.type === 'text') return node.text.replace(/[&<>]/g, (c) => ESCAPE[c]);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${String(v).replace(/[&<>"]/g, (c) => ESCAPE[c])}"`).join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${innerHTML(node)}</${node.tag}>`;
}

export function innerHTML(node) {
  return node.children.map(serialize).join('');
}

// ---------------------------------------------------------------------------
// Selectors: tag, .class, #id, [attr], [attr=v], [attr^=v], [attr$=v],
// [attr*=v], descendant and > combinators, and comma-separated groups.

function parseCompound(text) {
  const part = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([.#]?[\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*("[^"]*"|'[^']*'|[^\]]*?)\s*)?\]|\*/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(text))) {
    // the matches must tile the string: a gap means something we do not
    // understand, like `a:hover`, and guessing would silently select wrongly
    if (m.index !== consumed) break;
    consumed = re.lastIndex;
    if (m[0] === '*') continue;
    if (m[1]) {
      if (m[1][0] === '.') part.classes.push(m[1].slice(1));
      else if (m[1][0] === '#') part.id = m[1].slice(1);
      else part.tag = m[1].toLowerCase();
    } else if (m[2]) {
      let value = m[4];
      if (value && /^["']/.test(value)) value = value.slice(1, -1);
      part.attrs.push({ name: m[2].toLowerCase(), op: m[3] || null, value: value ?? '' });
    }
  }
  if (consumed !== text.length) throw new Error(`Unsupported selector: ${text}`);
  return part;
}

// "a > b c" -> [{compound a, combinator '>'}, {compound b, combinator ' '}, {compound c}]
function parseComplex(text) {
  const tokens = text.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  const steps = [];
  let combinator = null;
  for (const token of tokens) {
    if (token === '>') { combinator = '>'; continue; }
    steps.push({ compound: parseCompound(token), combinator });
    combinator = ' ';
  }
  if (!steps.length) throw new Error('Empty selector');
  return steps;
}

function parseSelector(selector) {
  return String(selector).split(',').map((s) => s.trim()).filter(Boolean).map(parseComplex);
}

function classesOf(node) {
  return String(node.attrs.class || '').split(/\s+/).filter(Boolean);
}

function matchesCompound(node, part) {
  if (node.type !== 'element') return false;
  if (part.tag && node.tag !== part.tag) return false;
  if (part.id && node.attrs.id !== part.id) return false;
  if (part.classes.length) {
    const have = classesOf(node);
    if (!part.classes.every((c) => have.includes(c))) return false;
  }
  for (const a of part.attrs) {
    const v = node.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '|=' && v !== a.value && !v.startsWith(a.value + '-')) return false;
  }
  return true;
}

// Right to left: cheaper, because the rightmost step rejects most candidates.
function matchesComplex(node, steps, scope) {
  if (!matchesCompound(node, steps[steps.length - 1].compound)) return false;
  let current = node;
  for (let i = steps.length - 1; i > 0; i--) {
    const { combinator } = steps[i];
    const want = steps[i - 1].compound;
    if (combinator === '>') {
      current = current.parent;
      if (!current || current === scope.parent || !matchesCompound(current, want)) return false;
    } else {
      let up = current.parent;
      while (up && up !== scope.parent && !matchesCompound(up, want)) up = up.parent;
      if (!up || up === scope.parent) return false;
      current = up;
    }
  }
  return true;
}

function descendants(node, out = []) {
  for (const c of node.children) {
    if (c.type !== 'element') continue;
    out.push(c);
    descendants(c, out);
  }
  return out;
}

export function queryAll(scope, selector) {
  const groups = parseSelector(selector);
  if (!groups.length) return [];
  return descendants(scope).filter((n) => groups.some((steps) => matchesComplex(n, steps, scope)));
}

export function queryOne(scope, selector) {
  return queryAll(scope, selector)[0] || null;
}
