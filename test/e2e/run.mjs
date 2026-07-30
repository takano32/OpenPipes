// Browser tests for the editor. Starts its own server against a throwaway
// data directory, launches a headless Chromium, runs every suite, tears both
// down. No dependencies: the CDP client lives in driver.mjs.
//
//   npm run test:e2e
//
// Set CHROME_BIN if your browser is not on PATH under a usual name.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromeCandidates, connect, sleep, waitFor } from './driver.mjs';
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

async function startBrowser(port) {
  for (const bin of chromeCandidates()) {
    const { child, log } = spawnQuiet(bin, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--window-size=1440,900', `--remote-debugging-port=${port}`, 'about:blank',
    ]);
    try {
      await waitFor(`${bin} devtools`, async () =>
        (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, { tries: 40 });
      return { child, bin };
    } catch {
      child.kill('SIGKILL');
      if (log.join('').includes('ENOENT')) continue;
    }
  }
  throw new Error(
    'no usable Chromium found — tried: ' + chromeCandidates().join(', ') +
    '. Install chromium or set CHROME_BIN.');
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'openpipes-e2e-'));
// the suites expect the shipped demo pipes to be loadable
await cp(path.join(ROOT, 'data', 'pipes'), dataDir, { recursive: true });

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

const appPort = await freePort();
const cdpPort = await freePort();
const origin = `http://127.0.0.1:${appPort}`;

const server = spawnQuiet(process.execPath, [path.join(ROOT, 'server.js')],
  { PORT: String(appPort), OPENPIPES_DATA: dataDir });
let browser = null;
let page = null;
let failures = 0;
let passed = 0;

const cleanup = async () => {
  try { page?.close(); } catch { /* already gone */ }
  server.child.kill('SIGKILL');
  browser?.child.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
};

try {
  await waitFor('the OpenPipes server', async () => (await fetch(`${origin}/api/modules`)).ok);
  browser = await startBrowser(cdpPort);
  console.log(`browser: ${browser.bin}   app: ${origin}\n`);

  for (const [name, run] of suites) {
    page = await connect(cdpPort);
    const before = failures;
    const check = (label, ok, extra) => {
      if (ok) { passed += 1; console.log(`  ok   ${label}`); return; }
      failures += 1;
      console.log(`  FAIL ${label}` + (extra === undefined ? '' : `  → ${JSON.stringify(extra)}`));
    };
    console.log(name);
    try {
      await run({ page, origin, check });
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
  const log = server.log.join('').trim();
  if (log) console.error('server output:\n' + log.split('\n').slice(-8).join('\n'));
} finally {
  await cleanup();
}

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
