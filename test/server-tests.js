// HTTP-level tests: spawn server.js with a given environment and talk to it.
// Dependency-free, and no outbound network — every request is to the instance
// we just started. Run by `npm test` after the unit suite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let nextPort = 24000 + (process.pid % 1000) * 10;

// Starts an instance with its own throwaway data directory, seeded with the
// demo pipes so the fixtures are the ones the app ships.
async function withServer(env, body) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpipes-http-'));
  await cp(path.join(ROOT, 'data', 'pipes'), dataDir, { recursive: true });
  const port = nextPort++;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), OPENPIPES_DATA: dataDir, ...env },
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
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
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

test('read-only: the demo pipe really is still on disk afterwards', () =>
  withServer({ OPENPIPES_READONLY: '1' }, async ({ origin }) => {
    await fetch(`${origin}/api/pipes/demo-merged`, { method: 'DELETE' });
    assert.equal((await fetch(`${origin}/api/pipes/demo-merged`)).status, 200);
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
