# OpenPipes — Design Specification

OpenPipes is a Yahoo! Pipes clone: a visual editor for building feed-processing
pipelines ("pipes"), plus a server-side engine that executes them and republishes
the result as RSS or JSON.

This document is the **authoritative contract** between all components. Every file
in this repo must conform to it exactly.

## Ground rules

- **Zero dependencies.** Node.js >= 22.13 built-ins only (`node:http`,
  `node:fs`, `node:path`, `node:crypto`, `node:sqlite`, global `fetch`).
  Frontend is vanilla JS/CSS/HTML, no CDN, no build step. 22.13 is the first
  release where `node:sqlite` needs no flag, so it is imported statically and
  there is no fallback store.
- ESM everywhere (`package.json` has `"type": "module"`).
- Start with `node server.js` (default port 3000, `PORT` env overrides).
- All server code must never crash the process on bad input: every request
  handler catches errors and returns JSON `{ "error": "message" }` with an
  appropriate 4xx/5xx status.

## File layout

```
server.js                  HTTP server, routing, static files, RSS endpoint
lib/feed.js                fetch + RSS/Atom/RDF parsing + RSS 2.0 output builder
lib/html.js                tolerant HTML parser + CSS selector engine (Fetch Page)
lib/engine.js              module catalog + pipe executor
lib/store.js               SQLite storage: users, sessions, pipes
lib/errors.js              httpError(status, message, headers)
public/index.html          editor page shell
public/editor.css          editor styles
public/editor.js           editor logic (single file, vanilla JS)
assets/demo/tech.xml       built-in demo feed (RSS 2.0, tech news)
assets/demo/world.xml      built-in demo feed (RSS 2.0, world news)
assets/demo/pipes/*.json   the 4 built-in demo pipes, read-only for everyone
data/openpipes.db          the database (created on first boot; not in git)
test/run-tests.js          dependency-free test suite (`npm test`)
docs/SPEC.md               this file
README.md                  user documentation (Japanese)
```

## Data model

### Item

A feed item is a plain JSON object. Canonical fields produced by feed parsing:
`title`, `link`, `description`, `pubDate` (string; ISO 8601 when parseable,
otherwise the raw string), `guid`, `author`, `categories` (array of strings),
`source` (title of the feed the item came from). Arbitrary extra fields are
allowed. **Field paths** in module params are dot-separated (`a.b.c`) and may
index arrays numerically (`enclosures.0.url`).

### Pipe definition

```json
{
  "name": "My pipe",
  "modules": [
    { "id": "m1", "type": "fetch_feed", "params": { "urls": ["/demo/tech.xml"] }, "x": 120, "y": 60 },
    { "id": "m2", "type": "output", "params": {}, "x": 140, "y": 400 }
  ],
  "wires": [
    { "id": "w1", "from": { "module": "m1", "port": "out" }, "to": { "module": "m2", "port": "in" } }
  ]
}
```

- `id`s are arbitrary unique strings (frontend generates `m1, m2, ...` / `w1, ...`).
- `x`/`y` are canvas coordinates (integers); the engine ignores them.
- Each **input port accepts at most one wire**; output ports fan out freely.

### Stored pipes

Everything the server keeps lives in one SQLite database (`node:sqlite`):
`data/openpipes.db` by default, `OPENPIPES_DB` to put it elsewhere, and
`:memory:` — which the test suites use — is accepted. The parent directory is
created at boot. The connection sets `journal_mode = WAL`, `busy_timeout =
5000` and `foreign_keys = ON`; every table is created `IF NOT EXISTS`.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- 'local', or 'u-' + 16 hex chars
  provider      TEXT NOT NULL,             -- 'local' | 'google'
  subject       TEXT NOT NULL,             -- the provider's subject id
  email         TEXT,
  name          TEXT,
  picture       TEXT,
  created_at    TEXT NOT NULL,             -- ISO 8601 UTC
  last_login_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);
CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,            -- base64url(sha256(cookie token))
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE pipes (
  id          TEXT PRIMARY KEY,            -- globally unique
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  saved_at    TEXT NOT NULL,
  definition  TEXT NOT NULL                -- JSON {"modules": [...], "wires": [...]}
);
CREATE INDEX pipes_owner ON pipes(owner_id, saved_at DESC);
```

Timestamps are ISO 8601 UTC strings, which compare correctly as text, so an
expiry check is a plain `<=`. A pipe as the API hands it back is the columns
plus the parsed definition:

```json
{ "id": "...", "name": "...", "savedAt": "2026-07-30T00:00:00.000Z",
  "modules": [...], "wires": [...], "readOnly": false }
```

**Ownership.** Every pipe belongs to one user. Every statement that touches
`pipes` carries `WHERE owner_id = ?` except the single lookup behind
`publishedPipe()`, which is what makes `/pipes/:id/run` public. There is no
method that lists or reads across owners, and a pipe belonging to somebody
else is indistinguishable from one that does not exist (404), so ids do not
leak. With no login configured, every request acts as the fixed user `local`,
created at boot.

**Ids** are `slugify(name)` — lower-case ascii, runs of anything else
collapsed to `-`, capped at **40** characters, `pipe` when nothing survives —
then `-`, then 16 hex characters (8 random bytes); the whole thing matches
`[a-z0-9-]{1,64}`. The random half is not decoration: the public feed URL
carries only the id, so the id *is* the capability to read that feed, and a
pipe may embed private upstream URLs. A fresh id that collides with anything
stored or built in is regenerated.

**System pipes.** The demo pipes in `assets/demo/pipes/*.json` keep the file
shape above (`id`, `name`, `savedAt`, `modules`, `wires`). They are read once
at boot, validated with the same validator the save endpoint uses, and kept in
memory; they are never written to the database. A file that is not valid JSON,
fails validation, has no `id` matching `[a-z0-9-]{1,64}`, is not named
`<id>.json`, or has no `savedAt` makes the server refuse to start rather than
being skipped. They are listed for every user with `readOnly: true` after that
user's own pipes, are loadable by anyone, and a Loop in any pipe can reach
them. Saving over one is 403, deleting one is 403; duplicating one is just a
save with no `id`, which produces an ordinary pipe owned by whoever saved it.

## Module catalog

`lib/engine.js` exports `catalog()` returning an array of module type
descriptors. This drives the frontend palette and param rendering — the
frontend must render **only** from this schema, never hardcode module types.

Descriptor shape:

```json
{
  "type": "filter",
  "name": "Filter",
  "category": "Operators",
  "description": "Permit or block items that match rules",
  "inputs":  [{ "name": "in" }],
  "outputs": [{ "name": "out" }],
  "params":  [ <param descriptors> ]
}
```

Param descriptor kinds (the complete set the frontend must support):

| kind       | rendered as                        | extra keys                                  |
|------------|------------------------------------|---------------------------------------------|
| `text`     | `<input type=text>`                | `placeholder?`                               |
| `number`   | `<input type=number>`              | `min?`                                       |
| `select`   | `<select>`                         | `options` (array of strings)                 |
| `list`     | repeatable rows of one text input  | — (value is `string[]`)                      |
| `rules`    | repeatable rows of sub-fields      | `fields` (array of {name, kind, options?, placeholder?}); value is `object[]` |

Every param has `name`, `label`, `kind`, `default`. For `rules`, `default` is an
array with one prototype row.

### Module types (all 25, exact params)

**Sources**

1. `fetch_feed` — "Fetch Feed". In: none. Out: `out`.
   Params: `urls` list, default `[""]`.
   Fetches every URL in parallel, parses as RSS/Atom/RDF, concatenates items in
   URL order. Each item gets `source` = feed title. Relative URLs resolve
   against `ctx.baseUrl`.
2. `fetch_json` — "Fetch JSON". In: none. Out: `out`.
   Params: `url` text default `""`; `path` text default `""` (dot path to the
   array inside the response; empty = the root).
   If the located value is an array of objects → those are the items; a single
   object → one item; scalar/array-of-scalars → wrapped as `{ "value": v }`.
3. `fetch_page` — "Fetch Page". In: none. Out: `out`.
   Params: `url` text default `""`; `item` text default `""` (a CSS selector
   for the repeating element); `fields` rules — fields `name`, `selector`,
   `attr` — default `[{"name":"title","selector":"","attr":"text"}]`.
   Fetches an HTML page and produces one item per element matching `item`; an
   empty `item` makes the whole document one item. For each field row the
   first descendant matching `selector` is taken (empty = the item element
   itself) and `attr` read from it: `text` (whitespace collapsed), `html`
   (inner markup), or an attribute name. `href`/`src`/`poster`/`data-src` are
   resolved against the page's URL, since the result is read somewhere else.
   A row whose selector matches nothing is omitted from that item; an empty
   `url` yields no items; an unsupported selector is a module error.
4. `item_builder` — "Item Builder". In: none. Out: `out`.
   Params: `fields` rules, fields `[{name:"name",kind:"text"},{name:"value",kind:"text"}]`,
   default `[{"name":"title","value":""}]`. Emits exactly one item built from
   the rows (`setPath` semantics for dotted names).

**User Inputs** — these have **no ports**. They declare a named pipe parameter
usable anywhere via `${name}` template placeholders (see Execution).

5. `text_input` — "Text Input". Params: `name` text default `"text1"`;
   `prompt` text default `""`; `default` text default `""`.
6. `number_input` — "Number Input". Same params but `default` is number kind, default `0`.
7. `url_input` — "URL Input". Same as text_input, `name` default `"url1"`.

**Operators**

8. `filter` — "Filter". In: `in`. Out: `out`.
   Params: `mode` select `["permit","block"]` default `"permit"`;
   `combine` select `["all","any"]` default `"all"`;
   `rules` rules — fields: `field` text (placeholder "title"), `op` select
   `["contains","not_contains","matches_regex","equals","not_equals","greater_than","less_than"]`,
   `value` text. Default one row `{"field":"title","op":"contains","value":""}`.
   Semantics: evaluate each rule against the item; combine with all/any; permit
   keeps matching items, block drops them. `contains`/`equals` are
   case-insensitive string comparisons; `matches_regex` uses `new RegExp(value)`
   (invalid regex → module error); `greater_than`/`less_than` use the smart
   comparator (below). Missing field → rule is false.
9. `sort` — "Sort". Params: `rules` rules — fields: `field` text, `dir` select
   `["asc","desc"]`. Default `[{"field":"pubDate","dir":"desc"}]`. Stable
   multi-key sort using the smart comparator.
10. `truncate` — "Truncate". Params: `count` number min 0 default 10. First N items.
11. `tail` — "Tail". Params: `count` number min 0 default 10. Last N items.
12. `unique` — "Unique". Params: `field` text default `"title"`. Keeps the first
    item per distinct field value (values compared as strings; missing field
    values are all kept? No — items with missing field are kept, they dedupe
    under the key `""`... **Decision:** missing/empty values dedupe under `""`
    like any other value).
13. `reverse` — "Reverse". No params.
14. `union` — "Union". Inputs `in1`..`in5`, output `out`. Concatenates in port order.
15. `count` — "Count". Output: single item `{ "count": <n> }`.
16. `rename` — "Rename". Params: `rules` rules — fields: `from` text, `op` select
    `["rename","copy"]`, `to` text. Default `[{"from":"","op":"rename","to":""}]`.
    `rename` moves the field (deletes `from`), `copy` duplicates it. Missing
    `from` → row skipped for that item. The delete is skipped when `to` is
    `from` itself or nested under it (`a` → `a.b`), which would otherwise
    destroy the value that was just written.
17. `regex` — "Regex". Params: `rules` rules — fields: `field` text, `pattern`
    text, `replace` text, `flags` text (placeholder "gi"). Default
    `[{"field":"title","pattern":"","replace":"","flags":"g"}]`.
    Applies `String(value).replace(new RegExp(pattern, flags), replace)` to the
    field of every item (field created if missing? **No** — missing field is
    skipped). `$1` backreferences work as in JS. Invalid regex → module error.
18. `sub_element` — "Sub-element". Params: `path` text default `""`.
    For each item, take the value at `path`: array → each element becomes an
    item (objects as-is, scalars wrapped `{value}`); object → becomes the item;
    scalar → `{ "value": v }`; missing → item dropped.
19. `string_builder` — "String Builder". Params: `parts` list default `[""]`;
    `to` text default `"title"`. Joins the parts (no separator) and writes the
    result to `to`. Parts are **item templates** (below).
20. `date_builder` — "Date Builder". Params: `field` text default `"pubDate"`;
    `format` select `["iso","rfc822","date","datetime","epoch"]` default
    `"iso"`; `to` text default `"pubDate"` (empty falls back to `field`).
    Reformats a parseable date; `epoch` yields a number of milliseconds. A
    value `Date.parse` rejects leaves the item untouched.
21. `url_builder` — "URL Builder". Params: `base` text default `""`; `query`
    rules — fields `name`, `value` — default one empty row; `to` text default
    `"link"`. Both `base` and each name/value are item templates. Pairs are
    percent-encoded and appended with `?` or `&` depending on whether `base`
    already has a query; a row is skipped when its name or its **value** is
    empty, so a field the item lacks does not produce `&lang=`.
22. `loop` — "Loop". Params: `pipe` text default `""` (a **saved pipe id**);
    `mode` select `["replace","assign"]` default `"replace"`; `to` text default
    `"items"`; `limit` number min 1 default 20.
    Runs the named saved pipe once per input item. The item reaches the
    sub-pipe as its **parameters**: every top-level scalar field becomes a
    `${name}`, so `${link}` inside the sub-pipe means this item's link (the
    caller's own params are inherited underneath and lose to the item's).
    `replace` swaps the item for the sub-pipe's items (an item yielding none
    disappears); `assign` keeps the item and writes the array to `to`.
    An empty `pipe` id passes items through untouched.
    Guards, since this is the one module that multiplies work: nesting stops
    at 3 levels, a pipe that reaches itself is refused by name, sub-pipes run
    4 at a time, and `limit` caps how many items are processed — the excess is
    reported through `errors`, never dropped silently. Errors raised inside a
    sub-pipe are re-reported against the loop module, capped at 5 per run.
    The engine never touches the filesystem: `options.loadPipe(id) -> pipe`
    supplies the sub-pipe, and the module reports it is unavailable when the
    caller passes none.
23. `term_extractor` — "Term Extractor". Params: `field` text default
    `"description"`; `to` text default `"terms"`; `count` number min 1
    default 5. Writes the most distinctive words of `field` to `to` as an
    array. Markup is stripped first. Latin text is split on word boundaries
    with words under three letters and a short stopword list dropped; a run of
    Japanese is cut on hiragana instead, since that is where the grammar sits,
    leaving the kanji and katakana compounds. Ranked by frequency, then by
    length. An item without the field is passed through untouched.
24. `strip_html` — "Strip HTML". Params: `fields` list default
    `["description"]`. For each listed field: drops `<script>`/`<style>`
    including their contents, turns `<br>` and closing `p`/`div`/`li` into
    newlines, removes every remaining tag, decodes entities, and collapses
    runs of spaces. Missing fields are skipped.

**Item templates** — in `string_builder` and `url_builder`, `{a.b}` is
replaced per item with the value at that field path (missing → empty string);
`{{` and `}}` are literal braces. This is deliberately *not* `${name}`, which
the engine substitutes once before the run from pipe parameters — the two can
appear in the same string and do not interfere.

**Output**

25. `output` — "Pipe Output". In: `in`. No outputs, no params. The pipe's result.

There is no Split module: an output port already fans out to as many inputs as
you wire it to, which is all Yahoo Pipes' Split did.

### Smart comparator (shared by filter gt/lt and sort)

Given two raw values `a`, `b`:
1. If both coerce to finite numbers (`Number(x)` on non-empty strings) → numeric.
2. Else if both parse as dates (`!isNaN(Date.parse(x))`) → date compare.
3. Else → `String(a).localeCompare(String(b))`.
Missing/undefined sorts last regardless of direction.

## Engine API (`lib/engine.js`)

```js
export function catalog()                      // -> descriptor array (above)
export async function runPipe(pipe, options)   // -> { items, debug, errors }
```

`options`: `{ params?: {name: value}, fetcher?: async (url) => ({status, headers, text}), baseUrl?: string, debugLimit?: number (default 20), loadPipe?: async (id) => pipe, depth?: number, running?: Set<string>, allowPrivate?: boolean }`.
`fetcher` defaults to `fetchURL` from feed.js; tests inject a fake. `loadPipe`
is what `loop` calls to fetch a saved pipe — server.js passes its own loader,
tests pass a canned one, and omitting it disables `loop` with a clear message.
`depth` and `running` are how a loop tells its sub-run how deep it already is
and which pipes are on the stack; callers leave them alone.

Execution:
1. **Template substitution**: deep-walk every module's params; in every string,
   replace `${name}` with `options.params[name]`, falling back to the matching
   input module's `default` param, else `""`. (Substitution result is always a
   string; numeric params are coerced with `Number()` at use time.)
2. Validate: unknown module type, duplicate module ids, wire referencing a
   missing module/port, two wires into one input port, more than one `output`
   module → throw `PipeError` (exported class, `err.status = 400`).
3. Topological sort (Kahn). Cycle → `PipeError("Cycle detected")`.
4. Evaluate each module in topo order. Unwired input port → `[]`. A module
   that throws records `debug[id].error = message`, produces `[]`, execution
   continues downstream, and `{module, message}` is pushed to `errors`.
6. `debug[id] = { count, items: <first debugLimit items>, ms, error? }` for
   every module (user-input modules get `count: 0, items: []`). The debug map
   has a null prototype so a module id of `__proto__` gets a real entry
   instead of silently reassigning the map's prototype.
7. `items` = the output module's input items, or `[]` if no output module
   (that's allowed here; the RSS endpoint enforces one).

Helpers `getPath(obj, "a.b.c")` / `setPath(obj, path, value)` / `deletePath` are
internal to engine.js. Field paths arrive from request bodies, so a path
containing `__proto__`, `prototype`, or `constructor` is refused outright (get
returns `undefined`, set/delete are no-ops) and lookups only see **own**
properties — otherwise one request could corrupt `Object.prototype` for the
lifetime of the process. Items are **cloned** (`structuredClone`) at module
boundaries where mutation happens (rename/regex/sub_element/item_builder), so
fan-out wires never observe another branch's mutations.

## Feed library API (`lib/feed.js`)

```js
export function parseFeed(xmlString)  // -> { title, link, description, items: [Item] }
export async function fetchURL(url, { timeoutMs = 15000, maxBytes = 5_000_000, baseUrl } = {})
                                      // -> { status, headers: {lowercased}, text }
export function buildRSS({ title, link, description, items }) // -> RSS 2.0 XML string
export function buildJSONFeed({ title, link, description, items }) // -> JSON Feed 1.1 string
```

- `parseFeed` handles RSS 2.0 (`<rss><channel><item>`), RSS 1.0/RDF
  (`<rdf:RDF><item>`), and Atom (`<feed><entry>`; `link` = href of
  `rel="alternate"` or first link; `content`/`summary` → `description`;
  `updated`/`published` → `pubDate`). Implemented with a small internal
  XML parser (tokenize → element tree): handles attributes, self-closing tags,
  CDATA, comments, processing instructions, and entities (`&amp; &lt; &gt;
  &quot; &apos;` + `&#...;`/`&#x...;`). Namespace prefixes are ignored — match
  on local names (`dc:creator` → `creator` feeds `author`, `dc:date` feeds
  `pubDate`, `content:encoded` feeds `description` when `description` absent).
  Dates parseable by `Date.parse` are normalized to ISO 8601.
  Unparseable input → throw `Error("Not a recognized feed format")`.
  The named-entity table has a null prototype, so `&constructor;` and friends
  stay literal instead of resolving an inherited `Object` member.
- `fetchURL`: http/https only (reject others), resolves relative URLs against
  `baseUrl`, AbortController timeout.
  **Address filtering**: the hostname is resolved and every address checked;
  loopback, private, link-local (including `169.254.169.254`), carrier-NAT,
  documentation, multicast and reserved ranges are refused, in both IPv4 and
  IPv6 (including `::ffff:` mapped and NAT64 forms). Anything not positively
  identifiable as public unicast is refused — failing closed is the only safe
  default. Two ways out: the origin of `baseUrl` is always allowed, which is
  how a relative `/demo/tech.xml` reaches the app's own assets, and
  `allowPrivate: true` disables the filter entirely (server.js sets it from
  `OPENPIPES_ALLOW_PRIVATE=1`, for a deployment that really does aggregate an
  intranet feed).
  **Redirects are followed here, not by `fetch`** (max 5), and every hop is
  checked: otherwise a public host answering `302 http://169.254.169.254/`
  would walk straight past the filter. Residual gap: the address is checked
  before connecting, so a name that resolves differently between the check and
  the connection (DNS rebinding) is not covered — closing that needs pinning
  the connection to the vetted IP, which the built-in `fetch` cannot express.
  Enforces `maxBytes` twice: on the declared `content-length`, then while
  streaming the body — the read is cancelled the moment the cap is passed, so a
  peer that omits `content-length` and streams gigabytes cannot exhaust memory.
  Sends `User-Agent: OpenPipes/0.1`.
- `buildRSS` XML-escapes everything, emits `pubDate` as RFC 822
  (`new Date(x).toUTCString()`) when parseable, includes `<guid>` and
  `<atom:link rel="self">` when `link` given. Item description passed through
  escaped (no CDATA). `escapeXml` also **drops** characters outside XML 1.0's
  `Char` production (control chars except tab/LF/CR, U+FFFE/U+FFFF) — one
  poisoned upstream item must not make the whole published feed unparseable.

## Store API (`lib/store.js`)

Synchronous throughout, because `node:sqlite` is. Errors carry `status` (from
`lib/errors.js`) so the router maps them to JSON exactly like any other.

```
openStore({ dbPath, systemPipesDir })  -> Store    (also validates the system pipes)
validatePipeBody(body)                 -> body     (throws 400 on anything else)
slugify(name)                          -> string   (ascii, <= 40 chars)

Store.ensureLocalUser()                -> 'local'
Store.upsertUser({ provider, subject, email, name, picture }) -> user row
Store.createSession(userId, ttlMs)     -> token (32 random bytes, base64url; only its hash is stored)
Store.sessionUser(token)               -> user row | null   (null when missing or expired)
Store.deleteSession(token)             -> void
Store.purgeExpiredSessions()           -> void

Store.listPipes(ownerId)               -> [{ id, name, savedAt, readOnly }]
Store.getPipe(id, ownerId)             -> pipe | null       (own row, else a system pipe;
                                                             ownerId null = system pipes only)
Store.savePipe(ownerId, { id?, name, modules, wires }) -> { id }   (403 system, 404 not yours)
Store.deletePipe(id, ownerId)          -> void              (403 system, 0 rows is not an error)
Store.publishedPipe(id)                -> { pipe, ownerId } | null   (the only cross-owner lookup;
                                                                      ownerId null for a demo)
Store.close()
```

An id that does not match `[a-z0-9-]{1,64}` throws 400 from whichever method
received it.

## HTTP API (`server.js`)

| Method | Path                  | Behavior |
|--------|-----------------------|----------|
| GET    | `/`                   | `public/index.html` |
| GET    | `/editor.js`, `/editor.css` | from `public/` (also serve any file in `public/` by name) |
| GET    | `/demo/<name>.xml`    | from `assets/demo/` (content-type `application/rss+xml`) |
| GET    | `/api/modules`        | `catalog()` JSON |
| POST   | `/api/run`            | body `{ pipe, params? }` → `{ items, debug, errors }`; `PipeError` → 400 `{error}` |
| GET    | `/api/pipes`          | `[{ id, name, savedAt, readOnly }]` — the caller's own pipes by savedAt desc, then the built-in demos (`readOnly: true`) |
| POST   | `/api/pipes`          | body `{ id?, name, modules, wires }` → saves, returns `{ id }`. No `id`: a new pipe is created under a fresh id. An `id`: an **update**, so 403 for a built-in demo (save it as a copy) and 404 for an id that is not yours — including one that does not exist. Rejects (400) modules that aren't objects with string `id`/`type`, duplicate module ids, non-object `params`, and wires without `from`/`to` objects — a pipe the editor cannot render must never be creatable |
| GET    | `/api/pipes/:id`      | the stored pipe plus `readOnly`, 404 `{error}` if it is missing or somebody else's |
| DELETE | `/api/pipes/:id`      | `{ ok: true }`; 403 for a built-in demo. Deleting an id you do not own is a no-op, not an error |
| GET    | `/api/config`         | `{ readOnly, auth, user }` — what the editor needs to know about this instance. `auth` is `'none' \| 'basic' \| 'google'`; `user` is `null` except in google mode with a session, where it is `{ name, email, picture }`. Always public: it reads the session cookie without requiring one |
| GET    | `/auth/google/login`  | google mode only. `?return_to=<path>` → 302 to the provider (or straight back when already signed in) |
| GET    | `/auth/google/callback` | google mode only. Finishes the login; every failure is an HTML page, not JSON |
| POST   | `/auth/logout`        | google mode only. Deletes the session, clears the cookie, 204 |
| GET    | `/pipes/:id/run`      | executes the saved pipe, whoever owns it (the id is the capability) (cached, ETag + 304). `?format=json` → `{ items }`; `?format=jsonfeed` → JSON Feed 1.1 (`application/feed+json`); default (or `format=rss`) → RSS 2.0 (channel title = pipe name, link = request URL). Every **other** query param becomes a pipe param (for `${name}`). Requires exactly one `output` module → else 400. Any module error → 502 `{error}` (JSON). |

### Feed caching

`/pipes/:id/run` is polled on a timer by every subscriber, and each poll
re-fetches every upstream the pipe names, so its rendered output is cached in
memory for `OPENPIPES_CACHE_TTL` seconds (default 300; `0` disables the store
but keeps the ETag). The key is the pipe id, its `savedAt`, the `Host` header
and the raw query string — so saving the pipe invalidates it, and two hosts or
two parameter sets never share an entry. At most 100 entries are kept, oldest
evicted first. A run that produced errors is never stored: the upstream may
just be having a moment.

Every response carries an `ETag` and answers `If-None-Match` with 304, which
is what actually saves an RSS client bandwidth. `Cache-Control: no-cache` on
the request recomputes. `X-OpenPipes-Cache: hit|miss` says which happened.
`/api/run` is never cached — the editor's Run must always show current data.

### Modes and access control

There are three auth modes, derived from the environment at boot:

| mode | when | who the request acts as |
|---|---|---|
| `none` | nothing set | the fixed user `local` |
| `basic` | `OPENPIPES_PASSWORD` set | `local`, once the Basic header checks out |
| `google` | either `OPENPIPES_GOOGLE_*` set | the signed-in user, from the session cookie |

| variable | meaning |
|---|---|
| `OPENPIPES_DB` | Database file. Default `data/openpipes.db`; `:memory:` accepted. The parent directory is created at boot |
| `OPENPIPES_GOOGLE_CLIENT_ID` | Turns google mode on, together with the next two |
| `OPENPIPES_GOOGLE_CLIENT_SECRET` | Google requires it at the token endpoint even with PKCE |
| `OPENPIPES_BASE_URL` | Public origin, e.g. `https://pipes.example.com`. Required in google mode (the `redirect_uri` must match what is registered exactly) and allowed in any mode. Cookies get `Secure` iff it is https, and the CSRF check compares `Origin` to it, so it must be the origin people actually use |
| `OPENPIPES_ALLOWED_USERS` | Optional, google mode only. Comma-separated emails (`alice@example.com`) and domains (`@example.com`), matched case-insensitively against the id_token's verified email. Unset means anyone with an account at the provider may sign in, and boot says so |
| `OPENPIPES_OIDC_ISSUER` | Default `https://accounts.google.com`. Endpoints come from its discovery document; the tests point this at a fake issuer. Any OIDC provider therefore works, though the UI says Google |
| `OPENPIPES_PASSWORD`, `OPENPIPES_USER` | Basic auth; `OPENPIPES_USER` defaults to `admin`. Credentials are compared after SHA-256 so the check is over equal-length buffers and leaks neither length nor prefix by timing |
| `OPENPIPES_READONLY` | `1` refuses anything that modifies a stored pipe (`POST /api/pipes`, `DELETE /api/pipes/:id`) with 403, in every mode. Auth is checked first, so an unauthenticated write gets 401, not 403 |
| `OPENPIPES_CACHE_TTL`, `OPENPIPES_ALLOW_PRIVATE`, `OPENPIPES_HOST`, `PORT` / `SERVER_PORT` | see the sections about each |

The server **refuses to start** (message on stderr naming the variable, exit
1) when only some of client id / client secret / base URL are set, when google
mode and `OPENPIPES_PASSWORD` are combined, or when `OPENPIPES_BASE_URL` is
not a bare http(s) origin. `OPENPIPES_ALLOWED_USERS` outside google mode is
ignored with a warning.

Routes come in three classes:

- **public** — never authenticates: `/pipes/:id/run`, which an RSS client has
  no way to authenticate to; `/demo/*.xml`, which the engine fetches over HTTP
  from itself whenever a pipe uses a relative URL; `/api/config`, so the editor
  can render before anyone has signed in; and `/auth/*`, which is how you stop
  being anonymous.
- **api** — the rest of `/api/*`. Requires a principal and acts as it. Without
  one: 401 `{"error": "Authentication required"}` with `WWW-Authenticate` in
  basic mode, 401 `{"error": "Sign in required"}` **without** it in google mode
  (a Basic prompt there would be a dead end the browser cannot get out of).
- **page** — the editor and its assets. Behind Basic auth in basic mode; open
  in none and google mode, where the editor renders its own login gate.

`/auth/*` is registered before the `/.*` static catch-all, or the page handler
would answer those paths with 404. In none and basic mode the `/auth/*` routes
are not registered at all, so they 404.

### Users and isolation

Every pipe belongs to one user (see **Stored pipes**). In none and basic mode
that is always `local`; in google mode it is whoever is signed in, and the
`local` row is not created — switching an existing instance to google mode
hides what `local` owns rather than sharing it.

The isolation rule is one line: every statement touching `pipes` carries
`WHERE owner_id = ?` except the lookup behind `publishedPipe()`, used by
`/pipes/:id/run` alone. So the **public feed URL is the only path by which one
user's data reaches another**, and it is deliberate: the id is the capability.
A Loop is scoped the same way (see the implementation notes below).

### Sessions and login

Google login is OpenID Connect authorization code + PKCE, done entirely
server-side: no script from Google is loaded in the page, and the editor only
links to `/auth/google/login`.

`GET /auth/google/login?return_to=<path>`
1. Already signed in → 302 to the validated `return_to`.
2. Fresh `state`, `nonce` (16 random bytes each) and PKCE `verifier` (32),
   `challenge = base64url(sha256(verifier))`.
3. `return_to` is accepted only if it is a string starting with `/`, not with
   `//` or `/\`, without CR/LF, at most 2048 characters; otherwise `/`.
4. Sets `openpipes_oauth`, then 302 to the authorization endpoint with
   `response_type=code`, `client_id`, `redirect_uri=<BASE_URL>/auth/google/callback`,
   `scope=openid email profile`, `state`, `nonce`, `code_challenge`,
   `code_challenge_method=S256`.

`GET /auth/google/callback?code=…&state=…` (or `?error=…`): no
`openpipes_oauth` cookie or an unparsable one → 400; `error` → 400 naming the
(escaped) code; `state` unequal to the cookie's (compared with `secretEquals`)
→ 400; then the token endpoint is called as `application/x-www-form-urlencoded`
with `grant_type=authorization_code`, `code`, the identical `redirect_uri`,
`client_id`, `client_secret` and `code_verifier` — a non-2xx answer or one
without an `id_token` → 502. The `access_token` it returns is not used for
anything. The id_token is then verified (below) against the cookie's nonce →
400 on failure; the allowlist is applied when set, requiring
`email_verified === true` and a match → 403; and finally the user is upserted,
a session created, `openpipes_session` set, `openpipes_oauth` cleared, `login
<userId>` logged and the browser sent to `BASE_URL + returnTo`.

`POST /auth/logout` deletes the session row, clears the cookie and answers 204.
POST rather than GET so an `<img src>` on another site cannot log people out.

**Cookies.** `openpipes_session` carries the raw 32-byte token, base64url,
with `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` (30 days, absolute, not
sliding) plus `Secure` iff `OPENPIPES_BASE_URL` is https. Lax rather than
Strict because the callback and deep links arrive as top-level navigations
from another site. Only `sha256(token)` is stored, so a copied database yields
no usable cookies; logout deletes the row and sets `Max-Age=0`. A signed
stateless cookie was rejected: no revocation, and a signing secret to manage,
while the database is already there. `openpipes_oauth` is
`base64url(JSON.stringify({ state, nonce, verifier, returnTo }))` with
`Path=/auth/; HttpOnly; SameSite=Lax; Max-Age=600` (+ `Secure`), cleared by
the callback. It needs no signature: its values are random and only ever
compared with what comes back.

**id_token verification** (`verifyIdToken` in `lib/auth.js`, pure and
synchronous, so it is unit-tested against a generated RSA key). Rejected
unless all of: three dot-separated parts with JSON-object header and payload;
`alg === 'RS256'` (never `none`, never `HS256`); the RS256 signature verifies
against the JWKS key named by `kid`; `iss` equals the discovery document's
issuer, or that issuer without its scheme (Google historically issued
`accounts.google.com`); `aud` is the client id or an array containing it;
`exp` is a number and `exp * 1000 > now - 60000`; `iat`, if present,
`iat * 1000 < now + 60000`; `nonce` equals the one in the cookie; `sub` is a
non-empty string.

**Discovery and JWKS.** `<issuer>/.well-known/openid-configuration` is fetched
lazily on the first login attempt and memoised on success only, so the server
boots even when the provider is unreachable and a failure does not poison the
next attempt. The document's `issuer` must equal the configured one (ignoring
one trailing slash). Keys come from `jwks_uri` as `kid → KeyObject`; an
unknown `kid` triggers at most one refetch per 60 s — a stream of forged
tokens must not turn this server into a JWKS-fetching amplifier — and the
cache is refetched anyway once it is 24 h old. These fetches use the global
`fetch` with a 15 s timeout, deliberately not `lib/feed.js`'s `fetchURL`: the
issuer is operator configuration rather than a URL a pipe author chose, and in
the tests it lives on loopback.

**Error pages.** Because the browser is mid-navigation, `/auth/*` failures are
HTML: `<title>OpenPipes</title>`, a heading 「ログインに失敗しました」, the
message, and a link 「← エディタに戻る」 to `/`; everything interpolated is
escaped. The messages are
「ログインの状態が見つかりません。もう一度お試しください。」 (no cookie, or a
state mismatch), 「Google からエラーが返されました: <error>」,
「トークンの検証に失敗しました。」,
「このアカウントはこのサーバーでは許可されていません。」 and
「Google に接続できませんでした。」 (discovery or the token endpoint
unreachable). `Cache-Control: no-store` on every `/auth/*` response, as on
`/api/*`.

### CSRF

Cookie authentication means a request can carry authority its sender did not
choose to give it, so three layers:

- For every request whose method is not `GET`/`HEAD`: when
  `OPENPIPES_BASE_URL` is set and an `Origin` header is present and is not
  equal to it, 403 `{"error": "Cross-site request refused"}`. `Origin: null`
  counts as a mismatch. Checked in `dispatch` before the handler, in every
  mode; without a base URL there is nothing to compare against and no cookie
  to abuse either. Browsers send `Origin` on every POST, same-origin included,
  so the editor's own requests pass as long as people use the base URL.
- `readJSONBody` requires a `Content-Type` matching
  `/^application\/json\b/i`, else 400 `Body must be JSON (Content-Type:
  application/json)`. A cross-site form or a `no-cors` fetch cannot set that
  without a preflight.
- `SameSite=Lax` on both cookies.

The server sends no CORS headers in any mode, and must not start: a cross-site
preflight failing is part of the story above.

Implementation notes: hand-rolled router (method + regex table). JSON bodies
limited to 1 MB. Pipe ids validated `[a-z0-9-]{1,64}` before any lookup;
static paths resolved and verified inside their root dir. `Cache-Control:
no-store` on `/api/*`. Server logs one line per request. On boot, create the
database's directory if missing, open the store, ensure the `local` user
exists, purge expired sessions (and hourly after that, on an `unref`ed timer)
and print the URL, the database path and the auth mode — e.g. `OpenPipes
listening on http://localhost:3000 (db data/openpipes.db, Google login: anyone
can sign in)`, or `(…, Google login: allowlist of 3)`, or `(…, auth as
"admin")` in basic mode. `SIGINT`/`SIGTERM` close the store and exit 0.
Login logging is `login <userId>` and `logout <userId>` and nothing else:
tokens, codes, cookies and secrets are never logged.

`baseUrl` passed to the engine, and the origin feed links carry, is
`OPENPIPES_BASE_URL` when set, else `http://<Host header>` (fallback
`http://127.0.0.1:<port>`). `OPENPIPES_BASE_URL` must be a bare http(s) origin
— no path, query or fragment; one trailing slash is stripped — and the server
refuses to start otherwise. Setting it makes a pipe's relative URLs resolve
through the public address, so behind a proxy the proxy has to be reachable
from the app.

The **Loop** module gets a loader bound to the owner of the pipe being run —
`/api/run` to the caller, `/pipes/:id/run` to the pipe's owner (`null`, i.e.
demos only, for a built-in demo). A sub-pipe lookup therefore reaches that
owner's pipes and the built-in demos and nothing else, so the public feed URL
is the only path by which one user's data reaches another. `demo-loop` finds
`demo-headline` because both are built in.

## Frontend (public/)

Single-page editor, Yahoo Pipes style: **vertical dataflow, top → bottom**
(input ports on the top edge of a module card, output ports on the bottom edge).

Layout: top bar (logo "OpenPipes", pipe-name input, buttons **New / Load ▾ /
Save / Run ▶**, then the user menu in google mode) · left palette (modules grouped by category, drag onto canvas)
· center canvas (large scrollable area, dotted grid, SVG layer for wires under
absolutely-positioned module cards) · bottom **debugger panel** (fixed ~230px,
collapsible) showing the selected module's last output.

`state.config` comes from `/api/config` and defaults to
`{ readOnly: false, auth: 'none', user: null }`.

Behaviors (state mirrors the pipe JSON exactly, plus `id` of the saved pipe
and whether that pipe is read-only):

- Palette items are HTML5-draggable; drop on canvas creates a module instance
  with the catalog defaults (deep-cloned) at the drop point.
- Cards: colored header per category (drag handle, name, item-count badge after
  a run, ✕ delete), body renders params from the catalog schema (`text`,
  `number`, `select`, `list`, `rules` — rules/list rows have + / ✕ buttons).
  Input ports are small circles on the top edge (spread evenly), output ports
  on the bottom edge. Ports show the port name in a tooltip (`title` attr).
- **Selection** is a set of modules plus at most one wire. Click a card header
  to select it alone; shift/ctrl-click toggles it in or out; drag on empty
  canvas to rubber-band everything the box touches; `Ctrl`/`Cmd`+`A` selects
  every module; `Escape` clears. Dragging any selected card moves the whole
  set, as one undo step. `Delete`/`Backspace` removes the selected wire, or
  every selected module and its wires — again one step.
- **Copy / paste** with `Ctrl`/`Cmd`+`C` / `X` / `V`, within the page: reading
  the system clipboard needs a permission prompt and a graph fragment is not
  useful in another application. Copying takes the selected modules and only
  those wires with **both** ends inside the selection. Pasting gives every
  module a fresh id, remaps the wires onto them, offsets by (30, 30), records
  one undo step, and leaves the new copies selected so they can be dragged
  into place.
- Wires: mousedown on an **output** port starts a ghost bezier following the
  cursor; releasing on an input port creates the wire (replacing any existing
  wire into that input). Bezier control points are vertical (`dy`), Yahoo
  Pipes look. Click a wire to select (highlight), `Delete`/`Backspace` removes
  it. Same keys delete a selected module (with its wires) — **but never when
  focus is in an input/textarea/select**.
- Click card header to select a module → debugger panel shows that module's
  items from the most recent run (`debug[id]`): count, per-item rendering
  (title bold, link as anchor — only for `http`/`https`/`mailto`, other schemes
  render as plain text since feed content is untrusted — description truncated
  200 chars) + a "JSON" toggle for raw view. Module errors show red in the panel and a red ring on
  the card.
- **Run ▶**: POST `/api/run` with the current graph. If the pipe contains
  user-input modules, a params strip appears above the debugger with one
  field per input (label = prompt or name, pre-filled with default); values
  are sent as `params`. After a run, every card shows its item count badge and
  the debugger refreshes for the selected (or output) module.
- **Save**: POST `/api/pipes` (keeps id after first save; server assigns one
  when absent). **Load ▾**: dropdown fetched from GET `/api/pipes`; picking
  one loads it. Own pipes come first, then a 「デモ」 divider row and the
  read-only built-ins. Each row also carries **⧉ duplicate** and **✕
  delete** (both hidden in read-only mode; a read-only row never gets the ✕,
  because the server would refuse it anyway); duplicate saves a copy named
  "<name> のコピー" through the API without disturbing the canvas. The filter
  box (shown above six rows) skips the divider — it has no `data-name` — and
  hides it when every row under it is hidden. Loading sanitizes the file first (drop non-object or
  duplicate-id modules, wires whose endpoints don't exist, malformed
  list/rules rows) so a hand-edited file can't leave the canvas broken. Also offers "Open RSS" link to `/pipes/<id>/run` once saved.
  **New**: confirm() when there are unsaved changes.
- **Save as a copy.** Loading a pipe records whether it is read-only, and
  `savePipe()` then omits `body.id`, so saving a demo creates a copy of your
  own and toasts 「コピーとして保存しました」 rather than 「保存しました」.
  New / import / delete clear the flag. The server's 403 remains the
  guarantee; this only avoids a pointless round trip.
- Canvas panning via scrollbars (the canvas inner area is 4000×3000). Module
  drag updates wires live.
- **Auto layout** (⇵ in the top bar, `Ctrl`/`Cmd`+`Shift`+`L`): places every
  module by its longest path from a source, so a wire only ever points down a
  row and never back up. Within a row the existing left-to-right order is
  kept, so the arrangement stays recognisable. Rows are spaced by the tallest
  card in them, measured rather than assumed, because a card's height depends
  on how many rule rows it has. User-input modules have no ports and are not
  part of the flow, so they get their own column to the left. A cycle the
  editor is holding mid-edit resolves to row 0 rather than looping. One undo
  step, however many modules moved.
- **Minimap**, bottom right above the zoom control: a 200×150 `<canvas>`
  showing every module as a category-coloured rectangle, the wires between
  them, and a blue outline for the current viewport. Hidden when the pipe is
  empty. Clicking or dragging on it centres the canvas on that point. Drawn
  from `state` plus the cards' measured sizes, so it keeps no bookkeeping of
  its own; it is redrawn on commit, selection, zoom, canvas scroll, window
  resize and during a card drag.
- **Zoom** 40%–200% in fixed steps, via the ─ / % / + control at the bottom
  right of the canvas, `Ctrl`/`Cmd` + wheel (plain wheel still scrolls), and
  `Ctrl`/`Cmd` + `+` / `-` / `0`. Clicking the percentage returns to 100%.
  Implemented as `transform: scale()` with `transform-origin: 0 0` on
  `#canvas`, wrapped in `#canvas-sizer` whose pixel size is the scaled
  footprint so the scrollbars keep matching what is on screen. Wheel zoom
  keeps the point under the cursor still by adjusting the wrapper's scroll.
  Everything the editor *stores* stays in unscaled canvas coordinates, so
  every measurement taken from `getBoundingClientRect` is divided by the zoom
  — `canvasPoint(clientX, clientY)` is the single conversion, used by drops,
  port centres and the ghost wire, and drag deltas are divided directly. Zoom
  is a view property: it is not in the undo history and not saved with a pipe.
- Status toasts (saved / run errors) bottom-right, auto-dismiss.
- Deep link: `/?pipe=<id>` loads that saved pipe on startup.
- **Undo / redo** (↶ ↷ buttons plus `Ctrl`/`Cmd`+`Z`, `Ctrl`/`Cmd`+`Shift`+`Z`,
  `Ctrl`+`Y`), retaining the 60 most recent states. Snapshot-based: each step stores a deep
  clone of `{name, modules, wires}` — the graph is small and plain JSON, and
  value edits write straight into `state.params` from input listeners, so
  there is no single funnel a command log could hook. What counts as one step:
  add/delete a module, add/replace/delete a wire, one card drag (not one
  `pointermove`), one row added or removed, one select change, and one
  *continuous run of typing in a single field* — consecutive commits carrying
  the same coalesce key overwrite the top entry instead of stacking, and
  leaving the field (`focusout`) ends the run. The shortcuts are ignored while
  a text field has focus so the browser's own text undo wins; `<select>` has
  no native undo, so they still apply there. Redo is dropped as soon as a new
  edit is committed. New/Load reset the history — a different document, not an
  undoable edit. Restoring keeps everything outside the graph (`savedId`,
  `state.counter`, last run's debug output, user-input values) and drops the
  selection only when the selected module or wire is gone from the restored
  graph. `dirty` is derived as "current history index ≠ the index at the last
  save", so undoing back to the saved state clears it.
- Input ports have `pointer-events: none` except while a wire drag is active
  (`body.wiring`), so their enlarged hit halos never steal clicks/drags aimed
  at the card header they sit on.
- **Login gate** (google mode only). `init()` reads `/api/config` first; when
  `auth === 'google'` and `user` is null it calls `showGate()` and returns —
  no catalog fetch, no bindings, an empty palette behind the overlay.
  `#login-gate` is a full-viewport fixed overlay above the top bar with a
  centred card: the logo, the text
  「このサーバーを使うには Google アカウントでログインしてください。」 and
  `<a id="btn-login" class="btn primary">Google でログイン</a>` whose `href`
  the script sets to `/auth/google/login?return_to=` +
  `encodeURIComponent(location.pathname + location.search)`, so a deep link
  survives the round trip. The same `showGate()` runs when `api()` sees a 401,
  which is how an expired session is handled — it still throws, so the caller
  toasts as before.
- **User menu**, in the top bar after 実行 ▶, shown only in google mode when
  signed in: avatar (`referrerpolicy="no-referrer"`), display name, and
  **ログアウト**, which confirms when there are unsaved changes, POSTs
  `/auth/logout` and reloads.

Look: light, clean, Yahoo-Pipes-inspired. Category header colors —
Sources `#2f80ed`, User Inputs `#9b51e0`, Operators `#f2994a`, Output `#27ae60`.
Cards: white, 1px `#d5dbe3` border, 8px radius, subtle shadow; selected card
gets a 2px accent outline. Wires: `#8a94a3` (1.75px), selected `#2f80ed`.
Ghost wire dashed. System font stack. The page sets `<title>OpenPipes</title>`
and an inline SVG-emoji favicon.

## Demo assets & sample pipes

- `assets/demo/tech.xml` and `assets/demo/world.xml`: valid RSS 2.0, 8 items
  each, realistic-but-fictional headlines (tech: several titles containing
  "AI", "Rust", "Linux"; world: weather/economy/sports), `pubDate`s spread
  over 2026-07-20 .. 2026-07-29 (RFC 822 format), each item with link
  (`https://example.com/...`), description, guid.
- `data/pipes/demo-tech-filter.json`: text_input `q` (default `"AI"`, prompt
  "キーワード") + fetch_feed `/demo/tech.xml` → filter (permit, title contains
  `${q}`) → sort (pubDate desc) → truncate 5 → output. Sensible x/y layout
  (vertical chain, x≈340, y from 40 to ~640; text_input beside at x≈40).
- `data/pipes/demo-merged.json`: fetch_feed `/demo/tech.xml` + fetch_feed
  `/demo/world.xml` → union → unique (title) → sort (pubDate desc) → output.
  Two columns feeding the union.

## Tests (`test/run-tests.js`)

Dependency-free (tiny `assert`-based harness, prints `ok/FAIL name`, exits 1 on
any failure, summary line at the end). No network: engine tests inject a fake
`fetcher` returning canned RSS/JSON strings. Must cover at least:
parseFeed on RSS 2.0 / Atom / RDF samples (incl. CDATA + entities + dc:creator),
buildRSS escaping, getPath-style access via modules, every operator module's
happy path, filter ops incl. numeric greater_than and regex, sort date desc,
template substitution with defaults and runtime params, union port order,
cycle detection error, duplicate-input-wire error, unknown-type error,
module-error-continues-downstream (bad regex), fetch_json path extraction,
item_builder dotted names, and a full end-to-end run of the demo-tech-filter
shape returning the expected filtered/sorted/truncated items.
