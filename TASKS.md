# TASKS.md — Google login, SQLite storage, per-user pipes

Work order for the implementing agent. Read all of it before writing code:
section 1 is the design, section 2 is the ordered task list, section 3 is the
test plan, section 4 is the acceptance checklist, section 5 lists things in
this codebase that have bitten before.

## 0. Context and ground rules

OpenPipes is a zero-dependency Yahoo! Pipes clone: `server.js` + `lib/` on
Node, a vanilla-JS editor in `public/`. `docs/SPEC.md` is the authoritative
contract between all parts and **must be updated in the same commit as any
behaviour it describes**. `README.md` is the Japanese user manual and must
stay accurate too.

Decisions already taken by the project owner — do not reopen them:

- **Anyone with a Google account may sign in** when no allowlist is set. An
  optional allowlist exists, but "open" is the default and is acceptable.
- **Old Node is dropped.** Require Node >= 22.13 (the first line where
  `node:sqlite` is unflagged). CI runs 22 and 24. Import `node:sqlite`
  statically; no fallbacks for older Node.
- **No migration. Reset is fine.** The file-based pipe store is deleted, not
  bridged. Existing `data/pipes/*.json` user files are simply gone. The four
  shipped demo pipes survive as built-in read-only pipes (see 1.2).
- **SQLite is the only store, in every mode.** A plain `node server.js` with
  no env creates `data/openpipes.db` and behaves as before from the user's
  point of view; the single local operator owns everything.

Conventions:

- Zero dependencies. Node built-ins only (`node:http`, `node:fs`, `node:path`,
  `node:crypto`, `node:sqlite`, global `fetch`). No CDN, no build step.
- `npm test` must pass after every task. It has no network access; the login
  flow is tested against a fake issuer started inside the test process.
- `node --check public/editor.js` must pass (CI runs it; the editor is only
  executed by the browser suite).
- The browser suite (`npm run test:e2e`) takes 5–9 minutes on the owner's
  machine and loads it heavily. Run it at most once, at the end, or ask the
  owner whether to push a branch and let GitHub Actions run it instead. Kill
  every server and browser you start (`pkill -f server.js` etc. if in doubt).
- One commit per task (tasks 2 and 3 may be one commit each or split as
  marked). Commit messages follow the existing style: a title line, then
  short paragraphs explaining what changed and why, wrapped at ~78 columns.
  See `git log -3 --format=%B` for examples. Do not push unless asked.
- Never log tokens, codes, cookies or secrets. Log `login <userId>` and
  `logout <userId>` only.

Where things are today (read these files first):

| file | what to know |
|---|---|
| `server.js` | hand-rolled router (`ROUTES` table with `public` / `writes` flags), Basic auth (`requireAuth`), file store (`loadPipe`, `handleListPipes`, `handleSavePipe`, `handleDeletePipe`), feed cache, `baseUrlOf(req)` |
| `lib/engine.js` | `runPipe(pipe, options)`; the `loop` module calls `options.loadPipe(id)` and treats a throw as a module error |
| `public/editor.js` | single IIFE; `api()` / `postJSON()` helpers, `init()`, `savePipe()`, `loadPipe()`, `toggleLoadMenu()`, `duplicatePipe()`, `deletePipe()`, `importPipe()`; `state.config` comes from `/api/config` |
| `public/index.html` | editor shell; the top bar is where the user menu goes |
| `test/run-tests.js` | unit suite, tiny assert harness (`test(name, fn)`) |
| `test/server-tests.js` | spawns `server.js` per environment (`withServer(env, body)`) and talks HTTP; currently seeds a temp `OPENPIPES_DATA` dir by copying `data/pipes` |
| `test/e2e/` | CDP harness (`run.mjs` spawns the server with `OPENPIPES_DATA`; `suites.mjs` drives the editor); needs Chromium |
| `data/pipes/demo-*.json` | the four demo pipes; `demo-loop` references `demo-headline` by id |
| `.github/workflows/test.yml` | matrix 18/20/22/24; the push trigger already points at `main` |

## 1. Target design

### 1.1 Modes and environment variables

| variable | meaning |
|---|---|
| `OPENPIPES_DB` | Path of the SQLite file. Default `data/openpipes.db` (relative to the repo root). `:memory:` is accepted and is what tests use. The parent directory is created at boot. Replaces `OPENPIPES_DATA`, which is removed. |
| `OPENPIPES_GOOGLE_CLIENT_ID` | Turns on **google** mode together with the next two. |
| `OPENPIPES_GOOGLE_CLIENT_SECRET` | Google requires the secret at the token endpoint even with PKCE. |
| `OPENPIPES_BASE_URL` | Public origin, e.g. `https://pipes.example.com`. Required in google mode: the OAuth `redirect_uri` must match what is registered exactly, and cookies are `Secure` iff this is https. Allowed in any mode; when set, `baseUrlOf(req)` returns it instead of `http://<Host>`. Must be an http(s) URL with no path, query or fragment; a trailing slash is stripped. |
| `OPENPIPES_ALLOWED_USERS` | Optional, google mode only. Comma-separated entries, each an email (`alice@example.com`) or a domain (`@example.com`), matched case-insensitively against the verified email of the id_token. Unset = anyone can sign in; boot prints a warning line saying so. |
| `OPENPIPES_OIDC_ISSUER` | Default `https://accounts.google.com`. Endpoints come from `<issuer>/.well-known/openid-configuration`. Tests point this at the fake issuer. (Side effect: any OIDC provider works, but the UI still says Google.) |
| `OPENPIPES_PASSWORD`, `OPENPIPES_USER` | Unchanged: **basic** mode. |
| `OPENPIPES_READONLY`, `OPENPIPES_CACHE_TTL`, `OPENPIPES_ALLOW_PRIVATE`, `OPENPIPES_HOST`, `PORT` / `SERVER_PORT` | Unchanged. |

Auth mode is derived at boot: google if any `OPENPIPES_GOOGLE_*` is set, else
basic if `OPENPIPES_PASSWORD` is set, else none. Boot **refuses to start**
(message on stderr, exit 1) when: only some of client id / client secret /
base URL are set; google and password are both set; `OPENPIPES_BASE_URL` does
not parse as a bare http(s) origin. `OPENPIPES_ALLOWED_USERS` outside google
mode is ignored with a warning.

Owner of stored data:

- none / basic: a fixed user row with id `local` (created at boot with
  `INSERT OR IGNORE`). Every request acts as `local`.
- google: the signed-in user. The `local` row is not created; anything it
  owns is invisible in this mode (documented; owner accepted this).

### 1.2 Storage — `lib/store.js` over `node:sqlite`

Open with `new DatabaseSync(path)`, then `PRAGMA journal_mode = WAL`,
`PRAGMA busy_timeout = 5000`, `PRAGMA foreign_keys = ON` (already the default
in `node:sqlite`, set it anyway). Schema, created with `IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- 'local', or 'u-' + 16 hex chars
  provider      TEXT NOT NULL,             -- 'local' | 'google'
  subject       TEXT NOT NULL,             -- Google `sub`; 'local' for the local row
  email         TEXT,
  name          TEXT,
  picture       TEXT,
  created_at    TEXT NOT NULL,             -- ISO 8601 UTC
  last_login_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash     TEXT PRIMARY KEY,            -- base64url(sha256(cookie token))
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS pipes (
  id          TEXT PRIMARY KEY,            -- [a-z0-9-]{1,64}, globally unique
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  saved_at    TEXT NOT NULL,
  definition  TEXT NOT NULL                -- JSON {"modules": [...], "wires": [...]}
);
CREATE INDEX IF NOT EXISTS pipes_owner ON pipes(owner_id, saved_at DESC);
```

ISO strings compare correctly as text, so expiry checks are plain `<=`.

The store is **synchronous** (`node:sqlite` is), a class with these methods.
Errors it raises carry a `status` property exactly like `httpError` in
`server.js`, so the existing error path maps them to JSON responses.

```
openStore({ dbPath, systemPipesDir })      -> Store

Store.ensureLocalUser()                    -> 'local'
Store.upsertUser({ provider, subject, email, name, picture }) -> user row
                                              (INSERT ... ON CONFLICT(provider, subject) DO UPDATE ... RETURNING *;
                                               new ids are 'u-' + randomBytes(8).toString('hex'))
Store.createSession(userId, ttlMs)         -> token (randomBytes(32).toString('base64url'));
                                              stores sha256(token) as base64url
Store.sessionUser(token)                   -> user row | null  (null when missing or expired)
Store.deleteSession(token)                 -> void
Store.purgeExpiredSessions()               -> void   (run at boot and hourly via setInterval(...).unref())

Store.listPipes(ownerId)                   -> [{ id, name, savedAt, readOnly }]
                                              own rows ORDER BY saved_at DESC, then system pipes by savedAt desc
Store.getPipe(id, ownerId)                 -> { id, name, savedAt, modules, wires, readOnly } | null
                                              own row first, then a system pipe (readOnly: true), else null
Store.savePipe(ownerId, { id?, name, modules, wires }) -> { id }
                                              id absent/empty: generate, INSERT
                                              id is a system id: throw 403 "This pipe is a built-in demo; save it as a copy"
                                              otherwise UPDATE ... WHERE id = ? AND owner_id = ?; changes === 0 -> throw 404 "Pipe not found: <id>"
Store.deletePipe(id, ownerId)              -> void
                                              system id: throw 403 "Built-in demo pipes cannot be deleted"
                                              else DELETE ... WHERE id = ? AND owner_id = ? (0 rows is not an error)
Store.publishedPipe(id)                    -> { pipe, ownerId } | null   (system pipes: ownerId null)
                                              the ONLY lookup that ignores ownership; used by /pipes/:id/run alone
Store.close()
```

**Isolation rule, stated once:** every statement that touches `pipes` carries
`WHERE owner_id = ?` except the one behind `publishedPipe`. There is no
method that lists or reads across owners. A foreign id is indistinguishable
from a missing one (404), so ids do not leak.

**System pipes.** At `openStore` time, read every `*.json` in
`systemPipesDir` (= `assets/demo/pipes/`, the demo files moved there from
`data/pipes/` with `git mv`). Validate each with the same validator the save
endpoint uses (move that validator out of `server.js` into `lib/store.js` as
`export function validatePipeBody(body)` and call it from both places).
Keep them in a `Map` in memory; they are never written to the database.
They are listed for everyone, loadable by everyone, `readOnly: true`, cannot
be saved over or deleted, can be duplicated (that is just a save without an
id). Loop resolution (1.6) can reach them from any owner.

**Ids.** `slugify(name)` capped at **40** characters, then `-`, then
`randomBytes(8).toString('hex')` (16 hex chars, 64 bits). The public feed URL
carries only the id, so the id is effectively the capability to read the feed,
and pipes may embed private upstream URLs — 4 hex chars were guessable.
`PIPE_ID_RE` stays `[a-z0-9-]{1,64}`; existing ids remain valid. Regenerate
if the fresh id collides with a system id (never happens in practice).

**Saved pipe shape** returned by `getPipe`: `{ id, name, savedAt, modules,
wires, readOnly }` — the old file shape plus `readOnly`. The editor's export
omits `readOnly`.

### 1.3 Identity, sessions, cookies

- Identity is the id_token `sub`. Email, name and picture are display data
  refreshed at every login; never key on email.
- Session cookie `openpipes_session`: the raw 32-byte token, base64url.
  Attributes: `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` (30 days,
  absolute, not sliding) plus `Secure` iff `OPENPIPES_BASE_URL` is https.
  Lax, not Strict: the callback and deep links arrive as top-level
  navigations from another site. The database holds only the SHA-256 of the
  token, so a copied database yields no usable cookies.
- Logout deletes the row and sets the cookie with `Max-Age=0`.
- Why not a signed stateless cookie: no revocation, and a signing secret to
  manage. The database is already there.
- Login-flow cookie `openpipes_oauth`: `base64url(JSON.stringify({ state,
  nonce, verifier, returnTo }))`, attributes `Path=/auth/; HttpOnly;
  SameSite=Lax; Max-Age=600` (+ `Secure` as above). Cleared by the callback.
  It needs no signature: its values are random and only ever compared.
- Cookie helpers live in `lib/auth.js`: `parseCookies(header)` (null-prototype
  object; split on `;`, first `=`), `serializeCookie(name, value, opts)`.

### 1.4 Login flow — OpenID Connect authorization code + PKCE, server side

No script from Google is loaded in the page; the editor only links to
`/auth/google/login`. Everything below lives in `lib/auth.js` (pure parts)
and `server.js` (routes).

`GET /auth/google/login?return_to=<path>` (google mode only; 404 otherwise)

1. Already signed in → 302 to the validated `return_to`.
2. `state` = 16 random bytes base64url; `nonce` = 16 random bytes base64url;
   `verifier` = 32 random bytes base64url; `challenge` =
   base64url(sha256(verifier)).
3. `return_to` is accepted only if it is a string that starts with `/`, does
   not start with `//` or `/\`, has no CR/LF, and is at most 2048 chars;
   otherwise `/`.
4. Set `openpipes_oauth`, then 302 to
   `<authorization_endpoint>?response_type=code&client_id=…&redirect_uri=<BASE_URL>/auth/google/callback&scope=openid%20email%20profile&state=…&nonce=…&code_challenge=…&code_challenge_method=S256`.

`GET /auth/google/callback?code=…&state=…` (or `?error=…`)

1. No `openpipes_oauth` cookie or unparsable → 400 page.
2. `error` query param → 400 page showing the (escaped) error code.
3. `state` must equal the cookie's, compared through `secretEquals`-style
   hashing → else 400 page.
4. `POST <token_endpoint>` as `application/x-www-form-urlencoded`:
   `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
   `client_secret`, `code_verifier`. Use global `fetch` with
   `AbortSignal.timeout(15000)` (not `fetchURL` — the issuer is operator
   configuration, and tests use 127.0.0.1). Non-2xx or no `id_token` → 502
   page.
5. Verify the id_token (below) with the cookie's nonce → failure → 400 page.
6. Allowlist (when set): require `email_verified === true` and a match →
   else 403 page.
7. `upsertUser({ provider: 'google', subject: sub, email, name, picture })`,
   `createSession`, set `openpipes_session`, clear `openpipes_oauth`, log
   `login <userId>`, 302 to `BASE_URL + returnTo`.

`POST /auth/logout` (google mode only; 404 otherwise): delete the session if
the cookie names one, clear the cookie, 204. Subject to the CSRF check (1.5).
POST rather than GET so an `<img src>` on another site cannot log people out.

**Error pages** are HTML, not JSON, because the browser is mid-navigation:
`<title>OpenPipes</title>`, a heading 「ログインに失敗しました」, the message,
and a link 「← エディタに戻る」 to `/`. Escape everything. Messages:
「ログインの状態が見つかりません。もう一度お試しください。」 (no cookie / state
mismatch), 「Google からエラーが返されました: <error>」, 「トークンの検証に失敗しました。」,
「このアカウントはこのサーバーでは許可されていません。」, 「Google に接続できませんでした。」
(discovery or token endpoint unreachable). `Cache-Control: no-store` on every
`/auth/*` response, like `/api/*`.

**Discovery.** `GET <issuer>/.well-known/openid-configuration` lazily on the
first login attempt, memoised on success; a failure is not memoised so the
next attempt retries. Boot never contacts the issuer, so the server starts
even when Google is unreachable. Use `issuer`, `authorization_endpoint`,
`token_endpoint`, `jwks_uri` from it.

**JWKS.** Fetch `jwks_uri`, keep `kid → KeyObject` built with
`crypto.createPublicKey({ key: jwk, format: 'jwk' })`. On an unknown `kid`
refetch once, but never more than once per 60 s (a stream of bad tokens must
not turn the server into a JWKS-fetching amplifier); refetch anyway when the
cache is older than 24 h.

**id_token verification** — `verifyIdToken(token, { key, issuer, clientId,
nonce, now })` in `lib/auth.js`, pure and synchronous so it is unit-testable
with a generated RSA key. `decodeJwt(token)` splits and base64url-decodes
header and payload first (the caller uses `header.kid` to pick `key`).
Reject unless all of:

- three dot-separated parts, header and payload are JSON objects;
- `header.alg === 'RS256'` (reject `none`, `HS256`, anything else);
- `crypto.verify('sha256', Buffer.from(header + '.' + payload), key,
  Buffer.from(signature, 'base64url'))` is true;
- `iss` equals the discovery `issuer`, or that issuer without its scheme
  (Google historically issued `accounts.google.com`);
- `aud` is `clientId` or an array containing it;
- `exp` is a number and `exp * 1000 > now - 60000`; if `iat` is present,
  `iat * 1000 < now + 60000`;
- `nonce === expected nonce`;
- `sub` is a non-empty string.

Return the payload. Google's discovery document currently resolves to
`https://accounts.google.com/o/oauth2/v2/auth`,
`https://oauth2.googleapis.com/token`, `https://www.googleapis.com/oauth2/v3/certs`;
do not hardcode them.

### 1.5 HTTP surface

| method | path | class | notes |
|---|---|---|---|
| GET | `/api/config` | public | `{ readOnly, auth: 'none'\|'basic'\|'google', user: null \| { name, email, picture } }`. Replaces `authRequired`. Reads the session cookie without requiring it. |
| GET | `/api/modules` | api | |
| POST | `/api/run` | api | JSON body; `loadPipe` scoped to the principal (1.6) |
| GET | `/api/pipes` | api | `store.listPipes(principal)` |
| POST | `/api/pipes` | api, writes | validate, then `store.savePipe(principal, body)`; 403 for a system id, 404 for an id that is not yours |
| GET | `/api/pipes/:id` | api | `store.getPipe(id, principal)` or 404 |
| DELETE | `/api/pipes/:id` | api, writes | `store.deletePipe(id, principal)`; `{ ok: true }` |
| GET | `/auth/google/login` | public | google mode only |
| GET | `/auth/google/callback` | public | google mode only |
| POST | `/auth/logout` | public | google mode only; 204 |
| GET | `/pipes/:id/run` | public | `store.publishedPipe(id)`; unchanged otherwise |
| GET | `/demo/:name.xml` | public | unchanged |
| GET | `/*` (editor, assets) | page | behind Basic in basic mode as today; open in none and google modes (the editor renders the login gate itself) |

Route classes: `public` never authenticates; `api` requires a principal;
`page` requires Basic auth in basic mode only. Keep the `writes` flag and
`requireWritable()` as they are (read-only mode is orthogonal; auth is
checked before it, as now).

`principalOf(req)` → `{ userId, user }` or `null`: none → `local`; basic →
`local` when the header checks out, else throws the existing 401 with
`WWW-Authenticate`; google → session cookie → `store.sessionUser(token)` or
`null`. `api` routes call `requirePrincipal(req)` which throws 401 JSON
`{ "error": "Sign in required" }` **without** `WWW-Authenticate` in google
mode (a Basic prompt would be wrong there).

**CSRF** — cookie auth makes cross-site requests a concern for the first time:

- For every request whose method is not `GET`/`HEAD`: if `OPENPIPES_BASE_URL`
  is set and an `Origin` header is present and it is not equal to
  `new URL(BASE_URL).origin` → 403 `{ "error": "Cross-site request refused" }`.
  Checked in `dispatch` before the handler, for all modes (in none/basic mode
  without a base URL the check is skipped).
- `readJSONBody` now requires `Content-Type` matching `/^application\/json\b/i`
  → else 400 `Body must be JSON (Content-Type: application/json)`. A
  cross-site form or `no-cors` fetch cannot send that without a preflight.
  The editor and every existing test already send it.
- `SameSite=Lax` on the cookies is the third layer.

`baseUrlOf(req)` returns `OPENPIPES_BASE_URL` when set, else the current
`http://<Host>`. The feed cache key is unchanged (id, savedAt, Host, URL).

Boot log: keep the existing line and add the mode, e.g.
`OpenPipes listening on http://localhost:3000 (db data/openpipes.db, Google login: anyone can sign in)`
or `(…, Google login: allowlist of 3)`; basic mode keeps `auth as "admin"`.
On `SIGINT`/`SIGTERM` close the store and exit 0.

### 1.6 Engine wiring — per-owner `loadPipe`

`loadPipe` is no longer a module-level function. Build one per request:

```js
const loaderFor = (ownerId) => (id) => {
  const pipe = store.getPipe(id, ownerId);   // own pipes + system pipes; ownerId null = system only
  if (!pipe) throw httpError(404, 'Pipe not found: ' + id);
  return pipe;
};
```

`POST /api/run` passes `loaderFor(principal.userId)`. `GET /pipes/:id/run`
passes `loaderFor(ownerId)` where `ownerId` came from `publishedPipe(id)`.
Consequence to state in SPEC: a Loop can only reach the calling pipe's
owner's pipes and the built-in demos, so the public feed URL is the only
path by which one user's data reaches another. `demo-loop` → `demo-headline`
keeps working for everyone because both are system pipes.

### 1.7 Editor

`state.config` defaults to `{ readOnly: false, auth: 'none', user: null }`.

- **Login gate.** In `init()`, right after `/api/config`: if
  `config.auth === 'google' && !config.user`, show `#login-gate` and return
  (no catalog fetch, no bindings). The gate is a full-viewport overlay above
  everything (`position: fixed; inset: 0; z-index` above the top bar) with a
  centred card: the logo, the text
  「このサーバーを使うには Google アカウントでログインしてください。」 and
  `<a id="btn-login" class="btn primary">Google でログイン</a>` whose `href`
  the script sets to `/auth/google/login?return_to=` +
  `encodeURIComponent(location.pathname + location.search)` so a deep link
  survives the round trip.
- **User menu** in the top bar, after 実行 ▶, shown only in google mode when
  signed in: `<img id="user-avatar" referrerpolicy="no-referrer" alt="">`,
  `<span id="user-name">`, `<button id="btn-logout" class="btn">ログアウト</button>`.
  Logout: if `state.dirty`, `confirm('未保存の変更があります。破棄してログアウトしますか？')`;
  then `fetch('/auth/logout', { method: 'POST' })` and `location.reload()`.
- **Session expiry.** `api()` on a 401 in google mode shows the gate (and
  still throws, so callers toast as before).
- **Load menu.** Rows come with `readOnly`. Own pipes first, then a divider
  row 「デモ」, then read-only rows. Read-only rows have the ⧉ duplicate
  button but no ✕ delete. The filter box (shown above six rows) must keep
  working across both groups; hide the divider when every row under it is
  hidden.
- **Save-as-copy.** `loadPipe(id)` records `state.savedReadOnly =
  Boolean(pipe.readOnly)`. `savePipe()` includes `body.id` only when
  `state.savedId && !state.savedReadOnly`; on success sets
  `savedReadOnly = false` and toasts 「コピーとして保存しました」 instead of
  「保存しました」 when it was a copy. `newPipe`, `importPipe` and
  `deletePipe` reset the flag. The server's 403 remains the guarantee; this
  just avoids the round trip.
- Export omits `readOnly`. Everything else (undo, dirty tracking, Open RSS,
  zoom, minimap) is untouched.

### 1.8 Removed

`OPENPIPES_DATA`; `data/pipes/` (demos move to `assets/demo/pipes/`); the
`authRequired` field of `/api/config`; the 4-hex id suffix; Node 18/20 in
`package.json` `engines` and in CI.

## 2. Tasks

Each task ends with `npm test` green and one commit. Update `docs/SPEC.md`
and `README.md` within the task that changes the behaviour, not at the end
(task 5 is only a consistency sweep).

### Task 1 — SQLite store replaces the file store (no auth changes yet)

1. `git mv data/pipes/demo-*.json assets/demo/pipes/`. Remove the
   `data/pipes` lines from `.gitignore`; add `data/*.db`, `data/*.db-wal`,
   `data/*.db-shm`.
2. Write `lib/store.js` per 1.2, including `validatePipeBody` moved out of
   `handleSavePipe`, `slugify` moved out of `server.js`, and the new id
   scheme.
3. `server.js`: open the store at boot (`OPENPIPES_DB`, `:memory:` support,
   mkdir of the parent), `ensureLocalUser()`, replace `loadPipe` /
   `handleListPipes` / `handleSavePipe` / `handleDeletePipe` / `handleGetPipe`
   / `handleRunSaved` with store calls using owner `local`, add `loaderFor`
   (1.6), `OPENPIPES_BASE_URL` parsing and `baseUrlOf` change, SIGINT/SIGTERM
   close, boot log `db …`.
4. `package.json`: `"engines": { "node": ">=22.13.0" }`.
   `.github/workflows/test.yml`: matrix `['22', '24']`.
5. Tests: `withServer` in `test/server-tests.js` sets `OPENPIPES_DB:
   ':memory:'` and drops the copy step. The demo pipes now arrive as system
   pipes, which changes two existing tests: "cache: saving the pipe
   invalidates what was cached for it" re-saves `demo-tech-filter` under its
   own id and would now get 403 — duplicate it first (POST without id) and
   run the cache checks against the copy's feed; "read-only: the demo pipe
   really is still on disk afterwards" becomes "still listed" (the DELETE is
   still refused, by read-only mode before the handler). Update the config
   assertions later in task 3 — for now `authRequired` still exists. Add unit tests
   in `test/run-tests.js` for the store (open `:memory:` with
   `systemPipesDir` pointing at `assets/demo/pipes`): save/list/get/delete
   round trip; list order; foreign owner sees nothing and gets `null` /
   404 / no-op delete; saving with another owner's id → 404; saving over a
   system id → 403; deleting a system id → 403; duplicate of a system pipe
   → new own id; ids match `^[a-z0-9-]+-[0-9a-f]{16}$` and slugs cap at 40;
   `validatePipeBody` rejects what `handleSavePipe` used to reject.
   Add HTTP tests: `POST /api/pipes` with `id: 'demo-merged'` → 403;
   `DELETE /api/pipes/demo-merged` → 403 and the demo is still listed;
   `GET /api/pipes` rows carry `readOnly`; a pipe whose Loop names a demo
   still runs through `/pipes/demo-loop/run`.
6. `test/e2e/run.mjs`: spawn with `OPENPIPES_DB: ':memory:'` instead of
   `OPENPIPES_DATA`. `suites.mjs`: wherever a suite deletes or expects to
   delete a demo pipe, duplicate first and delete the copy; the "duplicate
   pipe" suite should still pass as is. Do not run the browser suite yet.
7. SPEC: ground rules (Node >= 22.13, `node:sqlite`), file layout, the
   "Saved pipe file" section becomes "Stored pipes" (schema, system pipes,
   `readOnly`, id scheme), HTTP API rows for 403/404 semantics, the store
   API. README: クイックスタート (Node 要件、`data/openpipes.db` ができること、
   `OPENPIPES_DB`)、デモパイプ節 (組み込み・読み取り専用・複製で自分のものになる)、
   パイプ定義 JSON 節の保存先の記述、バックアップの一文
   (`sqlite3 data/openpipes.db ".backup backup.db"`、または停止してコピー。
   WAL のため `-wal` `-shm` も一緒に)。

### Task 2 — `lib/auth.js` pure parts + unit tests (may share a commit with task 3)

Implement and unit-test, with no HTTP involved:

- `parseCookies`, `serializeCookie` (attribute order irrelevant; assert on
  presence of `HttpOnly`, `SameSite=Lax`, `Path`, `Max-Age`, `Secure`).
- `safeReturnTo(value)` — table: `/`, `/?pipe=x`, `/a/b` accepted; `//evil`,
  `/\evil`, `https://evil`, `''`, `undefined`, a value with `\n`, a 3000-char
  value → `/`.
- `parseAllowlist(env)` / `matchesAllowlist(email, entries)` — emails and
  `@domain` entries, case-insensitive, whitespace tolerant, empty list = no
  restriction.
- `createPkce()` — challenge equals base64url(sha256(verifier)).
- `decodeJwt`, `verifyIdToken` — generate one RSA-2048 key pair per test
  file with `crypto.generateKeyPairSync` and a `signJwt(header, payload,
  privateKey)` helper. Cases: valid token passes and returns the payload;
  `alg: 'none'`; `alg: 'HS256'`; signature from a different key; wrong
  `iss`; bare-host `iss` accepted for the configured issuer; wrong `aud`;
  `aud` array containing the client id accepted; `exp` in the past (beyond
  the 60 s skew); `nonce` mismatch; missing `sub`; malformed (two parts,
  non-JSON payload).

### Task 3 — sessions, login routes, CSRF, HTTP tests

1. `lib/auth.js`: `OidcClient` (discovery memo, authorization URL, code
   exchange, JWKS cache with the 60 s / 24 h rules, `verify(idToken,
   nonce)`), taking `fetch` as a constructor option so a unit test can stub
   it if wanted.
2. `server.js`: mode derivation and boot validation (1.1), `principalOf` /
   `requirePrincipal`, route classes (1.5), `/auth/*` handlers (1.4), error
   pages, CSRF `Origin` check and the `Content-Type` requirement, `/api/config`
   new shape, session purge timer, boot log wording. Remove `authRequired`.
3. `test/fake-issuer.mjs` (shared with the browser harness later) per
   section 3.
4. HTTP tests per section 3. Update the two existing `deepEqual` config
   assertions to the new shape.
5. SPEC: replace "Access control" with "Modes and access control" (three
   modes, env table, boot refusals), add "Sessions and login" (cookies,
   flow, verification rules, discovery/JWKS caching, allowlist, error
   pages), "Users and isolation" (owner rule, `publishedPipe` exception,
   Loop scoping), "CSRF"; update the HTTP API table and `/api/config`.
   README (Japanese): new section 「Google ログイン」 with: Google Cloud
   Console の手順 (OAuth 同意画面 → 認証情報 → OAuth クライアント ID
   「ウェブ アプリケーション」→ 承認済みのリダイレクト URI に
   `<OPENPIPES_BASE_URL>/auth/google/callback`)、環境変数の表、
   「未設定なら Google アカウントを持つ誰でもログインできる」と
   `OPENPIPES_ALLOWED_USERS` の書き方、セッションは 30 日で Cookie は
   HttpOnly、ユーザーごとにパイプは完全に分かれるが公開フィード URL は
   誰でも読めるので id が秘密であること、モードを切り替えると `local` の
   パイプは見えなくなること、リバースプロキシ配下では `OPENPIPES_BASE_URL`
   を公開 URL にして `OPENPIPES_HOST=127.0.0.1` にすること、Basic 認証との
   併用は起動エラー。API 表に `/auth/*` と 401/403 を追加。

### Task 4 — editor

1. `public/index.html`: gate markup and user-menu markup (1.7).
   `public/editor.css`: gate overlay and card, user menu, 「デモ」 divider.
2. `public/editor.js`: everything in 1.7.
3. `node --check public/editor.js`.
4. Browser suite: `test/e2e/run.mjs` additionally starts the fake issuer
   and a second server in google mode (`OPENPIPES_GOOGLE_CLIENT_ID=test`,
   `…_SECRET=test-secret`, `OPENPIPES_BASE_URL=http://127.0.0.1:<port2>`,
   `OPENPIPES_OIDC_ISSUER=<issuer>`, `OPENPIPES_DB=:memory:`) and kills both
   in `cleanup`. New suite `google login` against the second origin: the
   gate is visible and the workspace is not interactive; clicking
   「Google でログイン」 ends up back on the editor with `#user-menu`
   visible and the name from the fake issuer; the load menu shows the demos
   under 「デモ」 without ✕; saving a new pipe works; opening a demo and
   saving toasts 「コピーとして保存しました」 and the id differs; logout
   brings the gate back and `/api/pipes` answers 401 (check via
   `page.eval(fetch(...))`). Existing suites keep running against the
   none-mode server. Ask the owner before running the whole browser suite
   locally; CI is preferred.
5. SPEC "Frontend" section: gate, user menu, load menu groups, save-as-copy,
   401 handling. README 使い方: ログイン/ログアウトの一文と、デモは複製して
   使うこと。

### Task 5 — sweep

1. `docs/SPEC.md` never documented `SERVER_PORT` and `OPENPIPES_HOST` (added
   in commit 13414c0 without a SPEC update), nor `test/server-tests.js`,
   `test/e2e/` and the CI workflow in its file layout and Tests sections; it
   also says the app ships with 2 sample pipes (there are 4; README line
   「2 つのサンプルパイプ」 has the same mistake). Make sure all of that is
   right by the end.
2. Grep for `OPENPIPES_DATA`, `data/pipes`, `authRequired`, `Node.js >= 18`,
   `18 / 20 / 22 / 24` across the repo and fix every stale mention.
3. Re-read SPEC top to bottom against the code once; it is the contract.
4. Delete this `TASKS.md` in the final commit — SPEC and README are the
   lasting record.

## 3. Test plan details

### Fake OIDC issuer — `test/fake-issuer.mjs`

```
startFakeIssuer({ clientId, clientSecret }) -> { issuer, setUser(claims), keyPair, close() }
```

An `http.createServer` on 127.0.0.1 with an ephemeral port. One RSA-2048 key
pair generated at start, `kid: 'test-key'`.

- `GET /.well-known/openid-configuration` → `{ issuer, authorization_endpoint:
  issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer +
  '/jwks', response_types_supported: ['code'], subject_types_supported:
  ['public'], id_token_signing_alg_values_supported: ['RS256'] }`.
- `GET /authorize` → requires `response_type=code`, `client_id`,
  `redirect_uri`, `state`, `nonce`, `code_challenge`,
  `code_challenge_method=S256`; stores `{ nonce, challenge, redirectUri }`
  under a fresh random `code`; 302 to `redirect_uri?code=…&state=…`. Any
  missing parameter → 400 with the name in the body (so a broken client is
  diagnosable from the test output).
- `POST /token` (form-encoded) → 400 unless `grant_type=authorization_code`,
  the code is known and unused, `redirect_uri` matches, `client_id` /
  `client_secret` match, and `base64url(sha256(code_verifier))` equals the
  stored challenge. Otherwise 200 `{ access_token: 'x', token_type: 'Bearer',
  expires_in: 3600, id_token }` where id_token is RS256 over `{ iss: issuer,
  aud: clientId, sub, email, email_verified, name, picture, nonce, iat, exp:
  iat + 3600 }` with the claims from the last `setUser(...)`.
- `GET /jwks` → `{ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use:
  'sig' }] }`.

### HTTP test helper

`login(origin, issuer, claims)` → session cookie header value. Use `fetch`
with `redirect: 'manual'` and `res.headers.getSetCookie()`:

1. `GET origin/auth/google/login?return_to=/?pipe=demo-merged` → expect 302
   whose `Location` starts with `issuer + '/authorize?'` and contains
   `code_challenge_method=S256`, `scope=openid%20email%20profile`; capture
   the `openpipes_oauth` cookie.
2. `GET` that `Location` → 302 back to `origin/auth/google/callback?…`.
3. `GET` it with the oauth cookie → 302 to `origin/?pipe=demo-merged`,
   `openpipes_session` cookie set (`HttpOnly`, `SameSite=Lax`, no `Secure`
   over http), `openpipes_oauth` cleared.

Server env for google mode in tests: `OPENPIPES_GOOGLE_CLIENT_ID: 'test'`,
`OPENPIPES_GOOGLE_CLIENT_SECRET: 'test-secret'`, `OPENPIPES_BASE_URL: origin`,
`OPENPIPES_OIDC_ISSUER: issuer`, `OPENPIPES_DB: ':memory:'`. `withServer`
must let a test compute env from the port (it already accepts a function).

### HTTP cases to cover

1. **Gate.** Unauthenticated in google mode: `/` 200, `/editor.js` 200,
   `/api/config` → `{ readOnly: false, auth: 'google', user: null }`,
   `/api/modules` 401 JSON without `WWW-Authenticate`, `/api/pipes` 401,
   `POST /api/run` 401, `/pipes/demo-tech-filter/run` 200, `/demo/tech.xml`
   200, `/auth/google/login` 302.
2. **Round trip** via `login()`, then `/api/config` shows `user.email` and
   `user.name`, and `/api/modules` is 200.
3. **Callback failures.** Callback without the cookie → 400 HTML; with a
   wrong `state` → 400; `?error=access_denied` → 400 containing
   `access_denied`; the login route in none mode → 404.
4. **Isolation.** Log in as A, save a pipe; log in as B (different `sub`):
   B's list holds only demos; `GET /api/pipes/<A's id>` 404; `DELETE` → 200
   and A still sees it; `POST /api/pipes` with A's id → 404; A's
   `/pipes/<id>/run` is 200 with no cookie at all.
5. **Loop scoping.** A saves sub-pipe S (an `item_builder` → `output`); B
   saves a pipe whose `loop.params.pipe` is S's id; B's `/api/run` reports a
   module error on the loop containing `Pipe not found` and yields no items
   from S; A's own pipe with the same loop works.
6. **System pipes.** Both users list the demos with `readOnly: true`; `POST`
   with `id: 'demo-merged'` → 403; `DELETE /api/pipes/demo-merged` → 403;
   GET demo, POST without id → 200 with a fresh id, listed for that user
   only.
7. **Logout.** `POST /auth/logout` with the cookie → 204 and a `Max-Age=0`
   cookie; the old cookie now gets 401.
8. **CSRF.** With a valid session: `POST /api/pipes` with `Origin:
   https://evil.example` → 403; with the correct Origin → 200; with no
   `Content-Type` → 400; `POST /auth/logout` with a foreign Origin → 403 and
   the session survives.
9. **Allowlist.** `OPENPIPES_ALLOWED_USERS: '@example.com, Bob@gmail.com'`:
   `alice@other.com` → 403 HTML; `carol@example.com` → session; `bob@GMAIL.com`
   → session; `email_verified: false` with an otherwise allowed address →
   403.
10. **Cookies over https.** `OPENPIPES_BASE_URL: 'https://pipes.example'`
    (the server still listens on http; only the redirect targets change):
    the login redirect's `openpipes_oauth` cookie carries `Secure`, and the
    `redirect_uri` in the authorize URL is
    `https://pipes.example/auth/google/callback`.
11. **Boot refusals.** Spawn with only `OPENPIPES_GOOGLE_CLIENT_ID`; with
    google vars plus `OPENPIPES_PASSWORD`; with `OPENPIPES_BASE_URL:
    'https://x.example/sub/'` → each exits 1 with a message naming the
    variable. (Extend `withServer` or write a tiny `expectBootFailure(env)`
    helper that waits for exit.)
12. **Basic mode on SQLite.** Existing password tests pass unchanged except
    the config shape (`auth: 'basic'`).
13. **Base URL in feeds.** With `OPENPIPES_BASE_URL` set, the RSS
    `<atom:link rel="self">` / `<link>` of `/pipes/demo-merged/run` starts
    with it.

## 4. Acceptance checklist

- [ ] `npm test` green on Node 22 and 24 with no network.
- [ ] `node --check public/editor.js` green.
- [ ] `node server.js` with no env: creates `data/openpipes.db`, editor works
      as before, demos listed under 「デモ」, saving/deleting own pipes works.
- [ ] `OPENPIPES_PASSWORD=x node server.js`: Basic prompt as before.
- [ ] Google mode against the fake issuer: gate → login → editor → logout.
- [ ] Two fake users cannot see each other's pipes by any API; feeds public.
- [ ] `git grep -n 'OPENPIPES_DATA\|data/pipes\|authRequired'` finds nothing
      outside git history.
- [ ] SPEC.md describes exactly what the code does; README matches SPEC.
- [ ] No stray `server.js` or Chromium processes left running.
- [ ] The owner still has to verify against real Google with a real client
      id (the fake issuer cannot prove Google-specific quirks); README tells
      them how.

## 5. Known gotchas in this codebase

- `node:sqlite` rows are null-prototype objects; `JSON.stringify` handles
  them, `hasOwnProperty` does not exist on them.
- Node 22 may print an `ExperimentalWarning` for `node:sqlite` on stderr;
  tests must not assert on stderr being empty.
- `secretEquals` hashes both sides before `timingSafeEqual` so lengths never
  matter; reuse it for `state` comparison.
- `Set-Cookie` with several cookies must be set as an array via
  `res.setHeader('Set-Cookie', [a, b])`; `writeHead` with an object would
  overwrite. `res.headers.getSetCookie()` is how tests read them.
- The engine's `loop` module treats a throw from `loadPipe` as a module
  error (recorded in `errors`, run continues); that is the behaviour test
  case 5 relies on.
- Input ports in the editor are `pointer-events: none` unless `body.wiring`
  is set; do not touch that when adding the gate's CSS.
- Undo history identifies the saved state by a revision number
  (`history.savedRev`), never by stack position; `savePipe()` captures
  `sentRev` before the request for that reason — keep that when adding the
  save-as-copy branch.
- The SSRF filter in `lib/feed.js` follows redirects itself; do not route
  the OIDC fetches through `fetchURL`, they are operator-configured and the
  test issuer is on loopback.
- Headless Chromium in CI has no CJK fonts; browser-suite assertions go
  against the DOM, never screenshots.
- `OPENPIPES_BASE_URL` makes relative demo URLs resolve through the public
  address, so behind a proxy the proxy must be able to reach the app from
  the app (it normally can). Mention it in README where BASE_URL is described.
