// lib/feed.js — fetch + RSS/Atom/RDF parsing + RSS 2.0 output builder.
// Zero dependencies; see docs/SPEC.md "Feed library API".

// ---------------------------------------------------------------------------
// XML escaping / entity decoding
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

// Control characters other than tab/LF/CR are outside XML 1.0's Char
// production: emitting even one makes the whole document unparseable, so a
// single poisoned upstream item must not be able to break a published feed.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXml(s) {
  return String(s).replace(XML_ILLEGAL, '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// null-prototype: a lookup of &constructor; or &tostring; must miss, not
// resolve an inherited Object member.
const NAMED_ENTITIES = Object.assign(Object.create(null),
  { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function fromCodePointSafe(code, fallback) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, dec, hex, name) => {
      if (dec !== undefined) return fromCodePointSafe(parseInt(dec, 10), match);
      if (hex !== undefined) return fromCodePointSafe(parseInt(hex, 16), match);
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    }
  );
}

// ---------------------------------------------------------------------------
// Minimal XML parser: tokenize -> element tree
// Node shape: { name (local, prefix stripped), attrs: {}, children: [], text }
// `text` accumulates direct text + CDATA content.
// ---------------------------------------------------------------------------

function localName(rawName) {
  const colon = rawName.lastIndexOf(':');
  return colon === -1 ? rawName : rawName.slice(colon + 1);
}

const WHITESPACE = /\s/;

// Skips <!DOCTYPE ...> (including an internal subset in [ ... ]) and any
// other <! ...> declaration; returns the index just past the closing '>'.
function skipDeclaration(xml, start) {
  let depth = 0;
  for (let i = start + 2; i < xml.length; i++) {
    const c = xml[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return xml.length;
}

// Parses an open tag starting at `start` ('<'). Returns
// { node, next, selfClosing } or null when malformed.
function readOpenTag(xml, start) {
  let i = start + 1;
  let j = i;
  while (j < xml.length && !WHITESPACE.test(xml[j]) && xml[j] !== '/' && xml[j] !== '>') j++;
  const rawName = xml.slice(i, j);
  if (!rawName) return null;
  const node = { name: localName(rawName), attrs: {}, children: [], text: '' };
  i = j;
  while (i < xml.length) {
    while (i < xml.length && WHITESPACE.test(xml[i])) i++;
    if (i >= xml.length) break;
    if (xml[i] === '>') return { node, next: i + 1, selfClosing: false };
    if (xml[i] === '/') {
      const gt = xml.indexOf('>', i);
      return { node, next: gt === -1 ? xml.length : gt + 1, selfClosing: true };
    }
    let k = i;
    while (k < xml.length && !WHITESPACE.test(xml[k]) && xml[k] !== '=' && xml[k] !== '/' && xml[k] !== '>') k++;
    const attrName = xml.slice(i, k);
    if (!attrName) return null;
    i = k;
    while (i < xml.length && WHITESPACE.test(xml[i])) i++;
    let value = '';
    if (xml[i] === '=') {
      i++;
      while (i < xml.length && WHITESPACE.test(xml[i])) i++;
      const quote = xml[i];
      if (quote === '"' || quote === "'") {
        const end = xml.indexOf(quote, i + 1);
        value = decodeEntities(xml.slice(i + 1, end === -1 ? xml.length : end));
        i = end === -1 ? xml.length : end + 1;
      } else {
        let e = i;
        while (e < xml.length && !WHITESPACE.test(xml[e]) && xml[e] !== '>') e++;
        value = decodeEntities(xml.slice(i, e));
        i = e;
      }
    }
    node.attrs[attrName] = value;
  }
  return null;
}

// Returns the root element node, or null when no element was found.
// Throws on malformed tags.
function parseXML(xml) {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  let root = null;
  const stack = [];
  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i);
      const raw = next === -1 ? xml.slice(i) : xml.slice(i, next);
      const parent = stack[stack.length - 1];
      if (parent) parent.text += decodeEntities(raw);
      i = next === -1 ? xml.length : next;
    } else if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      i = end === -1 ? xml.length : end + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      const parent = stack[stack.length - 1];
      if (parent) parent.text += end === -1 ? xml.slice(i + 9) : xml.slice(i + 9, end);
      i = end === -1 ? xml.length : end + 3;
    } else if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      i = end === -1 ? xml.length : end + 2;
    } else if (xml.startsWith('<!', i)) {
      i = skipDeclaration(xml, i);
    } else if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i + 2);
      if (end === -1) break;
      const name = localName(xml.slice(i + 2, end).trim());
      for (let d = stack.length - 1; d >= 0; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      i = end + 1;
    } else {
      const tag = readOpenTag(xml, i);
      if (!tag) throw new Error('Malformed XML');
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(tag.node);
      else if (!root) root = tag.node;
      if (!tag.selfClosing) stack.push(tag.node);
      i = tag.next;
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Element-tree helpers
// ---------------------------------------------------------------------------

function childrenOf(node, name) {
  return node.children.filter((c) => c.name === name);
}

function firstChild(node, name) {
  return node.children.find((c) => c.name === name);
}

function childText(node, name) {
  const c = firstChild(node, name);
  if (!c) return undefined;
  return c.text.trim();
}

function descendants(node, name, out = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

function normalizeDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

// Channel/item <link> text, skipping text-less elements such as <atom:link/>.
function textLink(node) {
  const el = node.children.find((c) => c.name === 'link' && c.text.trim());
  return el ? el.text.trim() : undefined;
}

function parseRSSItem(el) {
  const item = {};
  const title = childText(el, 'title');
  if (title !== undefined) item.title = title;
  const link = textLink(el);
  if (link !== undefined) item.link = link;
  const description = childText(el, 'description') ?? childText(el, 'encoded');
  if (description !== undefined) item.description = description;
  const pubDate = childText(el, 'pubDate') ?? childText(el, 'date');
  if (pubDate !== undefined) item.pubDate = normalizeDate(pubDate);
  const guid = childText(el, 'guid') ?? childText(el, 'id');
  if (guid !== undefined) item.guid = guid;
  const author = childText(el, 'author') ?? childText(el, 'creator');
  if (author !== undefined) item.author = author;
  const categories = childrenOf(el, 'category')
    .map((c) => c.text.trim())
    .filter(Boolean);
  if (categories.length) item.categories = categories;
  return item;
}

// Handles both RSS 2.0 (<rss><channel><item>) and RSS 1.0/RDF
// (<rdf:RDF><channel/><item>): channel metadata from the <channel> element,
// items collected from anywhere under the root.
function parseRSS(root) {
  const channel = descendants(root, 'channel')[0] ?? root;
  return {
    title: childText(channel, 'title') ?? '',
    link: textLink(channel) ?? '',
    description: childText(channel, 'description') ?? '',
    items: descendants(root, 'item').map(parseRSSItem),
  };
}

function atomLink(el) {
  const links = childrenOf(el, 'link');
  const alternate = links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate');
  return (alternate ?? links[0])?.attrs.href;
}

function parseAtomEntry(el) {
  const item = {};
  const title = childText(el, 'title');
  if (title !== undefined) item.title = title;
  const link = atomLink(el);
  if (link !== undefined) item.link = link;
  const description = childText(el, 'content') ?? childText(el, 'summary');
  if (description !== undefined) item.description = description;
  const pubDate = childText(el, 'updated') ?? childText(el, 'published') ?? childText(el, 'date');
  if (pubDate !== undefined) item.pubDate = normalizeDate(pubDate);
  const guid = childText(el, 'id');
  if (guid !== undefined) item.guid = guid;
  const authorEl = firstChild(el, 'author');
  const author = (authorEl && (childText(authorEl, 'name') || authorEl.text.trim())) || childText(el, 'creator');
  if (author) item.author = author;
  const categories = childrenOf(el, 'category')
    .map((c) => c.attrs.term || c.attrs.label || c.text.trim())
    .filter(Boolean);
  if (categories.length) item.categories = categories;
  return item;
}

function parseAtom(root) {
  return {
    title: childText(root, 'title') ?? '',
    link: atomLink(root) ?? '',
    description: childText(root, 'subtitle') ?? '',
    items: childrenOf(root, 'entry').map(parseAtomEntry),
  };
}

export function parseFeed(xmlString) {
  let root = null;
  try {
    root = parseXML(String(xmlString));
  } catch {
    root = null;
  }
  if (root) {
    if (root.name === 'rss' || root.name === 'RDF') return parseRSS(root);
    if (root.name === 'feed') return parseAtom(root);
  }
  throw new Error('Not a recognized feed format');
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// A peer can omit content-length (chunked) and stream far more than it
// declared, so decode incrementally and abort as soon as the cap is passed
// instead of buffering the whole body first.
async function readCapped(res, maxBytes, resolved) {
  if (!res.body) return '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response exceeds ${maxBytes} bytes: ${resolved}`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

export async function fetchURL(url, { timeoutMs = 15000, maxBytes = 5_000_000, baseUrl } = {}) {
  let resolved;
  try {
    resolved = new URL(url);
  } catch {
    if (!baseUrl) throw new Error(`Relative URL "${url}" requires a baseUrl`);
    resolved = new URL(url, baseUrl);
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${resolved.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(resolved, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'OpenPipes/0.1' },
    });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes: ${resolved}`);
    }
    const headers = {};
    for (const [key, value] of res.headers) headers[key.toLowerCase()] = value;
    return { status: res.status, headers, text: await readCapped(res, maxBytes, resolved) };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs} ms: ${resolved}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// RSS 2.0 output
// ---------------------------------------------------------------------------

function rfc822Date(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? String(value) : new Date(t).toUTCString();
}

function buildItemXML(item) {
  const parts = ['<item>'];
  const tag = (name, value) => {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`<${name}>${escapeXml(value)}</${name}>`);
    }
  };
  tag('title', item.title);
  tag('link', item.link);
  tag('description', item.description);
  if (item.pubDate !== undefined && item.pubDate !== null && item.pubDate !== '') {
    tag('pubDate', rfc822Date(item.pubDate));
  }
  if (item.guid !== undefined && item.guid !== null && item.guid !== '') {
    const guid = String(item.guid);
    const permalink = /^https?:\/\//i.test(guid) ? '' : ' isPermaLink="false"';
    parts.push(`<guid${permalink}>${escapeXml(guid)}</guid>`);
  }
  tag('author', item.author);
  if (Array.isArray(item.categories)) {
    for (const category of item.categories) tag('category', category);
  }
  parts.push('</item>');
  return parts.join('\n');
}

export function buildRSS({ title, link, description, items } = {}) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${escapeXml(title ?? '')}</title>`,
    `<link>${escapeXml(link ?? '')}</link>`,
    `<description>${escapeXml(description ?? '')}</description>`,
  ];
  if (link) {
    lines.push(`<atom:link href="${escapeXml(link)}" rel="self" type="application/rss+xml"/>`);
  }
  for (const item of Array.isArray(items) ? items : []) {
    lines.push(buildItemXML(item));
  }
  lines.push('</channel>', '</rss>');
  return lines.join('\n');
}
