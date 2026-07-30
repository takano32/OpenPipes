// OpenPipes test suite — dependency-free, no network (all fetches are canned).
import assert from 'node:assert/strict';
import { parseFeed, buildRSS, escapeXml } from '../lib/feed.js';
import { runPipe, catalog, PipeError } from '../lib/engine.js';

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

test('catalog: all 23 module types with expected port layout', () => {
  const cat = catalog();
  assert.deepEqual(
    cat.map((d) => d.type).sort(),
    ['count', 'date_builder', 'fetch_feed', 'fetch_json', 'filter', 'item_builder',
      'loop', 'number_input', 'output', 'regex', 'rename', 'reverse', 'sort',
      'string_builder', 'strip_html', 'sub_element', 'tail', 'text_input', 'truncate',
      'union', 'unique', 'url_builder', 'url_input'],
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
