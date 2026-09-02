// OpenPipes test suite — dependency-free, no network (all fetches are canned).
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as nodeCryptoSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFeed, buildRSS, buildJSONFeed, escapeXml } from '../lib/feed.js';
import { runPipe, catalog, PipeError } from '../lib/engine.js';
import { openStore, slugify, validatePipeBody } from '../lib/store.js';
import {
  createPkce, decodeJwt, matchesAllowlist, parseAllowlist, parseCookies,
  safeReturnTo, secretEquals, serializeCookie, verifyIdToken,
} from '../lib/auth.js';

// ---------------------------------------------------------------- harness

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------- canned feeds

const RSS2_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Sample &amp; Feed</title>
    <link>http://example.com/</link>
    <description>channel description</description>
    <!-- a comment the parser must skip -->
    <item>
      <title><![CDATA[Tom & Jerry <3]]></title>
      <link>http://example.com/1</link>
      <description>A &quot;quoted&quot; &amp; fine &#233; story&#x21;</description>
      <dc:creator>Alice</dc:creator>
      <category>Cartoons</category>
      <category>Classic</category>
      <guid>http://example.com/1</guid>
      <pubDate>Tue, 28 Jul 2026 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Second</title>
      <pubDate>not a date</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Sample</title>
  <link rel="self" href="http://example.com/feed.atom"/>
  <link rel="alternate" href="http://example.com/"/>
  <entry>
    <title>Entry One</title>
    <link rel="alternate" href="http://example.com/e1"/>
    <id>tag:example.com,2026:e1</id>
    <updated>2026-07-27T12:00:00Z</updated>
    <summary>Summary text</summary>
  </entry>
  <entry>
    <title>Entry Two</title>
    <link href="http://example.com/e2"/>
    <id>tag:example.com,2026:e2</id>
    <published>2026-07-26T08:00:00Z</published>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF_SAMPLE = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="http://example.com/">
    <title>RDF Sample</title>
    <link>http://example.com/</link>
    <description>rdf channel</description>
  </channel>
  <item rdf:about="http://example.com/r1">
    <title>RDF Item</title>
    <link>http://example.com/r1</link>
    <description>rdf item description</description>
    <dc:creator>Carol</dc:creator>
    <dc:date>2026-07-25T10:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

const TECH_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fake Tech News</title>
    <link>http://fake/tech</link>
    <description>canned tech feed</description>
    <item><title>New AI regulation draft</title><link>http://fake/tech/1</link><guid>http://fake/tech/1</guid><pubDate>Mon, 27 Jul 2026 09:00:00 GMT</pubDate></item>
    <item><title>AI beats benchmark</title><link>http://fake/tech/2</link><guid>http://fake/tech/2</guid><pubDate>Wed, 29 Jul 2026 09:00:00 GMT</pubDate></item>
    <item><title>Rust 2.0 released</title><link>http://fake/tech/3</link><guid>http://fake/tech/3</guid><pubDate>Tue, 28 Jul 2026 09:00:00 GMT</pubDate></item>
    <item><title>AI assistant for farmers</title><link>http://fake/tech/4</link><guid>http://fake/tech/4</guid><pubDate>Sat, 25 Jul 2026 09:00:00 GMT</pubDate></item>
    <item><title>Linux kernel update</title><link>http://fake/tech/5</link><guid>http://fake/tech/5</guid><pubDate>Sun, 26 Jul 2026 09:00:00 GMT</pubDate></item>
    <item><title>Quantum leap</title><link>http://fake/tech/6</link><guid>http://fake/tech/6</guid><pubDate>Fri, 24 Jul 2026 09:00:00 GMT</pubDate></item>
  </channel>
</rss>`;

const WORLD_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fake World News</title>
    <link>http://fake/world</link>
    <description>canned world feed</description>
    <item><title>Heatwave continues</title><link>http://fake/world/1</link><guid>http://fake/world/1</guid><pubDate>Tue, 28 Jul 2026 06:00:00 GMT</pubDate></item>
    <item><title>Markets rally</title><link>http://fake/world/2</link><guid>http://fake/world/2</guid><pubDate>Mon, 27 Jul 2026 06:00:00 GMT</pubDate></item>
  </channel>
</rss>`;

// ---------------------------------------------------------------- fake fetcher

const CANNED = {
  'http://fake/tech.xml': TECH_RSS,
  'http://fake/world.xml': WORLD_RSS,
  'http://fake/data.json':
    '{"data":{"items":[{"title":"j1"},{"title":"j2"}],"obj":{"title":"only"},"nums":[1,2,3]}}',
};

const fetcher = async (url) => {
  if (!(url in CANNED)) throw new Error('No canned response for ' + url);
  return { status: 200, headers: {}, text: CANNED[url] };
};

// ---------------------------------------------------------------- pipe builders

let autoUrl = 0;
function jsonSource(value) {
  const url = `http://fake/auto-${++autoUrl}.json`;
  CANNED[url] = JSON.stringify(value);
  return url;
}

function mod(id, type, params = {}) {
  return { id, type, params, x: 0, y: 0 };
}

function wire(from, to, port = 'in') {
  return { id: `w-${from}-${to}`, from: { module: from, port: 'out' }, to: { module: to, port } };
}

// source -> ops[0] -> ... -> ops[n-1] -> output
function chain(source, ops) {
  const modules = [source];
  const wires = [];
  let prev = source.id;
  ops.forEach((op, i) => {
    modules.push(op);
    wires.push({ id: `w${i + 1}`, from: { module: prev, port: 'out' }, to: { module: op.id, port: 'in' } });
    prev = op.id;
  });
  modules.push(mod('sink', 'output'));
  wires.push({ id: 'wsink', from: { module: prev, port: 'out' }, to: { module: 'sink', port: 'in' } });
  return { name: 'test pipe', modules, wires };
}

async function runOps(items, ops, params) {
  const source = mod('src', 'fetch_json', { url: jsonSource(items), path: '' });
  return runPipe(chain(source, ops), { fetcher, params });
}

function titles(items) {
  return items.map((it) => it.title);
}

// ---------------------------------------------------------------- feed.js tests

test('parseFeed: RSS 2.0 with CDATA, entities, dc:creator, categories, guid', () => {
  const feed = parseFeed(RSS2_SAMPLE);
  assert.equal(feed.title, 'Sample & Feed');
  assert.equal(feed.items.length, 2);
  const it = feed.items[0];
  assert.equal(it.title, 'Tom & Jerry <3');
  assert.equal(it.description, 'A "quoted" & fine é story!');
  assert.equal(it.author, 'Alice');
  assert.deepEqual(it.categories, ['Cartoons', 'Classic']);
  assert.equal(it.guid, 'http://example.com/1');
});

test('parseFeed: RSS 2.0 pubDate normalized to ISO, raw kept when unparseable', () => {
  const feed = parseFeed(RSS2_SAMPLE);
  assert.equal(feed.items[0].pubDate, new Date('Tue, 28 Jul 2026 09:30:00 GMT').toISOString());
  assert.equal(feed.items[1].pubDate, 'not a date');
});

test('parseFeed: Atom links, summary/content -> description, dates -> pubDate', () => {
  const feed = parseFeed(ATOM_SAMPLE);
  assert.equal(feed.title, 'Atom Sample');
  assert.equal(feed.items.length, 2);
  const [e1, e2] = feed.items;
  assert.equal(e1.title, 'Entry One');
  assert.equal(e1.link, 'http://example.com/e1');
  assert.equal(e1.description, 'Summary text');
  assert.equal(e1.pubDate, new Date('2026-07-27T12:00:00Z').toISOString());
  assert.equal(e2.link, 'http://example.com/e2');
  assert.equal(e2.description, '<p>Body</p>');
  assert.equal(e2.pubDate, new Date('2026-07-26T08:00:00Z').toISOString());
});

test('parseFeed: RDF items with dc:creator and dc:date', () => {
  const feed = parseFeed(RDF_SAMPLE);
  assert.equal(feed.title, 'RDF Sample');
  assert.equal(feed.items.length, 1);
  const it = feed.items[0];
  assert.equal(it.title, 'RDF Item');
  assert.equal(it.link, 'http://example.com/r1');
  assert.equal(it.author, 'Carol');
  assert.equal(it.pubDate, new Date('2026-07-25T10:00:00Z').toISOString());
});

test('parseFeed: rejects non-feed input', () => {
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /Not a recognized feed format/);
});

test('buildRSS: escapes XML special characters everywhere', () => {
  const xml = buildRSS({
    title: 'T <&> news',
    link: 'http://example.com/?a=1&b=2',
    description: 'd',
    items: [{ title: 'A & B <ok>', link: 'http://e/1', description: '<b>hi</b>', guid: 'g1', pubDate: '2026-07-28T09:30:00.000Z' }],
  });
  assert.ok(xml.includes('T &lt;&amp;&gt; news'));
  assert.ok(xml.includes('A &amp; B &lt;ok&gt;'));
  assert.ok(xml.includes('&lt;b&gt;hi&lt;/b&gt;'));
  assert.ok(!xml.includes('<b>hi</b>'));
  assert.ok(xml.includes('a=1&amp;b=2'));
});

test('buildRSS: RFC 822 pubDate, guid, atom:link self', () => {
  const xml = buildRSS({
    title: 't',
    link: 'http://example.com/pipe',
    description: 'd',
    items: [{ title: 'x', link: 'http://e/1', description: '', guid: 'g1', pubDate: '2026-07-28T09:30:00.000Z' }],
  });
  assert.ok(xml.includes(new Date('2026-07-28T09:30:00.000Z').toUTCString()));
  assert.ok(xml.includes('<guid'));
  assert.ok(xml.includes('g1'));
  assert.ok(xml.includes('atom:link'));
});

// ---------------------------------------------------------------- catalog

test('catalog: all 25 module types with expected port layout', () => {
  const cat = catalog();
  assert.deepEqual(
    cat.map((d) => d.type).sort(),
    ['count', 'date_builder', 'fetch_feed', 'fetch_json', 'fetch_page', 'filter',
      'item_builder', 'loop', 'number_input', 'output', 'regex', 'rename', 'reverse',
      'sort', 'string_builder', 'strip_html', 'sub_element', 'tail', 'term_extractor',
      'text_input', 'truncate', 'union', 'unique', 'url_builder', 'url_input'],
  );
  const filter = cat.find((d) => d.type === 'filter');
  assert.deepEqual(filter.inputs.map((p) => p.name), ['in']);
  assert.deepEqual(filter.outputs.map((p) => p.name), ['out']);
  const rules = filter.params.find((p) => p.name === 'rules');
  assert.equal(rules.kind, 'rules');
  assert.deepEqual(rules.fields.map((f) => f.name), ['field', 'op', 'value']);
  const union = cat.find((d) => d.type === 'union');
  assert.deepEqual(union.inputs.map((p) => p.name), ['in1', 'in2', 'in3', 'in4', 'in5']);
  const output = cat.find((d) => d.type === 'output');
  assert.deepEqual(output.inputs.map((p) => p.name), ['in']);
  assert.equal(output.outputs.length, 0);
});

// ---------------------------------------------------------------- sources

test('fetch_feed: concatenates URL order, sets source to feed title', async () => {
  const pipe = chain(mod('src', 'fetch_feed', { urls: ['http://fake/tech.xml', 'http://fake/world.xml'] }), []);
  const { items, errors } = await runPipe(pipe, { fetcher });
  assert.deepEqual(errors, []);
  assert.equal(items.length, 8);
  assert.equal(items[0].title, 'New AI regulation draft');
  assert.equal(items[0].source, 'Fake Tech News');
  assert.equal(items[6].title, 'Heatwave continues');
  assert.equal(items[6].source, 'Fake World News');
});

test('fetch_json: dotted path extracts array of objects', async () => {
  const pipe = chain(mod('src', 'fetch_json', { url: 'http://fake/data.json', path: 'data.items' }), []);
  const { items } = await runPipe(pipe, { fetcher });
  assert.deepEqual(titles(items), ['j1', 'j2']);
});

test('fetch_json: wraps scalars and accepts a single object', async () => {
  const scalars = chain(mod('src', 'fetch_json', { url: 'http://fake/data.json', path: 'data.nums' }), []);
  assert.deepEqual((await runPipe(scalars, { fetcher })).items, [{ value: 1 }, { value: 2 }, { value: 3 }]);
  const single = chain(mod('src', 'fetch_json', { url: 'http://fake/data.json', path: 'data.obj' }), []);
  assert.deepEqual((await runPipe(single, { fetcher })).items, [{ title: 'only' }]);
});

test('item_builder: dotted field names build nested objects', async () => {
  const pipe = chain(mod('src', 'item_builder', {
    fields: [{ name: 'title', value: 'Hello' }, { name: 'meta.author', value: 'Bob' }],
  }), []);
  const { items } = await runPipe(pipe, { fetcher });
  assert.deepEqual(items, [{ title: 'Hello', meta: { author: 'Bob' } }]);
});

// ---------------------------------------------------------------- operators

test('filter: permit + contains is case-insensitive, missing field is false', async () => {
  const { items } = await runOps(
    [{ title: 'Hello World' }, { title: 'bye' }, { name: 'Hello' }],
    [mod('f', 'filter', { mode: 'permit', combine: 'all', rules: [{ field: 'title', op: 'contains', value: 'HELLO' }] })],
  );
  assert.deepEqual(titles(items), ['Hello World']);
});

test('filter: block mode drops matching items', async () => {
  const { items } = await runOps(
    [{ title: 'Hello World' }, { title: 'bye' }],
    [mod('f', 'filter', { mode: 'block', combine: 'all', rules: [{ field: 'title', op: 'contains', value: 'hello' }] })],
  );
  assert.deepEqual(titles(items), ['bye']);
});

test('filter: combine any vs all', async () => {
  const data = [{ title: 'alpha' }, { title: 'beta' }, { title: 'gamma' }];
  const rules = [
    { field: 'title', op: 'contains', value: 'alpha' },
    { field: 'title', op: 'contains', value: 'beta' },
  ];
  const any = await runOps(data, [mod('f', 'filter', { mode: 'permit', combine: 'any', rules })]);
  assert.deepEqual(titles(any.items), ['alpha', 'beta']);
  const all = await runOps(data, [mod('f', 'filter', { mode: 'permit', combine: 'all', rules })]);
  assert.deepEqual(all.items, []);
});

test('filter: greater_than compares numerically', async () => {
  const { items } = await runOps(
    [{ title: 'a', score: 5 }, { title: 'b', score: '30' }, { title: 'c', score: 9 }],
    [mod('f', 'filter', { mode: 'permit', combine: 'all', rules: [{ field: 'score', op: 'greater_than', value: '10' }] })],
  );
  assert.deepEqual(titles(items), ['b']);
});

test('filter: matches_regex', async () => {
  const { items } = await runOps(
    [{ title: 'Rust 2.0 released' }, { title: 'rusty nail' }, { title: 'AI' }],
    [mod('f', 'filter', { mode: 'permit', combine: 'all', rules: [{ field: 'title', op: 'matches_regex', value: '^Rust\\s+\\d' }] })],
  );
  assert.deepEqual(titles(items), ['Rust 2.0 released']);
});

test('sort: pubDate desc uses date comparison', async () => {
  const { items } = await runOps(
    [
      { title: 'old', pubDate: '2026-07-20T00:00:00.000Z' },
      { title: 'new', pubDate: '2026-07-29T00:00:00.000Z' },
      { title: 'mid', pubDate: '2026-07-25T00:00:00.000Z' },
    ],
    [mod('s', 'sort', { rules: [{ field: 'pubDate', dir: 'desc' }] })],
  );
  assert.deepEqual(titles(items), ['new', 'mid', 'old']);
});

test('sort: numeric asc, missing field sorts last', async () => {
  const { items } = await runOps(
    [{ title: 'two', n: 2 }, { title: 'none' }, { title: 'ten', n: 10 }],
    [mod('s', 'sort', { rules: [{ field: 'n', dir: 'asc' }] })],
  );
  assert.deepEqual(titles(items), ['two', 'ten', 'none']);
});

test('truncate: keeps first N and reports debug counts', async () => {
  const data = [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }];
  const { items, debug } = await runOps(data, [mod('t', 'truncate', { count: 2 })]);
  assert.deepEqual(titles(items), ['a', 'b']);
  assert.equal(debug.src.count, 5);
  assert.equal(debug.t.count, 2);
  assert.ok(Array.isArray(debug.t.items));
  assert.equal(typeof debug.t.ms, 'number');
});

test('tail: keeps last N', async () => {
  const { items } = await runOps(
    [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    [mod('t', 'tail', { count: 2 })],
  );
  assert.deepEqual(titles(items), ['b', 'c']);
});

test('unique: first item per value, missing field dedupes under ""', async () => {
  const { items } = await runOps(
    [{ title: 'A', n: 1 }, { title: 'B' }, { title: 'A', n: 2 }, { n: 3 }, { title: '', n: 4 }],
    [mod('u', 'unique', { field: 'title' })],
  );
  assert.equal(items.length, 3);
  assert.equal(items[0].n, 1);
  assert.equal(items[1].title, 'B');
  assert.equal(items[2].n, 3);
});

test('reverse: reverses item order', async () => {
  const { items } = await runOps(
    [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    [mod('r', 'reverse', {})],
  );
  assert.deepEqual(titles(items), ['c', 'b', 'a']);
});

test('union: concatenates in port order, not wire order', async () => {
  const modules = [
    mod('sa', 'fetch_json', { url: jsonSource([{ title: 'first' }]), path: '' }),
    mod('sb', 'fetch_json', { url: jsonSource([{ title: 'second' }]), path: '' }),
    mod('u', 'union', {}),
    mod('sink', 'output', {}),
  ];
  const wires = [
    { id: 'w1', from: { module: 'sb', port: 'out' }, to: { module: 'u', port: 'in2' } },
    { id: 'w2', from: { module: 'sa', port: 'out' }, to: { module: 'u', port: 'in1' } },
    { id: 'w3', from: { module: 'u', port: 'out' }, to: { module: 'sink', port: 'in' } },
  ];
  const { items } = await runPipe({ name: 'union test', modules, wires }, { fetcher });
  assert.deepEqual(titles(items), ['first', 'second']);
});

test('count: emits a single {count} item', async () => {
  const { items } = await runOps(
    [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    [mod('c', 'count', {})],
  );
  assert.deepEqual(items, [{ count: 3 }]);
});

test('rename: rename moves, copy duplicates, missing from is skipped', async () => {
  const { items } = await runOps(
    [{ title: 'T', old: 'v' }],
    [mod('r', 'rename', {
      rules: [
        { from: 'old', op: 'rename', to: 'moved' },
        { from: 'title', op: 'copy', to: 'headline' },
        { from: 'nope', op: 'rename', to: 'ghost' },
      ],
    })],
  );
  assert.deepEqual(items, [{ title: 'T', headline: 'T', moved: 'v' }]);
});

test('regex: replaces with backreferences and flags, missing field skipped', async () => {
  const swapped = await runOps(
    [{ title: 'hello world' }, { name: 'untouched' }],
    [mod('r', 'regex', { rules: [{ field: 'title', pattern: '(\\w+) (\\w+)', replace: '$2 $1', flags: '' }] })],
  );
  assert.equal(swapped.items[0].title, 'world hello');
  assert.deepEqual(swapped.items[1], { name: 'untouched' });
  const global = await runOps(
    [{ title: 'a-a-a' }],
    [mod('r', 'regex', { rules: [{ field: 'title', pattern: 'a', replace: 'b', flags: 'g' }] })],
  );
  assert.equal(global.items[0].title, 'b-b-b');
});

test('sub_element: expands arrays/objects, wraps scalars, drops missing', async () => {
  const { items } = await runOps(
    [{ list: [{ a: 1 }, 's'] }, { list: { a: 2 } }, { other: true }, { list: 7 }],
    [mod('s', 'sub_element', { path: 'list' })],
  );
  assert.deepEqual(items, [{ a: 1 }, { value: 's' }, { a: 2 }, { value: 7 }]);
});

// ---------------------------------------------------------------- templates

test('template: ${name} substituted from runtime params', async () => {
  const { items } = await runOps(
    [{ title: 'Alpha Rust' }, { title: 'Beta' }],
    [mod('f', 'filter', { mode: 'permit', combine: 'all', rules: [{ field: 'title', op: 'contains', value: '${q}' }] })],
    { q: 'rust' },
  );
  assert.deepEqual(titles(items), ['Alpha Rust']);
});

test('template: text_input default used, runtime param overrides it', async () => {
  const data = [{ title: 'Alpha Rust' }, { title: 'Beta' }];
  const build = () => {
    const pipe = chain(
      mod('src', 'fetch_json', { url: jsonSource(data), path: '' }),
      [mod('f', 'filter', { mode: 'permit', combine: 'all', rules: [{ field: 'title', op: 'contains', value: '${q}' }] })],
    );
    pipe.modules.push(mod('ti', 'text_input', { name: 'q', prompt: 'keyword', default: 'Beta' }));
    return pipe;
  };
  const byDefault = await runPipe(build(), { fetcher });
  assert.deepEqual(titles(byDefault.items), ['Beta']);
  assert.equal(byDefault.debug.ti.count, 0);
  assert.deepEqual(byDefault.debug.ti.items, []);
  const overridden = await runPipe(build(), { fetcher, params: { q: 'Alpha' } });
  assert.deepEqual(titles(overridden.items), ['Alpha Rust']);
});

// ---------------------------------------------------------------- validation errors

test('error: cycle detection throws PipeError', async () => {
  const modules = [mod('a', 'reverse', {}), mod('b', 'reverse', {})];
  const wires = [
    { id: 'w1', from: { module: 'a', port: 'out' }, to: { module: 'b', port: 'in' } },
    { id: 'w2', from: { module: 'b', port: 'out' }, to: { module: 'a', port: 'in' } },
  ];
  await assert.rejects(
    () => runPipe({ name: 'cycle', modules, wires }, { fetcher }),
    (err) => err instanceof PipeError && err.status === 400,
  );
});

test('error: two wires into one input port throws PipeError', async () => {
  const modules = [
    mod('sa', 'fetch_json', { url: jsonSource([{ title: 'x' }]), path: '' }),
    mod('sb', 'fetch_json', { url: jsonSource([{ title: 'y' }]), path: '' }),
    mod('t', 'truncate', { count: 1 }),
  ];
  const wires = [
    { id: 'w1', from: { module: 'sa', port: 'out' }, to: { module: 't', port: 'in' } },
    { id: 'w2', from: { module: 'sb', port: 'out' }, to: { module: 't', port: 'in' } },
  ];
  await assert.rejects(() => runPipe({ name: 'dup', modules, wires }, { fetcher }), PipeError);
});

test('error: unknown module type throws PipeError', async () => {
  await assert.rejects(
    () => runPipe({ name: 'bad', modules: [mod('x', 'bogus', {})], wires: [] }, { fetcher }),
    PipeError,
  );
});

test('error: bad regex is recorded, downstream still runs', async () => {
  const source = mod('src', 'fetch_json', { url: jsonSource([{ title: 'a' }, { title: 'b' }]), path: '' });
  const pipe = chain(source, [
    mod('bad', 'regex', { rules: [{ field: 'title', pattern: '(', replace: '', flags: '' }] }),
    mod('c', 'count', {}),
  ]);
  const { items, debug, errors } = await runPipe(pipe, { fetcher });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].module, 'bad');
  assert.equal(typeof errors[0].message, 'string');
  assert.ok(debug.bad.error);
  assert.deepEqual(items, [{ count: 0 }]);
});

// ---------------------------------------------------------------- end to end

test('end-to-end: fetch_feed -> filter ${q} -> sort desc -> truncate -> output', async () => {
  const modules = [
    mod('ti', 'text_input', { name: 'q', prompt: 'keyword', default: 'AI' }),
    mod('feed', 'fetch_feed', { urls: ['http://fake/tech.xml'] }),
    mod('f', 'filter', { mode: 'permit', combine: 'all', rules: [{ field: 'title', op: 'contains', value: '${q}' }] }),
    mod('s', 'sort', { rules: [{ field: 'pubDate', dir: 'desc' }] }),
    mod('t', 'truncate', { count: 5 }),
    mod('o', 'output', {}),
  ];
  const wires = [
    { id: 'w1', from: { module: 'feed', port: 'out' }, to: { module: 'f', port: 'in' } },
    { id: 'w2', from: { module: 'f', port: 'out' }, to: { module: 's', port: 'in' } },
    { id: 'w3', from: { module: 's', port: 'out' }, to: { module: 't', port: 'in' } },
    { id: 'w4', from: { module: 't', port: 'out' }, to: { module: 'o', port: 'in' } },
  ];
  const { items, errors } = await runPipe({ name: 'demo shape', modules, wires }, { fetcher });
  assert.deepEqual(errors, []);
  assert.deepEqual(titles(items), ['AI beats benchmark', 'New AI regulation draft', 'AI assistant for farmers']);
});

// -------------------------------------------------------------- new builders

test('string_builder: joins parts and interpolates {path}', async () => {
  const { items } = await runOps(
    [{ title: 'Rust', author: { name: 'ada' } }],
    [mod('b', 'string_builder', { parts: ['[', '{author.name}', '] ', '{title}'], to: 'headline' })]);
  assert.equal(items[0].headline, '[ada] Rust');
  assert.equal(items[0].title, 'Rust', 'the source field is left alone');
});

test('string_builder: missing paths become empty, {{ }} are literal braces', async () => {
  const { items } = await runOps(
    [{ title: 'X' }],
    [mod('b', 'string_builder', { parts: ['{{a}} {title} {nope}'], to: 'out' })]);
  assert.equal(items[0].out, '{a} X ');
});

test('date_builder: each format, leaving unparseable values alone', async () => {
  const src = [{ pubDate: '2026-07-28T14:05:00.000Z' }];
  const at = async (format) => (await runOps(src,
    [mod('d', 'date_builder', { field: 'pubDate', format, to: 'when' })])).items[0].when;
  assert.equal(await at('iso'), '2026-07-28T14:05:00.000Z');
  assert.equal(await at('rfc822'), 'Tue, 28 Jul 2026 14:05:00 GMT');
  assert.equal(await at('date'), '2026-07-28');
  assert.equal(await at('datetime'), '2026-07-28 14:05:00');
  assert.equal(await at('epoch'), Date.parse('2026-07-28T14:05:00.000Z'));

  const { items } = await runOps([{ pubDate: 'not a date' }],
    [mod('d', 'date_builder', { field: 'pubDate', format: 'iso', to: 'when' })]);
  assert.deepEqual(items, [{ pubDate: 'not a date' }]);
});

test('url_builder: percent-encodes, skips empty values, respects an existing query', async () => {
  const { items } = await runOps(
    [{ title: 'Rust & Go', lang: '' }],
    [mod('u', 'url_builder', {
      base: 'https://example.com/s?v=1',
      query: [{ name: 'q', value: '{title}' }, { name: 'lang', value: '{lang}' }, { name: '', value: 'x' }],
      to: 'link',
    })]);
  assert.equal(items[0].link, 'https://example.com/s?v=1&q=Rust%20%26%20Go');
});

test('url_builder: no query rows leaves the base untouched', async () => {
  const { items } = await runOps([{ title: 'x' }],
    [mod('u', 'url_builder', { base: 'https://example.com/{title}', query: [], to: 'link' })]);
  assert.equal(items[0].link, 'https://example.com/x');
});

test('strip_html: drops markup and script bodies, decodes entities', async () => {
  const { items } = await runOps(
    [{ description: '<p>Hello &amp; welcome</p><script>bad()</script><div>Line two</div>', title: '<b>keep</b>' }],
    [mod('s', 'strip_html', { fields: ['description'] })]);
  assert.equal(items[0].description, 'Hello & welcome\nLine two');
  assert.equal(items[0].title, '<b>keep</b>', 'only the listed fields are touched');
});

test('strip_html: missing fields are skipped, several fields at once', async () => {
  const { items } = await runOps(
    [{ title: '<i>a</i>' }],
    [mod('s', 'strip_html', { fields: ['title', 'description'] })]);
  assert.deepEqual(items, [{ title: 'a' }]);
});

// ------------------------------------------------------------------ JSON Feed

test('buildJSONFeed: version 1.1 envelope with feed metadata', () => {
  const feed = JSON.parse(buildJSONFeed({
    title: 'My pipe', link: 'http://host/pipes/p/run', description: 'about it', items: [],
  }));
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(feed.title, 'My pipe');
  assert.equal(feed.home_page_url, 'http://host/pipes/p/run');
  assert.equal(feed.feed_url, 'http://host/pipes/p/run');
  assert.equal(feed.description, 'about it');
  assert.deepEqual(feed.items, []);
});

test('buildJSONFeed: maps the canonical item fields', () => {
  const { items } = JSON.parse(buildJSONFeed({
    title: 't',
    items: [{
      title: 'Hello', link: 'http://x/1', description: '<p>body</p>',
      pubDate: 'Tue, 28 Jul 2026 09:30:00 GMT', guid: 'g1',
      author: 'Ada', categories: ['a', 'b'],
    }],
  }));
  assert.deepEqual(items, [{
    id: 'g1',
    title: 'Hello',
    url: 'http://x/1',
    content_html: '<p>body</p>',
    date_published: '2026-07-28T09:30:00.000Z',
    authors: [{ name: 'Ada' }],
    tags: ['a', 'b'],
  }]);
});

test('buildJSONFeed: only emits what the item has, and always an id', () => {
  const { items } = JSON.parse(buildJSONFeed({
    title: 't',
    items: [{ title: 'only a title' }, { link: 'http://x/2' }, {}],
  }));
  assert.deepEqual(Object.keys(items[0]), ['id', 'title']);
  assert.equal(items[0].id, 'only a title', 'falls back to the title');
  assert.equal(items[1].id, 'http://x/2', 'then to the link');
  assert.equal(items[2].id, '2', 'and finally to the position');
});

test('buildJSONFeed: an unparseable date is left out rather than emitted as junk', () => {
  const { items } = JSON.parse(buildJSONFeed({ title: 't', items: [{ title: 'x', pubDate: 'soon' }] }));
  assert.equal(items[0].date_published, undefined);
});

// -------------------------------------------------------------- term extractor

async function termsOf(text, params = {}) {
  const { items } = await runOps([{ description: text }],
    [mod('t', 'term_extractor', { field: 'description', to: 'terms', count: 5, ...params })]);
  return items[0].terms;
}

test('term_extractor: frequent words win, stopwords and short words do not', async () => {
  const terms = await termsOf(
    '<p>The Rust compiler team announced that Rust 2.0 will make the compiler '
    + 'dramatically faster. Compiler performance is the top request.</p>');
  assert.equal(terms[0], 'compiler', 'said three times');
  assert.equal(terms[1], 'rust', 'said twice');
  assert.ok(!terms.includes('the') && !terms.includes('that'), 'stopwords are dropped');
  assert.ok(!terms.some((t) => t.length < 3), 'very short words are dropped');
});

test('term_extractor: Japanese splits on kana, keeping the compounds', async () => {
  const terms = await termsOf(
    '人工知能の研究が進み、人工知能を使った開発支援ツールが増えている。開発の現場では人工知能の活用が広がる。');
  assert.equal(terms[0], '人工知能');
  assert.ok(terms.includes('開発支援ツール'), terms.join());
  assert.ok(!terms.some((t) => /^[\u3040-\u309f]+$/.test(t)), 'no kana-only fragments');
});

test('term_extractor: honours the count and strips markup first', async () => {
  const terms = await termsOf('<b>alpha</b> alpha beta beta gamma gamma delta', { count: 2 });
  assert.equal(terms.length, 2);
  assert.ok(!terms.some((t) => t.includes('<') || t === 'b'), terms.join());
});

test('term_extractor: a missing field leaves the item untouched', async () => {
  const { items } = await runOps([{ title: 'no description here' }],
    [mod('t', 'term_extractor', { field: 'description', to: 'terms', count: 5 })]);
  assert.deepEqual(items, [{ title: 'no description here' }]);
});

test('term_extractor: empty text yields an empty list, not an error', async () => {
  assert.deepEqual(await termsOf(''), []);
});

// --------------------------------------------------------------- html / scraping

const SCRAPE_PAGE = `<!DOCTYPE html>
<html><head><title>Blog &amp; News</title>
<script>var a = "<article class='post'>fake</article>";</script></head>
<body>
  <!-- <article class="post">commented out</article> -->
  <ul class="posts">
    <li class="post"><h2><a href="/a">Alpha &amp; Beta</a></h2><p class=sum>First <b>summary</b></p><time datetime="2026-07-28">Jul 28</time>
    <li class="post"><h2><a href='/b'>Gamma</a></h2><p class=sum>Second</p><time datetime="2026-07-27">Jul 27</time>
  </ul>
  <div class="ad"><h2><a href=/x>Sponsored</a></h2></div>
</body></html>`;

function scrapePipe(params) {
  const url = 'http://fake/blog.html';
  CANNED[url] = SCRAPE_PAGE;
  return {
    name: 'scrape',
    modules: [mod('p', 'fetch_page', { url, ...params }), mod('o', 'output')],
    wires: [wire('p', 'o')],
  };
}

test('parseHTML: recovers from unclosed tags and ignores script contents', async () => {
  const { parseHTML, queryAll, textOf } = await import('../lib/html.js');
  const doc = parseHTML(SCRAPE_PAGE);
  assert.equal(queryAll(doc, 'li.post').length, 2, 'unclosed <li> should still be two');
  assert.equal(textOf(queryAll(doc, 'title')[0]), 'Blog & News');
  assert.equal(queryAll(doc, 'article').length, 0, 'markup inside <script> is not markup');
});

test('selectors: tag, class, id, attribute and combinator forms', async () => {
  const { parseHTML, queryAll } = await import('../lib/html.js');
  const doc = parseHTML('<div id=a class="x y"><p><b>1</b></p><b>2</b></div><b>3</b>');
  assert.equal(queryAll(doc, 'b').length, 3);
  assert.equal(queryAll(doc, '#a b').length, 2);
  assert.equal(queryAll(doc, '#a > b').length, 1);
  assert.equal(queryAll(doc, '.x.y').length, 1);
  assert.equal(queryAll(doc, '.x.z').length, 0);
  assert.equal(queryAll(doc, '[id="a"]').length, 1);
  assert.equal(queryAll(doc, 'p, b').length, 4);
  assert.throws(() => queryAll(doc, 'a:hover'), /Unsupported selector/);
});

test('fetch_page: one item per match, with text, html and attributes', async () => {
  const { items, errors } = await runPipe(scrapePipe({
    item: 'li.post',
    fields: [
      { name: 'title', selector: 'h2 a', attr: 'text' },
      { name: 'description', selector: 'p.sum', attr: 'html' },
      { name: 'pubDate', selector: 'time', attr: 'datetime' },
    ],
  }), { fetcher });
  assert.deepEqual(errors, []);
  assert.deepEqual(items, [
    { title: 'Alpha & Beta', description: 'First <b>summary</b>', pubDate: '2026-07-28' },
    { title: 'Gamma', description: 'Second', pubDate: '2026-07-27' },
  ]);
});

test('fetch_page: link attributes are resolved against the page', async () => {
  const { items } = await runPipe(scrapePipe({
    item: 'li.post',
    fields: [{ name: 'link', selector: 'h2 a', attr: 'href' }],
  }), { fetcher });
  assert.deepEqual(items.map((i) => i.link), ['http://fake/a', 'http://fake/b']);
});

test('fetch_page: a field whose selector matches nothing is left out', async () => {
  const { items } = await runPipe(scrapePipe({
    item: 'li.post',
    fields: [
      { name: 'title', selector: 'h2 a', attr: 'text' },
      { name: 'author', selector: '.byline', attr: 'text' },
    ],
  }), { fetcher });
  assert.deepEqual(Object.keys(items[0]), ['title']);
});

test('fetch_page: no item selector treats the page as a single item', async () => {
  const { items } = await runPipe(scrapePipe({
    item: '',
    fields: [{ name: 'title', selector: 'title', attr: 'text' }],
  }), { fetcher });
  assert.deepEqual(items, [{ title: 'Blog & News' }]);
});

test('fetch_page: an empty URL yields nothing rather than erroring', async () => {
  const { items, errors } = await runPipe({
    name: 'empty',
    modules: [mod('p', 'fetch_page', { url: '', item: '', fields: [] }), mod('o', 'output')],
    wires: [wire('p', 'o')],
  }, { fetcher });
  assert.deepEqual(items, []);
  assert.deepEqual(errors, []);
});

test('fetch_page: a bad selector is a module error, not a crash', async () => {
  const { items, errors } = await runPipe(scrapePipe({
    item: 'li:first-child',
    fields: [{ name: 'title', selector: '', attr: 'text' }],
  }), { fetcher });
  assert.deepEqual(items, []);
  assert.match(errors[0].message, /Unsupported selector/);
});

// --------------------------------------------------------------------- loop

const SUB_PIPE = {
  name: 'sub',
  modules: [
    mod('s', 'item_builder', { fields: [{ name: 'title', value: 'sub of ${title}' }, { name: 'src', value: '${link}' }] }),
    mod('o', 'output'),
  ],
  wires: [wire('s', 'o')],
};
const loadSub = async (id) => {
  if (id === 'sub') return SUB_PIPE;
  throw new Error('Pipe not found: ' + id);
};

function loopPipe(loopParams, items = [{ title: 'A', link: 'http://a' }]) {
  return {
    name: 'outer',
    modules: [
      mod('src', 'fetch_json', { url: jsonSource(items), path: '' }),
      mod('L', 'loop', loopParams),
      mod('o', 'output'),
    ],
    wires: [wire('src', 'L'), wire('L', 'o')],
  };
}

test('loop: replace mode swaps each item for its sub-pipe output', async () => {
  const { items, errors } = await runPipe(
    loopPipe({ pipe: 'sub', mode: 'replace', to: 'items', limit: 20 }),
    { fetcher, loadPipe: loadSub });
  assert.deepEqual(errors, []);
  assert.deepEqual(items, [{ title: 'sub of A', src: 'http://a' }]);
});

test('loop: assign mode keeps the item and nests the results', async () => {
  const { items } = await runPipe(
    loopPipe({ pipe: 'sub', mode: 'assign', to: 'found', limit: 20 }),
    { fetcher, loadPipe: loadSub });
  assert.deepEqual(items, [{
    title: 'A', link: 'http://a',
    found: [{ title: 'sub of A', src: 'http://a' }],
  }]);
});

test('loop: runs once per item and keeps input order', async () => {
  const { items } = await runPipe(
    loopPipe({ pipe: 'sub', mode: 'replace', to: 'i', limit: 20 },
      [{ title: 'a' }, { title: 'b' }, { title: 'c' }]),
    { fetcher, loadPipe: loadSub });
  assert.deepEqual(titles(items), ['sub of a', 'sub of b', 'sub of c']);
});

test('loop: an empty pipe id passes items through untouched', async () => {
  const { items, errors } = await runPipe(
    loopPipe({ pipe: '', mode: 'replace', to: 'i', limit: 20 }),
    { fetcher, loadPipe: loadSub });
  assert.deepEqual(errors, []);
  assert.deepEqual(items, [{ title: 'A', link: 'http://a' }]);
});

test('loop: the item limit is reported rather than silently dropping', async () => {
  const { items, errors } = await runPipe(
    loopPipe({ pipe: 'sub', mode: 'replace', to: 'i', limit: 2 },
      [{ title: 'a' }, { title: 'b' }, { title: 'c' }]),
    { fetcher, loadPipe: loadSub });
  assert.equal(items.length, 2);
  assert.match(errors[0].message, /stopped after 2 of 3 items/);
});

test('loop: a missing sub-pipe is a module error, not a crash', async () => {
  const { items, errors } = await runPipe(
    loopPipe({ pipe: 'nope', mode: 'replace', to: 'i', limit: 20 }),
    { fetcher, loadPipe: loadSub });
  assert.deepEqual(items, []);
  assert.match(errors[0].message, /Pipe not found: nope/);
});

test('loop: a self-referencing pipe stops and says so', async () => {
  const self = {
    name: 'self',
    modules: [
      mod('a', 'item_builder', { fields: [{ name: 'title', value: 'x' }] }),
      mod('L', 'loop', { pipe: 'self', mode: 'replace', to: 'i', limit: 5 }),
      mod('o', 'output'),
    ],
    wires: [wire('a', 'L'), wire('L', 'o')],
  };
  const { errors } = await runPipe(self, { loadPipe: async () => self });
  assert.match(errors[0].message, /already running/);
});

test('loop: errors inside the sub-pipe surface on the loop module', async () => {
  const bad = {
    name: 'bad',
    modules: [
      mod('a', 'item_builder', { fields: [{ name: 'title', value: 'x' }] }),
      mod('r', 'regex', { rules: [{ field: 'title', pattern: '([', replace: '', flags: '' }] }),
      mod('o', 'output'),
    ],
    wires: [wire('a', 'r'), wire('r', 'o')],
  };
  const { errors } = await runPipe(
    loopPipe({ pipe: 'bad', mode: 'replace', to: 'i', limit: 20 }),
    { fetcher, loadPipe: async () => bad });
  assert.match(errors[0].message, /Loop item 1 \(r\)/);
});

test('loop: without a loader the module reports it is unavailable', async () => {
  const { errors } = await runPipe(
    loopPipe({ pipe: 'sub', mode: 'replace', to: 'i', limit: 20 }), { fetcher });
  assert.match(errors[0].message, /no pipe loader/);
});

// ---------------------------------------------------------- hostile field paths

test('security: item_builder cannot pollute Object.prototype via __proto__ path', async () => {
  const modules = [
    mod('b', 'item_builder', { fields: [{ name: '__proto__.polluted', value: 'PWNED' }] }),
    mod('o', 'output', {}),
  ];
  const { items } = await runPipe({ name: 'proto', modules, wires: [wire('b', 'o')] }, {});
  assert.deepEqual(items, [{}]);
  assert.equal({}.polluted, undefined);
});

test('security: rename cannot delete or overwrite prototype members', async () => {
  const modules = [
    mod('b', 'item_builder', { fields: [{ name: 'x', value: '1' }] }),
    mod('r', 'rename', { rules: [
      { from: '__proto__.toString', op: 'rename', to: 'junk' },
      { from: 'x', op: 'copy', to: 'constructor.evil' },
    ] }),
    mod('o', 'output', {}),
  ];
  const wires = [wire('b', 'r'), wire('r', 'o')];
  const { items } = await runPipe({ name: 'proto2', modules, wires }, {});
  assert.equal(String({}), '[object Object]');
  assert.equal(Object.prototype.evil, undefined);
  assert.deepEqual(items, [{ x: '1' }]);
});

test('security: filter/sort read own properties only, not inherited ones', async () => {
  const modules = [
    mod('b', 'item_builder', { fields: [{ name: 'title', value: 'hi' }] }),
    mod('f', 'filter', { mode: 'permit', combine: 'all',
      rules: [{ field: 'toString', op: 'contains', value: 'function' }] }),
    mod('o', 'output', {}),
  ];
  const { items } = await runPipe(
    { name: 'inherited', modules, wires: [wire('b', 'f'), wire('f', 'o')] }, {});
  assert.deepEqual(items, []);
});

test('paths: legitimate nested and array segments still work', async () => {
  const modules = [
    mod('b', 'item_builder', { fields: [{ name: 'a.b.c', value: 'deep' }, { name: 'l.0', value: 'first' }] }),
    mod('o', 'output', {}),
  ];
  const { items } = await runPipe({ name: 'nested', modules, wires: [wire('b', 'o')] }, {});
  assert.deepEqual(items, [{ a: { b: { c: 'deep' } }, l: ['first'] }]);
});

test('security: a module whose id is __proto__ still gets its own debug entry', async () => {
  const modules = [
    mod('__proto__', 'item_builder', { fields: [{ name: 'title', value: 'weird id' }] }),
    mod('o', 'output', {}),
  ];
  const { items, debug } = await runPipe(
    { name: 'weird', modules, wires: [wire('__proto__', 'o')] }, {});
  assert.deepEqual(items, [{ title: 'weird id' }]);
  assert.deepEqual(Object.keys(debug).sort(), ['__proto__', 'o']);
  assert.equal(debug['__proto__'].count, 1);
  assert.equal(JSON.parse(JSON.stringify(debug))['__proto__'].count, 1);
});

test('rename: to === from keeps the field instead of deleting it', async () => {
  const { items } = await runOps(
    [{ title: 'keepme' }],
    [mod('r', 'rename', { rules: [{ from: 'title', op: 'rename', to: 'title' }] })]);
  assert.deepEqual(items, [{ title: 'keepme' }]);
});

test('rename: nested target under the source keeps the moved value', async () => {
  const { items } = await runOps(
    [{ a: 'v' }],
    [mod('r', 'rename', { rules: [{ from: 'a', op: 'rename', to: 'a.b' }] })]);
  assert.deepEqual(items, [{ a: { b: 'v' } }]);
});

test('security: escapeXml drops XML-illegal control characters', () => {
  const nul = String.fromCharCode(0);
  assert.equal(escapeXml(`a${nul}b${String.fromCharCode(7)}c`), 'abc');
  assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd');
  const xml = buildRSS({ title: 't', link: 'http://x/', description: 'd',
    items: [{ title: `${nul}poison`, link: 'http://x/1' }] });
  assert.ok(!xml.includes(nul), 'published feed must stay parseable');
  assert.equal(parseFeed(xml).items[0].title, 'poison');
});

test('security: unknown entity names do not resolve inherited Object members', () => {
  const feed = parseFeed(
    '<rss version="2.0"><channel><title>t</title>' +
    '<item><title>Ben &amp; Jerry &constructor; ice</title></item></channel></rss>');
  assert.equal(feed.items[0].title, 'Ben & Jerry &constructor; ice');
});

test('security: isPrivateAddress classifies the ranges a pipe must not reach', async () => {
  const { isPrivateAddress } = await import('../lib/feed.js');
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', 'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as private`);
  }
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1', '11.0.0.1',
    '2001:4860:4860::8888', '2606:4700::1111',
  ]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must be treated as public`);
  }
});

test('security: fetchURL refuses loopback and cloud metadata', async () => {
  const { fetchURL } = await import('../lib/feed.js');
  await assert.rejects(() => fetchURL('http://127.0.0.1:9/x'), /non-public address/);
  await assert.rejects(() => fetchURL('http://169.254.169.254/latest/'), /non-public address/);
});

test('security: a redirect into private space is caught on the next hop', async () => {
  const http = await import('node:http');
  const { fetchURL } = await import('../lib/feed.js');
  const server = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { location: 'http://127.0.0.2:9/secret' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    // baseUrl names the app's own origin, which is how /demo/tech.xml resolves
    assert.equal((await fetchURL('/plain', { baseUrl: origin })).text, 'ok');
    await assert.rejects(() => fetchURL('/redir', { baseUrl: origin }),
      /non-public address \(127\.0\.0\.2\)/);
    assert.equal((await fetchURL(`${origin}/plain`, { allowPrivate: true })).text, 'ok');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fetchURL: aborts a chunked response that passes maxBytes without buffering it', async () => {
  const http = await import('node:http');
  const { fetchURL } = await import('../lib/feed.js');
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let sent = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' }); // no content-length
    let n = 0;
    const push = () => {
      if (n++ >= 400 || res.writableEnded) { res.end(); return; }
      sent += chunk.length;
      if (res.write(chunk)) setImmediate(push); else res.once('drain', push);
    };
    push();
    res.on('close', () => { n = Infinity; });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // allowPrivate: this is about the size cap, not the address filter
    const url = `http://127.0.0.1:${server.address().port}/big`;
    await assert.rejects(() => fetchURL(url, { maxBytes: 100_000, allowPrivate: true }),
      /exceeds 100000 bytes/);
    assert.ok(sent < 400 * chunk.length, 'must not have read the whole body');
  } finally {
    // a socket left open by the aborted read would keep the process alive
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ----------------------------------------------------------------- store

const SYSTEM_PIPES_DIR =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'demo', 'pipes');

// Every store test gets its own in-memory database with the shipped demos as
// system pipes, and two users so isolation can actually be observed.
function withStore(fn) {
  const store = openStore({ dbPath: ':memory:', systemPipesDir: SYSTEM_PIPES_DIR });
  try {
    const a = store.upsertUser({ provider: 'google', subject: 'sub-a', email: 'a@example.com', name: 'A' });
    const b = store.upsertUser({ provider: 'google', subject: 'sub-b', email: 'b@example.com', name: 'B' });
    return fn(store, a.id, b.id);
  } finally {
    store.close();
  }
}

const PIPE = (name) => ({
  name,
  modules: [{ id: 'm1', type: 'output', params: {}, x: 0, y: 0 }],
  wires: [],
});

test('store: save, list, get and delete round trip', () => withStore((store, a) => {
  const { id } = store.savePipe(a, PIPE('Round Trip'));
  assert.match(id, /^[a-z0-9-]+-[0-9a-f]{16}$/);

  const got = store.getPipe(id, a);
  assert.equal(got.id, id);
  assert.equal(got.name, 'Round Trip');
  assert.equal(got.readOnly, false);
  assert.deepEqual(got.modules, PIPE('x').modules);
  assert.ok(got.savedAt);

  assert.equal(store.listPipes(a).filter((p) => !p.readOnly).length, 1);
  store.deletePipe(id, a);
  assert.equal(store.getPipe(id, a), null);
  assert.equal(store.listPipes(a).filter((p) => !p.readOnly).length, 0);
}));

test('store: own pipes come first, newest first, then the demos', () => withStore((store, a) => {
  const first = store.savePipe(a, PIPE('older')).id;
  const second = store.savePipe(a, PIPE('newer')).id;
  // savedAt is an ISO string with millisecond resolution; make the order certain
  store.db.prepare('UPDATE pipes SET saved_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', first);
  const list = store.listPipes(a);
  assert.deepEqual(list.slice(0, 2).map((p) => p.id), [second, first]);
  assert.deepEqual(list.slice(0, 2).map((p) => p.readOnly), [false, false]);
  assert.ok(list.slice(2).every((p) => p.readOnly), 'the rest are the demos');
  assert.ok(list.some((p) => p.id === 'demo-merged'));
}));

test('store: another owner sees nothing of yours', () => withStore((store, a, b) => {
  const { id } = store.savePipe(a, PIPE('private'));
  assert.equal(store.listPipes(b).some((p) => p.id === id), false);
  assert.equal(store.getPipe(id, b), null);
  store.deletePipe(id, b);                       // a no-op, not an error
  assert.ok(store.getPipe(id, a), 'the delete must not have crossed owners');
  assert.throws(() => store.savePipe(b, { id, ...PIPE('stolen') }), /Pipe not found/);
  assert.equal(store.getPipe(id, a).name, 'private');
}));

test('store: a published pipe is readable by id whoever asks', () => withStore((store, a) => {
  const { id } = store.savePipe(a, PIPE('published'));
  const found = store.publishedPipe(id);
  assert.equal(found.ownerId, a);
  assert.equal(found.pipe.name, 'published');
  assert.equal(store.publishedPipe('demo-merged').ownerId, null);
  assert.equal(store.publishedPipe('never-saved'), null);
}));

test('store: system pipes are readable by everyone and writable by nobody', () => withStore((store, a, b) => {
  for (const owner of [a, b, null]) {
    const demo = store.getPipe('demo-merged', owner);
    assert.equal(demo.readOnly, true);
    assert.ok(demo.modules.length > 0);
  }
  assert.equal(store.getPipe('never-saved', null), null);
  assert.throws(() => store.savePipe(a, { id: 'demo-merged', ...PIPE('x') }), { status: 403 });
  assert.throws(() => store.deletePipe('demo-merged', a), { status: 403 });
  // ...but duplicating one is just a save with no id
  const copy = store.savePipe(a, PIPE('デモのコピー'));
  assert.notEqual(copy.id, 'demo-merged');
  assert.equal(store.getPipe(copy.id, a).readOnly, false);
  assert.equal(store.getPipe(copy.id, b), null);
}));

test('store: ids are a capped slug plus 64 random bits', () => withStore((store, a) => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('日本語だけ'), 'pipe');
  assert.equal(slugify('x'.repeat(80)).length, 40);
  assert.equal(slugify('----'), 'pipe');

  const long = store.savePipe(a, PIPE('y'.repeat(80))).id;
  assert.equal(long, 'y'.repeat(40) + long.slice(40));
  assert.match(long, /^[a-z0-9-]+-[0-9a-f]{16}$/);
  assert.ok(long.length <= 64);

  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(store.savePipe(a, PIPE('same name')).id);
  assert.equal(seen.size, 20, 'ids must not collide');
}));

test('store: an invalid pipe id is refused before any lookup', () => withStore((store, a) => {
  for (const bad of ['UPPER', 'has space', '../etc', '', 'x'.repeat(65), 7, null]) {
    assert.throws(() => store.getPipe(bad, a), { status: 400 }, String(bad));
  }
  assert.throws(() => store.deletePipe('Bad Id', a), { status: 400 });
  assert.throws(() => store.publishedPipe('Bad Id'), { status: 400 });
}));

test('store: sessions are looked up by hash and expire', () => withStore((store, a) => {
  const token = store.createSession(a, 60_000);
  assert.equal(store.sessionUser(token).id, a);
  assert.equal(store.sessionUser(token + 'x'), null);
  assert.equal(store.sessionUser(''), null);
  // the raw token is never stored
  assert.equal(store.db.prepare('SELECT id_hash FROM sessions').get().id_hash === token, false);

  store.deleteSession(token);
  assert.equal(store.sessionUser(token), null);

  const expired = store.createSession(a, -1000);
  assert.equal(store.sessionUser(expired), null);
  store.purgeExpiredSessions();
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
}));

test('store: a user is keyed on (provider, subject), display data refreshed', () => withStore((store) => {
  const first = store.upsertUser({ provider: 'google', subject: 's', email: 'old@x', name: 'Old' });
  const again = store.upsertUser({ provider: 'google', subject: 's', email: 'new@x', name: 'New', picture: 'p' });
  assert.equal(again.id, first.id, 'the same subject is the same user');
  assert.equal(again.email, 'new@x');
  assert.equal(again.picture, 'p');
  assert.equal(again.created_at, first.created_at);
  assert.match(first.id, /^u-[0-9a-f]{16}$/);
  assert.equal(store.ensureLocalUser(), 'local');
  assert.equal(store.ensureLocalUser(), 'local', 'creating it twice is fine');
}));

test('store: deleting a user takes their pipes and sessions with them', () => withStore((store, a) => {
  const { id } = store.savePipe(a, PIPE('doomed'));
  store.createSession(a, 60_000);
  store.db.prepare('DELETE FROM users WHERE id = ?').run(a);
  assert.equal(store.publishedPipe(id), null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
}));

test('store: validatePipeBody rejects what a save used to reject', () => {
  const ok = { name: 'fine', modules: [{ id: 'm1', type: 'output' }], wires: [] };
  assert.equal(validatePipeBody(ok), ok);
  const bad = [
    null, 'string', [],
    { name: 1, modules: [], wires: [] },
    { name: 'x', modules: {}, wires: [] },
    { name: 'x', modules: [], wires: {} },
    { name: 'x', modules: [null], wires: [] },
    { name: 'x', modules: [{ id: '', type: 'output' }], wires: [] },
    { name: 'x', modules: [{ id: 'm1' }], wires: [] },
    { name: 'x', modules: [{ id: 'm1', type: 'output' }, { id: 'm1', type: 'output' }], wires: [] },
    { name: 'x', modules: [{ id: 'm1', type: 'output', params: [] }], wires: [] },
    { name: 'x', modules: [], wires: [{ from: {} }] },
    { name: 'x', modules: [], wires: ['nope'] },
  ];
  for (const body of bad) {
    assert.throws(() => validatePipeBody(body), { status: 400 }, JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ auth

test('auth: cookies parse into a null-prototype object', () => {
  const jar = parseCookies('openpipes_session=abc.def; openpipes_oauth=xyz; junk; =empty; a=1=2');
  assert.equal(Object.getPrototypeOf(jar), null);
  assert.equal(jar.openpipes_session, 'abc.def');
  assert.equal(jar.openpipes_oauth, 'xyz');
  assert.equal(jar.a, '1=2', 'only the first = separates');
  assert.equal(jar.junk, undefined);
  assert.equal(jar.constructor, undefined, 'a prototype key must not leak through');
  assert.equal(parseCookies(undefined).anything, undefined);
  assert.equal(parseCookies('x=1; x=2').x, '1', 'the first occurrence wins');
});

test('auth: a session cookie carries the attributes it must', () => {
  const cookie = serializeCookie('openpipes_session', 'tok', {
    path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 2592000, secure: true,
  });
  assert.match(cookie, /^openpipes_session=tok(;|$)/);
  for (const attr of ['Path=/', 'Max-Age=2592000', 'HttpOnly', 'SameSite=Lax', 'Secure']) {
    assert.ok(cookie.includes(attr), `${attr} missing from ${cookie}`);
  }
  const plain = serializeCookie('openpipes_session', '', { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 0 });
  assert.ok(plain.includes('Max-Age=0'));
  assert.equal(plain.includes('Secure'), false, 'no Secure over plain http');
});

test('auth: return_to only ever points back at this server', () => {
  for (const good of ['/', '/?pipe=x', '/a/b', '/?a=1&b=2#frag']) {
    assert.equal(safeReturnTo(good), good);
  }
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil',
                     '', undefined, null, 42, '/ok\nSet-Cookie: x', '/' + 'a'.repeat(3000)]) {
    assert.equal(safeReturnTo(bad), '/', JSON.stringify(bad));
  }
});

test('auth: the allowlist matches emails and whole domains, case-insensitively', () => {
  const entries = parseAllowlist(' @example.com, Bob@GMAIL.com ,, ');
  assert.deepEqual(entries, ['@example.com', 'bob@gmail.com']);
  assert.equal(matchesAllowlist('carol@example.com', entries), true);
  assert.equal(matchesAllowlist('CAROL@Example.COM', entries), true);
  assert.equal(matchesAllowlist('bob@gmail.com', entries), true);
  assert.equal(matchesAllowlist('alice@other.com', entries), false);
  assert.equal(matchesAllowlist('eve@notexample.com', entries), false,
    'a domain entry must match the whole domain');
  assert.equal(matchesAllowlist('', entries), false);
  assert.equal(matchesAllowlist(undefined, entries), false);
  // an empty list is no restriction: anyone with an account may sign in
  assert.deepEqual(parseAllowlist(''), []);
  assert.equal(matchesAllowlist('anyone@anywhere.example', []), true);
});

test('auth: the PKCE challenge is the hash of the verifier', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(createPkce().verifier, verifier);
});

test('auth: secretEquals compares without leaking length', () => {
  assert.equal(secretEquals('s3cret', 's3cret'), true);
  assert.equal(secretEquals('s3cret', 's3cre'), false);
  assert.equal(secretEquals('', ''), true);
});

// One key pair for the whole file: generating RSA-2048 is slow enough to
// notice, and every case below is about the token, not the key.
const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function signJwt(header, payload, privateKey = KEYS.privateKey) {
  const input = b64({ alg: 'RS256', typ: 'JWT', ...header }) + '.' + b64(payload);
  const signature = privateKey
    ? nodeCryptoSign('sha256', Buffer.from(input), privateKey).toString('base64url')
    : '';
  return input + '.' + signature;
}

const NOW = Date.UTC(2026, 8, 1);
const CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: 'client-id.apps.googleusercontent.com',
  sub: '1234567890',
  email: 'user@example.com',
  email_verified: true,
  nonce: 'the-nonce',
  iat: Math.floor(NOW / 1000) - 30,
  exp: Math.floor(NOW / 1000) + 3600,
};
const EXPECT = {
  key: KEYS.publicKey,
  issuer: 'https://accounts.google.com',
  clientId: CLAIMS.aud,
  nonce: 'the-nonce',
  now: NOW,
};

test('auth: a well-formed id_token verifies and gives back its claims', () => {
  const payload = verifyIdToken(signJwt({ kid: 'k1' }, CLAIMS), EXPECT);
  assert.equal(payload.sub, '1234567890');
  assert.equal(payload.email, 'user@example.com');
  assert.equal(decodeJwt(signJwt({ kid: 'k1' }, CLAIMS)).header.kid, 'k1',
    'the caller picks its key by kid before verifying');
});

test('auth: an id_token is rejected for every reason it should be', () => {
  const bad = (label, token, expect = EXPECT) =>
    assert.throws(() => verifyIdToken(token, expect), Error, label);

  bad('alg: none', signJwt({ alg: 'none' }, CLAIMS, null));
  bad('alg: HS256', signJwt({ alg: 'HS256' }, CLAIMS));
  bad('signed with another key', signJwt({}, CLAIMS, OTHER.privateKey));
  bad('wrong issuer', signJwt({}, { ...CLAIMS, iss: 'https://evil.example' }));
  bad('wrong audience', signJwt({}, { ...CLAIMS, aud: 'someone-else' }));
  bad('audience array without us', signJwt({}, { ...CLAIMS, aud: ['a', 'b'] }));
  bad('expired', signJwt({}, { ...CLAIMS, exp: Math.floor(NOW / 1000) - 61 }));
  bad('no exp at all', signJwt({}, { ...CLAIMS, exp: undefined }));
  bad('exp as a string', signJwt({}, { ...CLAIMS, exp: String(CLAIMS.exp) }));
  bad('issued in the future', signJwt({}, { ...CLAIMS, iat: Math.floor(NOW / 1000) + 300 }));
  bad('nonce mismatch', signJwt({}, { ...CLAIMS, nonce: 'someone elses' }));
  bad('no nonce', signJwt({}, { ...CLAIMS, nonce: undefined }));
  bad('no sub', signJwt({}, { ...CLAIMS, sub: undefined }));
  bad('empty sub', signJwt({}, { ...CLAIMS, sub: '' }));
  bad('two parts only', signJwt({}, CLAIMS).split('.').slice(0, 2).join('.'));
  bad('payload is not JSON', b64({ alg: 'RS256' }) + '.bm90IGpzb24.sig');
  bad('payload is an array', signJwt({}, [1, 2, 3]));
  bad('not a string at all', 12345);
  bad('no key for it', signJwt({}, CLAIMS), { ...EXPECT, key: null });

  // the tolerances are two-sided: just-expired and just-issued still pass
  assert.ok(verifyIdToken(signJwt({}, { ...CLAIMS, exp: Math.floor(NOW / 1000) - 30 }), EXPECT));
  assert.ok(verifyIdToken(signJwt({}, { ...CLAIMS, iat: Math.floor(NOW / 1000) + 30 }), EXPECT));
});

test('auth: an issuer without its scheme is the same issuer', () => {
  // Google has always issued `accounts.google.com` for tokens from
  // `https://accounts.google.com`
  const token = signJwt({}, { ...CLAIMS, iss: 'accounts.google.com' });
  assert.equal(verifyIdToken(token, EXPECT).sub, CLAIMS.sub);
  assert.throws(() => verifyIdToken(signJwt({}, { ...CLAIMS, iss: 'google.com' }), EXPECT));
});

// ---------------------------------------------------------------- runner

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.log('  ' + String(err && err.stack ? err.stack : err).split('\n').join('\n  '));
    failed += 1;
  }
}
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
