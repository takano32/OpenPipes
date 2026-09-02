// Browser tests for the editor. Starts its own server against a throwaway
// data directory, launches a headless Chromium, runs every suite, tears both
// down. No dependencies: the CDP client lives in driver.mjs.
//
//   npm run test:e2e
//
// Set CHROME_BIN if your browser is not on PATH under a usual name.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromeCandidates, connect, sleep, waitFor } from './driver.mjs';
import { startFakeIssuer } from '../fake-issuer.mjs';
import { suites } from './suites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (typeof WebSocket === 'undefined') {
  console.error('These tests need a global WebSocket (Node 22+). Skipping is not silent: failing.');
  process.exit(1);
}

function spawnQuiet(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.on('error', () => {});
  return { child, log };
}

// Chromium can take well over ten seconds to print its DevTools line on a
// loaded machine, so this waits a minute before giving up — and says which
// of the two things went wrong, since "not installed" and "did not start"
// need completely different fixes.
async function startBrowser(port) {
  const missing = [];
  for (const bin of chromeCandidates()) {
    const { child, log } = spawnQuiet(bin, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1440,900', `--remote-debugging-port=${port}`, 'about:blank',
    ]);
    try {
      await waitFor(`${bin} devtools`, async () =>
        (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, { tries: 240 });
      return { child, bin };
    } catch (err) {
      child.kill('SIGKILL');
      if (child.exitCode !== null || log.join('').includes('ENOENT')) {
        missing.push(bin);
        continue;
      }
      throw new Error(`${bin} never became ready:\n${log.join('').slice(-800)}`);
    }
  }
  throw new Error(
    'no usable browser found — tried: ' + missing.join(', ') +
    '. Install chromium or point CHROME_BIN at a browser.');
}

// Ports derived from the pid collide when two runs overlap — the second one
// then talks to the first one's dying browser. Ask the OS for free ones.
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// E2E_ONLY=<substring> runs only the suites whose name contains it.
const only = process.env.E2E_ONLY || '';

const appPort = await freePort();
const googlePort = await freePort();
const cdpPort = await freePort();
const origin = `http://127.0.0.1:${appPort}`;
// 127.0.0.1 rather than localhost, and byte for byte the base URL the second
// server is given: the session cookie and the Origin check are bound to it.
const googleOrigin = `http://127.0.0.1:${googlePort}`;

const server = spawnQuiet(process.execPath, [path.join(ROOT, 'server.js')],
  { PORT: String(appPort), OPENPIPES_DB: ':memory:' });

// A second instance in Google mode, against a fake provider in this process,
// so the gate and the user menu can be exercised without a real Google.
const issuer = await startFakeIssuer({ clientId: 'test', clientSecret: 'test-secret' });
const googleServer = spawnQuiet(process.execPath, [path.join(ROOT, 'server.js')], {
  PORT: String(googlePort),
  OPENPIPES_DB: ':memory:',
  OPENPIPES_GOOGLE_CLIENT_ID: 'test',
  OPENPIPES_GOOGLE_CLIENT_SECRET: 'test-secret',
  OPENPIPES_BASE_URL: googleOrigin,
  OPENPIPES_OIDC_ISSUER: issuer.issuer,
});
let browser = null;
let page = null;
let failures = 0;
let passed = 0;

const cleanup = async () => {
  try { page?.close(); } catch { /* already gone */ }
  server.child.kill('SIGKILL');
  googleServer.child.kill('SIGKILL');
  browser?.child.kill('SIGKILL');
  await issuer.close(); // an open listener would keep this process alive
};

try {
  await waitFor('the OpenPipes server', async () => (await fetch(`${origin}/api/modules`)).ok);
  await waitFor('the Google-mode server',
    async () => (await fetch(`${googleOrigin}/api/config`)).ok);
  browser = await startBrowser(cdpPort);
  console.log(`browser: ${browser.bin}   app: ${origin}   google: ${googleOrigin}\n`);

  for (const [name, run] of suites) {
    // A whole run takes minutes and loads the machine; E2E_ONLY=<substring>
    // narrows it to the suite you are working on.
    if (only && !name.includes(only)) continue;
    page = await connect(cdpPort);
    const before = failures;
    const check = (label, ok, extra) => {
      if (ok) { passed += 1; console.log(`  ok   ${label}`); return; }
      failures += 1;
      console.log(`  FAIL ${label}` + (extra === undefined ? '' : `  → ${JSON.stringify(extra)}`));
    };
    console.log(name);
    try {
      await run({ page, origin, googleOrigin, check });
      check('no page errors', page.pageErrors.length === 0, page.pageErrors.slice(0, 3));
    } catch (err) {
      failures += 1;
      console.log(`  FAIL ${name} threw: ${err.message}`);
    }
    if (failures === before) console.log('');
    else console.log(`  (${failures - before} failed in ${name})\n`);
    page.close();
    page = null;
    await sleep(100);
  }
} catch (err) {
  failures += 1;
  console.error('e2e setup failed:', err.message);
  const log = (server.log.join('') + googleServer.log.join('')).trim();
  if (log) console.error('server output:\n' + log.split('\n').slice(-8).join('\n'));
} finally {
  await cleanup();
}

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
