import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';

import { runPipe, catalog, PipeError } from './lib/engine.js';
import { buildJSONFeed, buildRSS } from './lib/feed.js';
import { httpError } from './lib/errors.js';
import { openStore, validatePipeBody } from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEMO_DIR = path.join(ROOT, 'assets', 'demo');
// The demo pipes ship as files rather than rows: they belong to nobody and are
// the same for every user, so they are read once at boot and never written.
const SYSTEM_PIPES_DIR = path.join(DEMO_DIR, 'pipes');
// Everything the server stores lives in one SQLite file. OPENPIPES_DB points
// it somewhere else; ':memory:' is what the test suites use.
const DB_PATH = (() => {
  const raw = process.env.OPENPIPES_DB;
  if (!raw) return path.join(ROOT, 'data', 'openpipes.db');
  return raw === ':memory:' ? ':memory:' : path.resolve(raw);
})();

// Refusing to start beats starting with a configuration that would only fail
// later, in the middle of somebody's login.
function bootFailure(message) {
  console.error(message);
  process.exit(1);
}

// The public origin, when it is not simply the Host header: the OAuth
// redirect_uri has to match what is registered with the provider exactly, and
// feed links should carry the address subscribers actually use.
const BASE_URL = (() => {
  const raw = process.env.OPENPIPES_BASE_URL;
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return bootFailure(`OPENPIPES_BASE_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return bootFailure(`OPENPIPES_BASE_URL must be an http(s) URL: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) {
    return bootFailure(
      `OPENPIPES_BASE_URL must be a bare origin such as https://pipes.example.com, not ${raw}`);
  }
  return url.origin; // no trailing slash
})();

// Owner of everything stored when there is no login: the single local operator.
const LOCAL_USER = 'local';

// PORT is the usual knob. SERVER_PORT is what Pterodactyl-style hosting panels
// export for the one allocation a container gets, so it serves as a fallback.
const PORT = Number(process.env.PORT) || Number(process.env.SERVER_PORT) || 3000;
// Where to bind. Unset means every interface, which a local run and a plain
// container both want. A host that fronts the app with its own proxy can ask
// for loopback only (OPENPIPES_HOST=127.0.0.1).
const HOST = process.env.OPENPIPES_HOST || undefined;
// Pipes fetch URLs chosen by whoever saved them, so non-public addresses are
// refused unless the operator opts in (a LAN-only deployment aggregating an
// intranet feed is a legitimate reason to).
const ALLOW_PRIVATE = process.env.OPENPIPES_ALLOW_PRIVATE === '1';
// Set OPENPIPES_PASSWORD to require Basic auth for the editor and everything
// behind it. Unset means open, which is what a local `node server.js` wants.
const AUTH_USER = process.env.OPENPIPES_USER || 'admin';
const AUTH_PASSWORD = process.env.OPENPIPES_PASSWORD || '';
// Refuses to modify stored pipes at all, whether or not a password is set.
const READ_ONLY = process.env.OPENPIPES_READONLY === '1';
// A published feed is polled on a timer by every subscriber, and each poll
// re-fetches every upstream the pipe names. Seconds; 0 disables.
const CACHE_TTL_SECONDS = (() => {
  const raw = Number(process.env.OPENPIPES_CACHE_TTL);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300;
})();
const CACHE_MAX_ENTRIES = 100;
const MAX_BODY_BYTES = 1024 * 1024;

// key -> { expires, etag, contentType, body }, in insertion order so the
// oldest can be dropped once it is full.
const feedCache = new Map();

function cacheGet(key) {
  const hit = feedCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    feedCache.delete(key);
    return null;
  }
  feedCache.delete(key); // reinsert: least recently used ends up first
  feedCache.set(key, hit);
  return hit;
}

function cacheSet(key, entry) {
  if (!CACHE_TTL_SECONDS) return;
  feedCache.set(key, entry);
  while (feedCache.size > CACHE_MAX_ENTRIES) {
    feedCache.delete(feedCache.keys().next().value);
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/rss+xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Hashing first so the comparison is over equal-length buffers whatever the
// inputs were.
function secretEquals(a, b) {
  const digest = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function requireAuth(req) {
  if (!AUTH_PASSWORD) return;
  const unauthorized = () => httpError(401, 'Authentication required',
    { 'WWW-Authenticate': 'Basic realm="OpenPipes", charset="UTF-8"' });
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (!/^basic$/i.test(scheme || '') || !encoded) throw unauthorized();
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) throw unauthorized();
  const user = secretEquals(decoded.slice(0, sep), AUTH_USER);
  const pass = secretEquals(decoded.slice(sep + 1), AUTH_PASSWORD);
  if (!user || !pass) throw unauthorized();
}

function requireWritable() {
  if (READ_ONLY) throw httpError(403, 'This OpenPipes instance is read-only');
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Short enough to read in the boot line, absolute when it is somewhere else.
function dbLabel() {
  if (DB_PATH === ':memory:') return ':memory:';
  const rel = path.relative(ROOT, DB_PATH);
  return rel && !rel.startsWith('..') ? rel : DB_PATH;
}

function baseUrlOf(req) {
  return BASE_URL || 'http://' + (req.headers.host || '127.0.0.1:' + PORT);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.removeListener('data', onData);
        req.resume();
        reject(httpError(413, 'Request body too large (max 1 MB)'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSONBody(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

// What the Loop module gets to call. Bound to one owner, so a sub-pipe lookup
// can only ever reach that owner's pipes and the built-in demos: the public
// feed URL stays the only path by which one user's data reaches another.
const loaderFor = (ownerId) => (id) => {
  const pipe = store.getPipe(id, ownerId);
  if (!pipe) throw httpError(404, 'Pipe not found: ' + id);
  return pipe;
};

async function serveFile(res, rootDir, relPath) {
  const filePath = path.resolve(rootDir, relPath);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
    throw httpError(403, 'Forbidden');
  }
  let data;
  try {
    data = await readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
      throw httpError(404, 'Not found: /' + relPath);
    }
    throw err;
  }
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(data);
}

async function handleModules(req, res) {
  sendJSON(res, 200, catalog());
}

// What the editor needs to know about how this instance is configured.
async function handleConfig(req, res) {
  sendJSON(res, 200, { readOnly: READ_ONLY, authRequired: Boolean(AUTH_PASSWORD) });
}

async function handleRunAdHoc(req, res) {
  const body = await readJSONBody(req);
  if (typeof body !== 'object' || body === null || typeof body.pipe !== 'object' || body.pipe === null) {
    throw httpError(400, 'Body must be {"pipe": {...}, "params": {...}?}');
  }
  const result = await runPipe(body.pipe, {
    params: body.params || {},
    baseUrl: baseUrlOf(req),
    allowPrivate: ALLOW_PRIVATE,
    loadPipe: loaderFor(LOCAL_USER), // the Loop module runs a saved pipe per item
  });
  sendJSON(res, 200, result);
}

async function handleListPipes(req, res) {
  sendJSON(res, 200, store.listPipes(LOCAL_USER));
}

async function handleSavePipe(req, res) {
  const body = await readJSONBody(req);
  validatePipeBody(body);
  sendJSON(res, 200, store.savePipe(LOCAL_USER, body));
}

async function handleGetPipe(req, res, match) {
  const pipe = store.getPipe(match[1], LOCAL_USER);
  if (!pipe) throw httpError(404, 'Pipe not found: ' + match[1]);
  sendJSON(res, 200, pipe);
}

async function handleDeletePipe(req, res, match) {
  store.deletePipe(match[1], LOCAL_USER);
  sendJSON(res, 200, { ok: true });
}

// Answers with a rendered feed, as a 304 when the client already has it.
function sendFeed(req, res, entry, cacheState) {
  const headers = {
    'Content-Type': entry.contentType,
    ETag: entry.etag,
    'Cache-Control': CACHE_TTL_SECONDS
      ? `public, max-age=${CACHE_TTL_SECONDS}`
      : 'no-cache',
    'X-OpenPipes-Cache': cacheState,
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(entry.body);
}

async function handleRunSaved(req, res, match, url) {
  const published = store.publishedPipe(match[1]);
  if (!published) throw httpError(404, 'Pipe not found: ' + match[1]);
  const { pipe, ownerId } = published;
  const outputs = (pipe.modules || []).filter((m) => m && m.type === 'output');
  if (outputs.length !== 1) {
    throw httpError(400, 'Pipe must have exactly one output module');
  }

  // savedAt is in the key, so saving the pipe invalidates its cached output;
  // host and the raw query are in it because both change the rendered body.
  const key = JSON.stringify([match[1], pipe.savedAt, req.headers.host || '', req.url]);
  const fresh = /(^|,)\s*no-cache(\s*,|$)/.test(req.headers['cache-control'] || '');
  if (!fresh) {
    const hit = cacheGet(key);
    if (hit) {
      sendFeed(req, res, hit, 'hit');
      return;
    }
  }

  const params = {};
  for (const [key2, value] of url.searchParams) {
    if (key2 !== 'format') params[key2] = value;
  }

  const result = await runPipe(pipe,
    { params, baseUrl: baseUrlOf(req), allowPrivate: ALLOW_PRIVATE, loadPipe: loaderFor(ownerId) });
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    // a failed run is never cached: the upstream may just be having a moment
    throw httpError(502, result.errors.map((e) => `${e.module}: ${e.message}`).join('; '));
  }

  const format = url.searchParams.get('format');
  const feed = {
    title: pipe.name,
    link: baseUrlOf(req) + req.url,
    description: 'OpenPipes: ' + pipe.name,
    items: result.items,
  };
  let body;
  let contentType;
  if (format === 'json') {
    // the plain shape this endpoint has always returned
    body = JSON.stringify({ items: result.items });
    contentType = 'application/json; charset=utf-8';
  } else if (format === 'jsonfeed') {
    body = buildJSONFeed(feed);
    contentType = 'application/feed+json; charset=utf-8';
  } else {
    body = buildRSS(feed);
    contentType = 'application/rss+xml; charset=utf-8';
  }
  const entry = {
    expires: Date.now() + CACHE_TTL_SECONDS * 1000,
    etag: '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27) + '"',
    contentType,
    body,
  };
  cacheSet(key, entry);
  sendFeed(req, res, entry, 'miss');
}

async function handleDemoFile(req, res, match) {
  await serveFile(res, DEMO_DIR, match[1]);
}

async function handleStatic(req, res, match) {
  const pathname = match[0];
  await serveFile(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
}

// `public` routes stay reachable without credentials: a published feed has to
// be readable by an RSS client, and the engine fetches /demo/*.xml over HTTP
// from itself when a pipe uses a relative URL.
// `writes` routes are the ones read-only mode refuses.
const ROUTES = [
  { method: 'GET', pattern: /^\/api\/config$/, handler: handleConfig, public: true },
  { method: 'GET', pattern: /^\/api\/modules$/, handler: handleModules },
  { method: 'POST', pattern: /^\/api\/run$/, handler: handleRunAdHoc },
  { method: 'GET', pattern: /^\/api\/pipes$/, handler: handleListPipes },
  { method: 'POST', pattern: /^\/api\/pipes$/, handler: handleSavePipe, writes: true },
  { method: 'GET', pattern: /^\/api\/pipes\/([^/]+)$/, handler: handleGetPipe },
  { method: 'DELETE', pattern: /^\/api\/pipes\/([^/]+)$/, handler: handleDeletePipe, writes: true },
  { method: 'GET', pattern: /^\/pipes\/([^/]+)\/run$/, handler: handleRunSaved, public: true },
  { method: 'GET', pattern: /^\/demo\/([^/]+\.xml)$/, handler: handleDemoFile, public: true },
  { method: 'GET', pattern: /^\/.*$/, handler: handleStatic },
];

async function dispatch(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw httpError(400, 'Malformed request path');
  }
  if (pathname.includes('\0')) throw httpError(400, 'Malformed request path');
  if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;
    if (!route.public) requireAuth(req);
    if (route.writes) requireWritable();
    await route.handler(req, res, match, url);
    return;
  }
  throw httpError(404, 'Not found: ' + req.method + ' ' + pathname);
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  dispatch(req, res).catch((err) => {
    const status = Number.isInteger(err?.status) ? err.status : err instanceof PipeError ? 400 : 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    for (const [name, value] of Object.entries(err?.headers || {})) {
      res.setHeader(name, value);
    }
    sendJSON(res, status, { error: err?.message || 'Internal server error' });
  });
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

if (DB_PATH !== ':memory:') await mkdir(path.dirname(DB_PATH), { recursive: true });
let store;
try {
  store = openStore({ dbPath: DB_PATH, systemPipesDir: SYSTEM_PIPES_DIR });
} catch (err) {
  bootFailure(`Failed to open the database: ${err.message}`);
}
store.ensureLocalUser();
store.purgeExpiredSessions();
// Rows of dead sessions are harmless but unbounded; sweep them now and then.
setInterval(() => store.purgeExpiredSessions(), 3600_000).unref();

// A container stops the process with a signal, and an unclosed WAL means the
// next boot has to recover it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}

server.on('error', (err) => {
  // a server that cannot bind must not linger as a zombie process
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
server.listen({ port: PORT, host: HOST }, () => {
  const notes = [`db ${dbLabel()}`];
  if (AUTH_PASSWORD) notes.push(`auth as "${AUTH_USER}"`);
  if (READ_ONLY) notes.push('read-only');
  if (ALLOW_PRIVATE) notes.push('private addresses allowed');
  console.log(`OpenPipes listening on http://${HOST || 'localhost'}:${PORT}` +
    (notes.length ? ` (${notes.join(', ')})` : ''));
});
