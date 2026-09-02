// HTTP-level tests: spawn server.js with a given environment and talk to it.
// Dependency-free, and no outbound network — every request is to the instance
// we just started. Run by `npm test` after the unit suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let nextPort = 24000 + (process.pid % 1000) * 10;

// Starts an instance on its own port against an in-memory database, so runs
// never touch each other or the repository. The demo pipes are read from
// assets/demo/pipes/ by the server itself, so every instance has them.
// `env` may be a function of the chosen port, for tests about the port itself
// and for anything that has to know its own origin up front.
async function withServer(env, body) {
  const port = nextPort++;
  const extra = typeof env === 'function' ? env(port) : env;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), OPENPIPES_DB: ':memory:', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try {
        await fetch(`${origin}/api/config`);
        break;
      } catch {
        if (i > 60) throw new Error('server did not start: ' + log.join(''));
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return await body({ origin, log });
  } finally {
    child.kill('SIGKILL');
  }
}

// A misconfigured instance must refuse to start and say which variable is
// wrong, instead of coming up and failing later in the middle of a login.
async function expectBootFailure(env, pattern) {
  const port = nextPort++;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), OPENPIPES_DB: ':memory:', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1, 'the server should have refused to start; output: ' + log.join(''));
  assert.match(log.join(''), pattern);
}

const basic = (user, pass) =>
  ({ authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });

const NEW_PIPE = JSON.stringify({
  name: 'http test',
  modules: [{ id: 'm1', type: 'output', params: {}, x: 0, y: 0 }],
  wires: [],
});
const asJSON = { 'content-type': 'application/json' };

// ---------------------------------------------------------------- open by default

test('no password: everything is reachable, as a local run expects', () =>
  withServer({}, async ({ origin }) => {
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/api/modules`)).status, 200);
    const saved = await fetch(`${origin}/api/pipes`, { method: 'POST', headers: asJSON, body: NEW_PIPE });
    assert.equal(saved.status, 200);
    const { id } = await saved.json();
    assert.equal((await fetch(`${origin}/api/pipes/${id}`, { method: 'DELETE' })).status, 200);
    const config = await (await fetch(`${origin}/api/config`)).json();
    assert.deepEqual(config, { readOnly: false, authRequired: false });
  }));

// ---------------------------------------------------------------------- port

test('SERVER_PORT is honoured when PORT is unset, as Pterodactyl panels export it', () =>
  withServer((port) => ({ PORT: '', SERVER_PORT: String(port) }), async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/config`)).status, 200);
  }));

test('PORT wins over SERVER_PORT when both are set', () =>
  // withServer only talks to PORT; if SERVER_PORT won, nothing would answer there
  withServer((port) => ({ SERVER_PORT: String(port + 1000) }), async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/config`)).status, 200);
  }));

test('OPENPIPES_HOST binds to that address only', () =>
  withServer({ OPENPIPES_HOST: '127.0.0.1' }, async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/config`)).status, 200);
    // the IPv6 loopback is not bound (on a host without IPv6 this fails for that reason instead)
    await assert.rejects(fetch(origin.replace('127.0.0.1', '[::1]') + '/api/config'));
  }));

// ---------------------------------------------------------------------- auth

test('with a password: the editor and its API answer 401 until you send one', () =>
  withServer({ OPENPIPES_PASSWORD: 's3cret' }, async ({ origin }) => {
    for (const p of ['/', '/editor.js', '/api/modules', '/api/pipes', '/api/pipes/demo-merged']) {
      const res = await fetch(origin + p);
      assert.equal(res.status, 401, `${p} should be protected`);
      assert.match(res.headers.get('www-authenticate') || '', /^Basic realm="OpenPipes"/);
    }
    assert.equal((await fetch(`${origin}/api/run`, {
      method: 'POST', headers: asJSON, body: '{"pipe":{"name":"x","modules":[],"wires":[]}}',
    })).status, 401);
    assert.equal((await fetch(`${origin}/api/pipes`, {
      method: 'POST', headers: asJSON, body: NEW_PIPE,
    })).status, 401);
    assert.equal((await fetch(`${origin}/api/pipes/demo-merged`, { method: 'DELETE' })).status, 401);
  }));

test('with a password: correct credentials get through, wrong ones do not', () =>
  withServer({ OPENPIPES_PASSWORD: 's3cret' }, async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/modules`, { headers: basic('admin', 's3cret') })).status, 200);
    assert.equal((await fetch(`${origin}/api/modules`, { headers: basic('admin', 'wrong') })).status, 401);
    assert.equal((await fetch(`${origin}/api/modules`, { headers: basic('root', 's3cret') })).status, 401);
    assert.equal((await fetch(`${origin}/api/modules`, { headers: { authorization: 'Bearer s3cret' } })).status, 401);
    assert.equal((await fetch(`${origin}/api/modules`, { headers: { authorization: 'Basic !!not base64' } })).status, 401);
  }));

test('with a password: OPENPIPES_USER changes the account name', () =>
  withServer({ OPENPIPES_PASSWORD: 'pw', OPENPIPES_USER: 'editor' }, async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/modules`, { headers: basic('editor', 'pw') })).status, 200);
    assert.equal((await fetch(`${origin}/api/modules`, { headers: basic('admin', 'pw') })).status, 401);
  }));

test('with a password: published feeds and demo assets stay public', () =>
  withServer({ OPENPIPES_PASSWORD: 's3cret' }, async ({ origin }) => {
    // an RSS reader cannot log in, and the engine fetches /demo/*.xml from itself
    const feed = await fetch(`${origin}/pipes/demo-tech-filter/run`);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), /<rss/);
    assert.equal((await fetch(`${origin}/demo/tech.xml`)).status, 200);
    const config = await (await fetch(`${origin}/api/config`)).json();
    assert.deepEqual(config, { readOnly: false, authRequired: true });
  }));

test('with a password: a pipe with a relative URL still resolves its own assets', () =>
  withServer({ OPENPIPES_PASSWORD: 's3cret' }, async ({ origin }) => {
    const res = await fetch(`${origin}/pipes/demo-tech-filter/run?format=json`);
    assert.equal(res.status, 200);
    const { items } = await res.json();
    assert.ok(items.length > 0, 'the engine could not fetch /demo/tech.xml');
  }));

// ----------------------------------------------------------------- read-only

test('read-only: saving and deleting are refused, reading is not', () =>
  withServer({ OPENPIPES_READONLY: '1' }, async ({ origin }) => {
    const save = await fetch(`${origin}/api/pipes`, { method: 'POST', headers: asJSON, body: NEW_PIPE });
    assert.equal(save.status, 403);
    assert.match((await save.json()).error, /read-only/);
    assert.equal((await fetch(`${origin}/api/pipes/demo-merged`, { method: 'DELETE' })).status, 403);

    assert.equal((await fetch(`${origin}/api/pipes`)).status, 200);
    assert.equal((await fetch(`${origin}/api/pipes/demo-merged`)).status, 200);
    assert.equal((await fetch(`${origin}/pipes/demo-merged/run`)).status, 200);
    const config = await (await fetch(`${origin}/api/config`)).json();
    assert.equal(config.readOnly, true);
  }));

test('read-only: the demo pipe really is still listed afterwards', () =>
  withServer({ OPENPIPES_READONLY: '1' }, async ({ origin }) => {
    await fetch(`${origin}/api/pipes/demo-merged`, { method: 'DELETE' });
    assert.equal((await fetch(`${origin}/api/pipes/demo-merged`)).status, 200);
    const list = await (await fetch(`${origin}/api/pipes`)).json();
    assert.ok(list.some((p) => p.id === 'demo-merged'));
  }));

test('read-only and a password combine', () =>
  withServer({ OPENPIPES_READONLY: '1', OPENPIPES_PASSWORD: 'pw' }, async ({ origin }) => {
    assert.equal((await fetch(`${origin}/api/pipes`, {
      method: 'POST', headers: asJSON, body: NEW_PIPE,
    })).status, 401, 'unauthenticated writes are rejected before the read-only check');
    assert.equal((await fetch(`${origin}/api/pipes`, {
      method: 'POST', headers: { ...asJSON, ...basic('admin', 'pw') }, body: NEW_PIPE,
    })).status, 403);
    assert.equal((await fetch(`${origin}/pipes/demo-merged/run`)).status, 200);
  }));

// ------------------------------------------------------------------- cache

const feed = (origin, q = '') => fetch(`${origin}/pipes/demo-tech-filter/run${q}`);

test('cache: a published feed is computed once and then served from memory', () =>
  withServer({}, async ({ origin }) => {
    const first = await feed(origin);
    assert.equal(first.headers.get('x-openpipes-cache'), 'miss');
    assert.equal(first.headers.get('cache-control'), 'public, max-age=300');
    const etag = first.headers.get('etag');
    assert.ok(etag, 'an ETag is required for conditional requests');

    const second = await feed(origin);
    assert.equal(second.headers.get('x-openpipes-cache'), 'hit');
    assert.equal(second.headers.get('etag'), etag);
    assert.equal(await second.text(), await first.text());
  }));

test('cache: If-None-Match gets a 304 with no body', () =>
  withServer({}, async ({ origin }) => {
    const etag = (await feed(origin)).headers.get('etag');
    const res = await feed(origin);
    await res.text();
    const conditional = await fetch(`${origin}/pipes/demo-tech-filter/run`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), '');
  }));

test('cache: different query parameters and formats are separate entries', () =>
  withServer({}, async ({ origin }) => {
    await feed(origin, '?q=AI');
    assert.equal((await feed(origin, '?q=AI')).headers.get('x-openpipes-cache'), 'hit');
    assert.equal((await feed(origin, '?q=Rust')).headers.get('x-openpipes-cache'), 'miss');
    assert.equal((await feed(origin, '?q=Rust&format=json')).headers.get('x-openpipes-cache'), 'miss');
    const json = await feed(origin, '?q=Rust&format=json');
    assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal((await json.json()).items.length, 1);
  }));

test('cache: Cache-Control: no-cache recomputes', () =>
  withServer({}, async ({ origin }) => {
    await feed(origin);
    const res = await fetch(`${origin}/pipes/demo-tech-filter/run`, {
      headers: { 'cache-control': 'no-cache' },
    });
    assert.equal(res.headers.get('x-openpipes-cache'), 'miss');
  }));

test('cache: saving the pipe invalidates what was cached for it', () =>
  withServer({}, async ({ origin }) => {
    // the demo itself is read-only, so this works on a copy of it
    const demo = await (await fetch(`${origin}/api/pipes/demo-tech-filter`)).json();
    const copy = await (await fetch(`${origin}/api/pipes`, {
      method: 'POST', headers: asJSON,
      body: JSON.stringify({ name: 'cache copy', modules: demo.modules, wires: demo.wires }),
    })).json();
    const own = (q = '') => fetch(`${origin}/pipes/${copy.id}/run${q}`);

    const before = await (await own()).text();
    assert.equal((await own()).headers.get('x-openpipes-cache'), 'hit');

    const save = await fetch(`${origin}/api/pipes`, {
      method: 'POST', headers: asJSON,
      body: JSON.stringify({
        id: copy.id, name: 'renamed by the cache test', modules: demo.modules, wires: demo.wires,
      }),
    });
    assert.equal(save.status, 200);

    const after = await own();
    assert.equal(after.headers.get('x-openpipes-cache'), 'miss');
    const body = await after.text();
    assert.notEqual(body, before);
    assert.match(body, /renamed by the cache test/);
  }));

test('cache: OPENPIPES_CACHE_TTL=0 turns it off', () =>
  withServer({ OPENPIPES_CACHE_TTL: '0' }, async ({ origin }) => {
    await feed(origin);
    const res = await feed(origin);
    assert.equal(res.headers.get('x-openpipes-cache'), 'miss');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    // conditional requests still work, they just re-run the pipe
    const etag = res.headers.get('etag');
    await res.text();
    const conditional = await fetch(`${origin}/pipes/demo-tech-filter/run`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(conditional.status, 304);
  }));

test('cache: a failing run is not cached', () =>
  withServer({}, async ({ origin }) => {
    const broken = {
      name: 'broken',
      modules: [
        { id: 'm1', type: 'fetch_feed', params: { urls: ['http://127.0.0.1:9/nope.xml'] }, x: 0, y: 0 },
        { id: 'm2', type: 'output', params: {}, x: 0, y: 0 },
      ],
      wires: [{ id: 'w1', from: { module: 'm1', port: 'out' }, to: { module: 'm2', port: 'in' } }],
    };
    // an id is assigned by the server: POST only ever updates a pipe you own
    const { id } = await (await fetch(`${origin}/api/pipes`,
      { method: 'POST', headers: asJSON, body: JSON.stringify(broken) })).json();
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${origin}/pipes/${id}/run`);
      assert.equal(res.status, 502);
      assert.equal(res.headers.get('x-openpipes-cache'), null);
    }
  }));

test('jsonfeed: the published feed can be served as JSON Feed 1.1', () =>
  withServer({}, async ({ origin }) => {
    const res = await feed(origin, '?format=jsonfeed');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/feed+json; charset=utf-8');
    const body = await res.json();
    assert.equal(body.version, 'https://jsonfeed.org/version/1.1');
    assert.equal(body.title, 'デモ: テックニュース絞り込み');
    assert.ok(body.items.length > 0);
    for (const item of body.items) {
      assert.ok(item.id, 'every item needs an id');
      assert.match(item.url, /^https:\/\//);
    }
  }));

test('jsonfeed: rss, json and jsonfeed are three separate cache entries', () =>
  withServer({}, async ({ origin }) => {
    const seen = new Set();
    for (const q of ['', '?format=json', '?format=jsonfeed']) {
      const res = await feed(origin, q);
      assert.equal(res.headers.get('x-openpipes-cache'), 'miss', q || '(rss)');
      seen.add(res.headers.get('etag'));
      assert.equal((await feed(origin, q)).headers.get('x-openpipes-cache'), 'hit');
    }
    assert.equal(seen.size, 3, 'each format should hash differently');
  }));

// ------------------------------------------------------------- system pipes

test('system pipes: the demos are listed read-only and cannot be written', () =>
  withServer({}, async ({ origin }) => {
    const list = await (await fetch(`${origin}/api/pipes`)).json();
    const demo = list.find((p) => p.id === 'demo-merged');
    assert.ok(demo, 'the shipped demos should be listed');
    assert.equal(demo.readOnly, true);

    const over = await fetch(`${origin}/api/pipes`, {
      method: 'POST', headers: asJSON,
      body: JSON.stringify({ id: 'demo-merged', name: 'hijacked', modules: [], wires: [] }),
    });
    assert.equal(over.status, 403);
    assert.match((await over.json()).error, /built-in demo/);

    const del = await fetch(`${origin}/api/pipes/demo-merged`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    const after = await (await fetch(`${origin}/api/pipes`)).json();
    assert.ok(after.some((p) => p.id === 'demo-merged'), 'the demo must survive');
  }));

test('system pipes: a saved pipe of your own is listed as writable', () =>
  withServer({}, async ({ origin }) => {
    const { id } = await (await fetch(`${origin}/api/pipes`,
      { method: 'POST', headers: asJSON, body: NEW_PIPE })).json();
    const list = await (await fetch(`${origin}/api/pipes`)).json();
    const mine = list.find((p) => p.id === id);
    assert.equal(mine.readOnly, false);
    assert.equal(list.indexOf(mine), 0, 'own pipes come before the demos');
    assert.equal((await (await fetch(`${origin}/api/pipes/${id}`)).json()).readOnly, false);
  }));

test('system pipes: a demo whose Loop names another demo still runs', () =>
  withServer({}, async ({ origin }) => {
    const res = await fetch(`${origin}/pipes/demo-loop/run?format=json`);
    assert.equal(res.status, 200);
    const { items } = await res.json();
    assert.ok(items.length > 0, 'demo-loop could not reach demo-headline');
  }));

// ----------------------------------------------------------------- base URL

test('OPENPIPES_BASE_URL is what feed links carry, not the Host header', () =>
  // localhost resolves to the running server, which matters: the demo pipe
  // fetches /demo/*.xml relative to the base URL and the suite has no network
  withServer((port) => ({ OPENPIPES_BASE_URL: `http://localhost:${port}` }), async ({ origin }) => {
    const res = await fetch(`${origin}/pipes/demo-merged/run`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const link = body.match(/<link>([^<]+)<\/link>/)[1];
    const self = body.match(/<atom:link href="([^"]+)" rel="self"/)[1];
    assert.match(link, /^http:\/\/localhost:/);
    assert.match(self, /^http:\/\/localhost:/);
  }));

test('OPENPIPES_BASE_URL must be a bare origin', async () => {
  await expectBootFailure({ OPENPIPES_BASE_URL: 'https://x.example/sub/' }, /OPENPIPES_BASE_URL/);
  await expectBootFailure({ OPENPIPES_BASE_URL: 'ftp://x.example' }, /OPENPIPES_BASE_URL/);
  await expectBootFailure({ OPENPIPES_BASE_URL: 'not a url' }, /OPENPIPES_BASE_URL/);
});

test('OPENPIPES_BASE_URL may carry a trailing slash', () =>
  withServer((port) => ({ OPENPIPES_BASE_URL: `http://localhost:${port}/` }), async ({ origin }) => {
    const body = await (await fetch(`${origin}/pipes/demo-merged/run`)).text();
    assert.match(body.match(/<link>([^<]+)<\/link>/)[1], /^http:\/\/localhost:\d+\/pipes\//);
  }));

// ------------------------------------------------------------- address filter

test('a pipe cannot reach loopback through the run endpoint', () =>
  withServer({}, async ({ origin }) => {
    const res = await fetch(`${origin}/api/run`, {
      method: 'POST',
      headers: asJSON,
      body: JSON.stringify({
        pipe: {
          name: 'ssrf',
          modules: [
            { id: 'm1', type: 'fetch_json', params: { url: 'http://169.254.169.254/latest/', path: '' }, x: 0, y: 0 },
            { id: 'm2', type: 'output', params: {}, x: 0, y: 0 },
          ],
          wires: [{ id: 'w1', from: { module: 'm1', port: 'out' }, to: { module: 'm2', port: 'in' } }],
        },
      }),
    });
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.match(body.errors[0].message, /non-public address/);
  }));

// ------------------------------------------------------------------- runner

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
