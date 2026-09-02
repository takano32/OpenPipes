import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';

import { runPipe, catalog, PipeError } from './lib/engine.js';
import { buildJSONFeed, buildRSS, escapeXml } from './lib/feed.js';
import { httpError } from './lib/errors.js';
import { openStore, validatePipeBody } from './lib/store.js';
import {
  OidcClient, createPkce, matchesAllowlist, parseAllowlist, parseCookies, randomToken,
  safeReturnTo, secretEquals, serializeCookie,
} from './lib/auth.js';

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

// Google login. Setting either of the first two turns it on, and then all
// three of client id, secret and base URL are required: the redirect_uri has
// to match what is registered with Google exactly, so it cannot be guessed
// from the Host header.
const GOOGLE_CLIENT_ID = process.env.OPENPIPES_GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.OPENPIPES_GOOGLE_CLIENT_SECRET || '';
// Any OIDC provider works; the UI says Google because that is what it is for.
const OIDC_ISSUER = process.env.OPENPIPES_OIDC_ISSUER || 'https://accounts.google.com';
const ALLOWED_USERS = parseAllowlist(process.env.OPENPIPES_ALLOWED_USERS);

// 'none' | 'basic' | 'google'
const AUTH_MODE = (() => {
  if (!GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_SECRET) {
    if (ALLOWED_USERS.length) {
      console.warn('OPENPIPES_ALLOWED_USERS is ignored without Google login');
    }
    return AUTH_PASSWORD ? 'basic' : 'none';
  }
  if (!GOOGLE_CLIENT_ID) return bootFailure('OPENPIPES_GOOGLE_CLIENT_ID is required for Google login');
  if (!GOOGLE_CLIENT_SECRET) {
    return bootFailure('OPENPIPES_GOOGLE_CLIENT_SECRET is required for Google login' +
      ' (Google needs it at the token endpoint even with PKCE)');
  }
  if (!BASE_URL) {
    return bootFailure('OPENPIPES_BASE_URL is required for Google login:' +
      ' the OAuth redirect_uri must match the one registered with Google');
  }
  if (AUTH_PASSWORD) {
    return bootFailure('OPENPIPES_PASSWORD cannot be combined with Google login;' +
      ' unset one of them');
  }
  return 'google';
})();

const SESSION_COOKIE = 'openpipes_session';
const OAUTH_COOKIE = 'openpipes_oauth';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // absolute, not sliding
// Only meaningful over https, and setting it over http would make the cookie
// unusable, so it follows the base URL.
const COOKIE_SECURE = Boolean(BASE_URL && BASE_URL.startsWith('https:'));

const oidc = AUTH_MODE === 'google'
  ? new OidcClient({
    issuer: OIDC_ISSUER,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: BASE_URL + '/auth/google/callback',
  })
  : null;
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

// Who is asking, or null. Never throws, so /api/config can call it to decide
// whether to show a signed-in user without demanding one.
function principalOf(req) {
  try {
    if (AUTH_MODE === 'google') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = token ? store.sessionUser(token) : null;
      return user ? { userId: user.id, user } : null;
    }
    if (AUTH_MODE === 'basic') requireAuth(req);
    // With no login there is one owner, and it is whoever reached the server.
    return { userId: LOCAL_USER, user: null };
  } catch {
    return null;
  }
}

function requirePrincipal(req) {
  const principal = principalOf(req);
  if (principal) return principal;
  // A Basic prompt would be nonsense in Google mode: the browser cannot
  // satisfy it, and the editor knows to show its login gate on a 401.
  if (AUTH_MODE === 'google') throw httpError(401, 'Sign in required');
  throw httpError(401, 'Authentication required',
    { 'WWW-Authenticate': 'Basic realm="OpenPipes", charset="UTF-8"' });
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
  // Also a CSRF layer: a cross-site form or a no-cors fetch cannot set this
  // content type without a preflight, which this server never answers.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw httpError(400, 'Body must be JSON (Content-Type: application/json)');
  }
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

// What the editor needs to know about how this instance is configured. There
// is no user concept in none/basic mode, so `user` stays null there.
async function handleConfig(req, res) {
  const principal = AUTH_MODE === 'google' ? principalOf(req) : null;
  const user = principal && principal.user
    ? { name: principal.user.name, email: principal.user.email, picture: principal.user.picture }
    : null;
  sendJSON(res, 200, { readOnly: READ_ONLY, auth: AUTH_MODE, user });
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
    loadPipe: loaderFor(req.principal.userId), // the Loop module runs a saved pipe per item
  });
  sendJSON(res, 200, result);
}

async function handleListPipes(req, res) {
  sendJSON(res, 200, store.listPipes(req.principal.userId));
}

async function handleSavePipe(req, res) {
  const body = await readJSONBody(req);
  validatePipeBody(body);
  sendJSON(res, 200, store.savePipe(req.principal.userId, body));
}

async function handleGetPipe(req, res, match) {
  const pipe = store.getPipe(match[1], req.principal.userId);
  if (!pipe) throw httpError(404, 'Pipe not found: ' + match[1]);
  sendJSON(res, 200, pipe);
}

async function handleDeletePipe(req, res, match) {
  store.deletePipe(match[1], req.principal.userId);
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

/* ---------- login ---------- */

// The browser is mid-navigation when any of this goes wrong, so an error is a
// page, not JSON. Everything interpolated is escaped; nothing from the query
// string is ever reflected raw.
function authErrorPage(res, status, message) {
  const body = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenPipes</title>
<style>body{font:16px/1.7 system-ui,sans-serif;margin:0;display:grid;place-items:center;
min-height:100vh;background:#f5f7fa;color:#1f2937}
main{background:#fff;border:1px solid #d5dbe3;border-radius:10px;padding:32px 36px;max-width:32em}
h1{font-size:1.25rem;margin:0 0 12px}a{color:#2f80ed}</style>
</head><body><main>
<h1>ログインに失敗しました</h1>
<p>${escapeXml(message)}</p>
<p><a href="/">← エディタに戻る</a></p>
</main></body></html>
`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

const LOGIN_MESSAGES = {
  noState: 'ログインの状態が見つかりません。もう一度お試しください。',
  badToken: 'トークンの検証に失敗しました。',
  notAllowed: 'このアカウントはこのサーバーでは許可されていません。',
  unreachable: 'Google に接続できませんでした。',
};

function redirectTo(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

const cookieOptions = (path, maxAge) =>
  ({ path, httpOnly: true, sameSite: 'Lax', maxAge, secure: COOKIE_SECURE });

async function handleGoogleLogin(req, res, match, url) {
  const returnTo = safeReturnTo(url.searchParams.get('return_to'));
  if (principalOf(req)) return redirectTo(res, BASE_URL + returnTo);

  const state = randomToken(16);
  const nonce = randomToken(16);
  const { verifier, challenge } = createPkce();
  let authorizeUrl;
  try {
    authorizeUrl = await oidc.authorizationUrl({ state, nonce, challenge });
  } catch (err) {
    console.error('login: ' + err.message);
    return authErrorPage(res, 502, LOGIN_MESSAGES.unreachable);
  }
  // No signature needed: every value in here is random and is only ever
  // compared with what comes back.
  const payload = Buffer.from(JSON.stringify({ state, nonce, verifier, returnTo }))
    .toString('base64url');
  res.setHeader('Set-Cookie', [serializeCookie(OAUTH_COOKIE, payload, cookieOptions('/auth/', 600))]);
  redirectTo(res, authorizeUrl);
}

async function handleGoogleCallback(req, res, match, url) {
  let saved = null;
  try {
    const raw = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    if (raw) saved = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch { /* an unparsable cookie is the same as no cookie */ }
  if (!saved || typeof saved !== 'object') {
    return authErrorPage(res, 400, LOGIN_MESSAGES.noState);
  }

  const providerError = url.searchParams.get('error');
  if (providerError) {
    return authErrorPage(res, 400, `Google からエラーが返されました: ${providerError}`);
  }
  if (!secretEquals(url.searchParams.get('state') || '', saved.state || '')) {
    return authErrorPage(res, 400, LOGIN_MESSAGES.noState);
  }

  let claims;
  try {
    const tokens = await oidc.exchangeCode({
      code: url.searchParams.get('code') || '',
      verifier: saved.verifier || '',
    });
    claims = await oidc.verify(tokens.id_token, saved.nonce);
  } catch (err) {
    const unreachable = err && err.status === 502;
    console.error('login: ' + err.message);
    return authErrorPage(res, unreachable ? 502 : 400,
      unreachable ? LOGIN_MESSAGES.unreachable : LOGIN_MESSAGES.badToken);
  }

  // An unverified address must never satisfy an allowlist: anyone can claim
  // one at a provider that does not check.
  if (ALLOWED_USERS.length &&
      (claims.email_verified !== true || !matchesAllowlist(claims.email, ALLOWED_USERS))) {
    return authErrorPage(res, 403, LOGIN_MESSAGES.notAllowed);
  }

  const user = store.upsertUser({
    provider: 'google',
    subject: claims.sub,
    email: claims.email,
    name: claims.name,
    picture: claims.picture,
  });
  const token = store.createSession(user.id, SESSION_TTL_MS);
  console.log(`login ${user.id}`);
  res.setHeader('Set-Cookie', [
    serializeCookie(SESSION_COOKIE, token, cookieOptions('/', SESSION_TTL_MS / 1000)),
    serializeCookie(OAUTH_COOKIE, '', cookieOptions('/auth/', 0)),
  ]);
  redirectTo(res, BASE_URL + safeReturnTo(saved.returnTo));
}

// POST, not GET: an <img src> on another site must not be able to log people
// out. The Origin check in dispatch applies to it for the same reason.
async function handleLogout(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const user = store.sessionUser(token);
    store.deleteSession(token);
    if (user) console.log(`logout ${user.id}`);
  }
  res.setHeader('Set-Cookie', [serializeCookie(SESSION_COOKIE, '', cookieOptions('/', 0))]);
  res.writeHead(204);
  res.end();
}

async function handleDemoFile(req, res, match) {
  await serveFile(res, DEMO_DIR, match[1]);
}

async function handleStatic(req, res, match) {
  const pathname = match[0];
  await serveFile(res, PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
}

// Three classes of route.
//   public — never authenticates. A published feed has to be readable by an
//            RSS client, the engine fetches /demo/*.xml over HTTP from itself
//            when a pipe uses a relative URL, the editor needs /api/config
//            before it can render anything, and the login routes are how you
//            stop being anonymous in the first place.
//   api    — needs a principal, and acts as that principal.
//   page   — the editor and its assets: behind Basic auth in basic mode, open
//            in none and google mode, where the editor renders its own gate.
// `writes` routes are the ones read-only mode refuses, after the auth check.
const ROUTES = [
  { method: 'GET', pattern: /^\/api\/config$/, handler: handleConfig, auth: 'public' },
  { method: 'GET', pattern: /^\/api\/modules$/, handler: handleModules, auth: 'api' },
  { method: 'POST', pattern: /^\/api\/run$/, handler: handleRunAdHoc, auth: 'api' },
  { method: 'GET', pattern: /^\/api\/pipes$/, handler: handleListPipes, auth: 'api' },
  { method: 'POST', pattern: /^\/api\/pipes$/, handler: handleSavePipe, auth: 'api', writes: true },
  { method: 'GET', pattern: /^\/api\/pipes\/([^/]+)$/, handler: handleGetPipe, auth: 'api' },
  { method: 'DELETE', pattern: /^\/api\/pipes\/([^/]+)$/, handler: handleDeletePipe, auth: 'api', writes: true },
  // ...before the /.* catch-all, or the page handler would answer these with 404
  ...(AUTH_MODE === 'google' ? [
    { method: 'GET', pattern: /^\/auth\/google\/login$/, handler: handleGoogleLogin, auth: 'public' },
    { method: 'GET', pattern: /^\/auth\/google\/callback$/, handler: handleGoogleCallback, auth: 'public' },
    { method: 'POST', pattern: /^\/auth\/logout$/, handler: handleLogout, auth: 'public' },
  ] : []),
  { method: 'GET', pattern: /^\/pipes\/([^/]+)\/run$/, handler: handleRunSaved, auth: 'public' },
  { method: 'GET', pattern: /^\/demo\/([^/]+\.xml)$/, handler: handleDemoFile, auth: 'public' },
  { method: 'GET', pattern: /^\/.*$/, handler: handleStatic, auth: 'page' },
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
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  // CSRF: cookies mean a request can now carry authority the sender did not
  // choose to give it. Browsers send Origin on every POST, same-origin ones
  // included, so this costs the editor nothing as long as people reach the
  // server by its base URL. Without a base URL there is nothing to compare to,
  // and there are no cookies to abuse either.
  if (BASE_URL && req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    // `Origin: null` (a sandboxed frame, a data: document) is a mismatch.
    if (origin !== undefined && origin !== BASE_URL) {
      throw httpError(403, 'Cross-site request refused');
    }
  }

  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;
    if (route.auth === 'api') req.principal = requirePrincipal(req);
    else if (route.auth === 'page' && AUTH_MODE === 'basic') requireAuth(req);
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
  if (AUTH_MODE === 'google') {
    notes.push('Google login: ' + (ALLOWED_USERS.length
      ? `allowlist of ${ALLOWED_USERS.length}`
      : 'anyone can sign in'));
  }
  if (AUTH_PASSWORD) notes.push(`auth as "${AUTH_USER}"`);
  if (READ_ONLY) notes.push('read-only');
  if (ALLOW_PRIVATE) notes.push('private addresses allowed');
  console.log(`OpenPipes listening on http://${HOST || 'localhost'}:${PORT}` +
    (notes.length ? ` (${notes.join(', ')})` : ''));
});
