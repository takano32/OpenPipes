import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';

import { runPipe, catalog, PipeError } from './lib/engine.js';
import { buildRSS } from './lib/feed.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEMO_DIR = path.join(ROOT, 'assets', 'demo');
// OPENPIPES_DATA lets a test run point at a throwaway directory
const PIPES_DIR = process.env.OPENPIPES_DATA
  ? path.resolve(process.env.OPENPIPES_DATA)
  : path.join(ROOT, 'data', 'pipes');

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const PIPE_ID_RE = /^[a-z0-9-]{1,64}$/;

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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function baseUrlOf(req) {
  return 'http://' + (req.headers.host || '127.0.0.1:' + PORT);
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

function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 59)
    .replace(/-+$/, '');
  return slug || 'pipe';
}

async function loadPipe(id) {
  if (!PIPE_ID_RE.test(id)) throw httpError(400, 'Invalid pipe id');
  let text;
  try {
    text = await readFile(path.join(PIPES_DIR, id + '.json'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, 'Pipe not found: ' + id);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(500, 'Saved pipe file is corrupted: ' + id);
  }
}

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

async function handleRunAdHoc(req, res) {
  const body = await readJSONBody(req);
  if (typeof body !== 'object' || body === null || typeof body.pipe !== 'object' || body.pipe === null) {
    throw httpError(400, 'Body must be {"pipe": {...}, "params": {...}?}');
  }
  const result = await runPipe(body.pipe, {
    params: body.params || {},
    baseUrl: baseUrlOf(req),
  });
  sendJSON(res, 200, result);
}

async function handleListPipes(req, res) {
  let names = [];
  try {
    names = await readdir(PIPES_DIR);
  } catch {
    names = [];
  }
  const list = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const pipe = JSON.parse(await readFile(path.join(PIPES_DIR, name), 'utf8'));
      list.push({ id: pipe.id, name: pipe.name, savedAt: pipe.savedAt });
    } catch {
      // Skip unreadable/corrupt files rather than failing the listing.
    }
  }
  list.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  sendJSON(res, 200, list);
}

async function handleSavePipe(req, res) {
  const body = await readJSONBody(req);
  if (
    typeof body !== 'object' || body === null ||
    typeof body.name !== 'string' || !Array.isArray(body.modules) || !Array.isArray(body.wires)
  ) {
    throw httpError(400, 'Body must include name (string), modules (array) and wires (array)');
  }
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const moduleIds = new Set();
  for (const m of body.modules) {
    if (!isPlainObject(m) || typeof m.id !== 'string' || m.id === '' || typeof m.type !== 'string') {
      throw httpError(400, 'Every module needs an object shape with string id and type');
    }
    if (moduleIds.has(m.id)) throw httpError(400, `Duplicate module id: ${m.id}`);
    moduleIds.add(m.id);
    if (m.params !== undefined && !isPlainObject(m.params)) {
      throw httpError(400, `Module ${m.id}: params must be an object`);
    }
  }
  for (const w of body.wires) {
    if (!isPlainObject(w) || !isPlainObject(w.from) || !isPlainObject(w.to)) {
      throw httpError(400, 'Every wire needs an object shape with from/to objects');
    }
  }
  let id = body.id;
  if (id === undefined || id === null || id === '') {
    id = slugify(body.name) + '-' + crypto.randomBytes(2).toString('hex');
  } else if (typeof id !== 'string' || !PIPE_ID_RE.test(id)) {
    throw httpError(400, 'Invalid pipe id');
  }
  const saved = {
    id,
    name: body.name,
    savedAt: new Date().toISOString(),
    modules: body.modules,
    wires: body.wires,
  };
  await writeFile(path.join(PIPES_DIR, id + '.json'), JSON.stringify(saved, null, 2) + '\n');
  sendJSON(res, 200, { id });
}

async function handleGetPipe(req, res, match) {
  sendJSON(res, 200, await loadPipe(match[1]));
}

async function handleDeletePipe(req, res, match) {
  const id = match[1];
  if (!PIPE_ID_RE.test(id)) throw httpError(400, 'Invalid pipe id');
  try {
    await unlink(path.join(PIPES_DIR, id + '.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  sendJSON(res, 200, { ok: true });
}

async function handleRunSaved(req, res, match, url) {
  const pipe = await loadPipe(match[1]);
  const outputs = (pipe.modules || []).filter((m) => m && m.type === 'output');
  if (outputs.length !== 1) {
    throw httpError(400, 'Pipe must have exactly one output module');
  }

  const params = {};
  for (const [key, value] of url.searchParams) {
    if (key !== 'format') params[key] = value;
  }

  const result = await runPipe(pipe, { params, baseUrl: baseUrlOf(req) });
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw httpError(502, result.errors.map((e) => `${e.module}: ${e.message}`).join('; '));
  }

  if (url.searchParams.get('format') === 'json') {
    sendJSON(res, 200, { items: result.items });
    return;
  }

  const rss = buildRSS({
    title: pipe.name,
    link: baseUrlOf(req) + req.url,
    description: 'OpenPipes: ' + pipe.name,
    items: result.items,
  });
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  res.end(rss);
}

async function handleDemoFile(req, res, match) {
  await serveFile(res, DEMO_DIR, match[1]);
}

async function handleStatic(req, res, match) {
  const pathname = match[0];
  await serveFile(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
}

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/modules$/, handler: handleModules },
  { method: 'POST', pattern: /^\/api\/run$/, handler: handleRunAdHoc },
  { method: 'GET', pattern: /^\/api\/pipes$/, handler: handleListPipes },
  { method: 'POST', pattern: /^\/api\/pipes$/, handler: handleSavePipe },
  { method: 'GET', pattern: /^\/api\/pipes\/([^/]+)$/, handler: handleGetPipe },
  { method: 'DELETE', pattern: /^\/api\/pipes\/([^/]+)$/, handler: handleDeletePipe },
  { method: 'GET', pattern: /^\/pipes\/([^/]+)\/run$/, handler: handleRunSaved },
  { method: 'GET', pattern: /^\/demo\/([^/]+\.xml)$/, handler: handleDemoFile },
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
    sendJSON(res, status, { error: err?.message || 'Internal server error' });
  });
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

await mkdir(PIPES_DIR, { recursive: true });
server.on('error', (err) => {
  // a server that cannot bind must not linger as a zombie process
  console.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`OpenPipes listening on http://localhost:${PORT}`);
});
