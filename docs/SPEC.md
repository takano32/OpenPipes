# OpenPipes — Design Specification

OpenPipes is a Yahoo! Pipes clone: a visual editor for building feed-processing
pipelines ("pipes"), plus a server-side engine that executes them and republishes
the result as RSS or JSON.

This document is the **authoritative contract** between all components. Every file
in this repo must conform to it exactly.

## Ground rules

- **Zero dependencies.** Node.js >= 18 built-ins only (`node:http`, `node:fs`,
  `node:path`, `node:crypto`, global `fetch`). Frontend is vanilla JS/CSS/HTML,
  no CDN, no build step.
- ESM everywhere (`package.json` has `"type": "module"`).
- Start with `node server.js` (default port 3000, `PORT` env overrides).
- All server code must never crash the process on bad input: every request
  handler catches errors and returns JSON `{ "error": "message" }` with an
  appropriate 4xx/5xx status.

## File layout

```
server.js              HTTP server, routing, static files, RSS endpoint
lib/feed.js            fetch + RSS/Atom/RDF parsing + RSS 2.0 output builder
lib/engine.js          module catalog + pipe executor
public/index.html      editor page shell
public/editor.css      editor styles
public/editor.js       editor logic (single file, vanilla JS)
assets/demo/tech.xml   built-in demo feed (RSS 2.0, tech news)
assets/demo/world.xml  built-in demo feed (RSS 2.0, world news)
data/pipes/*.json      saved pipes (server writes here; ships with 2 samples)
test/run-tests.js      dependency-free test suite (`npm test`)
docs/SPEC.md           this file
README.md              user documentation (Japanese)
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

### Saved pipe file (`data/pipes/<id>.json`)

```json
{ "id": "demo-tech-filter", "name": "...", "savedAt": "2026-07-30T00:00:00.000Z",
  "modules": [...], "wires": [...] }
```

`id` is `[a-z0-9-]+`, derived from the name (slugified, ascii-only) plus a
random 4-hex suffix when first saved; non-ascii names fall back to `pipe-<hex>`.

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

### Module types (all 23, exact params)

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
3. `item_builder` — "Item Builder". In: none. Out: `out`.
   Params: `fields` rules, fields `[{name:"name",kind:"text"},{name:"value",kind:"text"}]`,
   default `[{"name":"title","value":""}]`. Emits exactly one item built from
   the rows (`setPath` semantics for dotted names).

**User Inputs** — these have **no ports**. They declare a named pipe parameter
usable anywhere via `${name}` template placeholders (see Execution).

4. `text_input` — "Text Input". Params: `name` text default `"text1"`;
   `prompt` text default `""`; `default` text default `""`.
5. `number_input` — "Number Input". Same params but `default` is number kind, default `0`.
6. `url_input` — "URL Input". Same as text_input, `name` default `"url1"`.

**Operators**

7. `filter` — "Filter". In: `in`. Out: `out`.
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
8. `sort` — "Sort". Params: `rules` rules — fields: `field` text, `dir` select
   `["asc","desc"]`. Default `[{"field":"pubDate","dir":"desc"}]`. Stable
   multi-key sort using the smart comparator.
9. `truncate` — "Truncate". Params: `count` number min 0 default 10. First N items.
10. `tail` — "Tail". Params: `count` number min 0 default 10. Last N items.
11. `unique` — "Unique". Params: `field` text default `"title"`. Keeps the first
    item per distinct field value (values compared as strings; missing field
    values are all kept? No — items with missing field are kept, they dedupe
    under the key `""`... **Decision:** missing/empty values dedupe under `""`
    like any other value).
12. `reverse` — "Reverse". No params.
13. `union` — "Union". Inputs `in1`..`in5`, output `out`. Concatenates in port order.
14. `count` — "Count". Output: single item `{ "count": <n> }`.
15. `rename` — "Rename". Params: `rules` rules — fields: `from` text, `op` select
    `["rename","copy"]`, `to` text. Default `[{"from":"","op":"rename","to":""}]`.
    `rename` moves the field (deletes `from`), `copy` duplicates it. Missing
    `from` → row skipped for that item. The delete is skipped when `to` is
    `from` itself or nested under it (`a` → `a.b`), which would otherwise
    destroy the value that was just written.
16. `regex` — "Regex". Params: `rules` rules — fields: `field` text, `pattern`
    text, `replace` text, `flags` text (placeholder "gi"). Default
    `[{"field":"title","pattern":"","replace":"","flags":"g"}]`.
    Applies `String(value).replace(new RegExp(pattern, flags), replace)` to the
    field of every item (field created if missing? **No** — missing field is
    skipped). `$1` backreferences work as in JS. Invalid regex → module error.
17. `sub_element` — "Sub-element". Params: `path` text default `""`.
    For each item, take the value at `path`: array → each element becomes an
    item (objects as-is, scalars wrapped `{value}`); object → becomes the item;
    scalar → `{ "value": v }`; missing → item dropped.
18. `string_builder` — "String Builder". Params: `parts` list default `[""]`;
    `to` text default `"title"`. Joins the parts (no separator) and writes the
    result to `to`. Parts are **item templates** (below).
19. `date_builder` — "Date Builder". Params: `field` text default `"pubDate"`;
    `format` select `["iso","rfc822","date","datetime","epoch"]` default
    `"iso"`; `to` text default `"pubDate"` (empty falls back to `field`).
    Reformats a parseable date; `epoch` yields a number of milliseconds. A
    value `Date.parse` rejects leaves the item untouched.
20. `url_builder` — "URL Builder". Params: `base` text default `""`; `query`
    rules — fields `name`, `value` — default one empty row; `to` text default
    `"link"`. Both `base` and each name/value are item templates. Pairs are
    percent-encoded and appended with `?` or `&` depending on whether `base`
    already has a query; a row is skipped when its name or its **value** is
    empty, so a field the item lacks does not produce `&lang=`.
21. `loop` — "Loop". Params: `pipe` text default `""` (a **saved pipe id**);
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
22. `strip_html` — "Strip HTML". Params: `fields` list default
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

23. `output` — "Pipe Output". In: `in`. No outputs, no params. The pipe's result.

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

`options`: `{ params?: {name: value}, fetcher?: async (url) => ({status, headers, text}), baseUrl?: string, debugLimit?: number (default 20), loadPipe?: async (id) => pipe, depth?: number, running?: Set<string> }`.
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
5. `debug[id] = { count, items: <first debugLimit items>, ms, error? }` for
   every module (user-input modules get `count: 0, items: []`). The debug map
   has a null prototype so a module id of `__proto__` gets a real entry
   instead of silently reassigning the map's prototype.
6. `items` = the output module's input items, or `[]` if no output module
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
  `baseUrl`, follows redirects (fetch default), AbortController timeout.
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

## HTTP API (`server.js`)

| Method | Path                  | Behavior |
|--------|-----------------------|----------|
| GET    | `/`                   | `public/index.html` |
| GET    | `/editor.js`, `/editor.css` | from `public/` (also serve any file in `public/` by name) |
| GET    | `/demo/<name>.xml`    | from `assets/demo/` (content-type `application/rss+xml`) |
| GET    | `/api/modules`        | `catalog()` JSON |
| POST   | `/api/run`            | body `{ pipe, params? }` → `{ items, debug, errors }`; `PipeError` → 400 `{error}` |
| GET    | `/api/pipes`          | `[{ id, name, savedAt }]` sorted by savedAt desc |
| POST   | `/api/pipes`          | body `{ id?, name, modules, wires }` → saves, returns `{ id }` (new id when none given). Rejects (400) modules that aren't objects with string `id`/`type`, duplicate module ids, non-object `params`, and wires without `from`/`to` objects — a saved file the editor cannot render must never be creatable |
| GET    | `/api/pipes/:id`      | full saved file JSON, 404 `{error}` if missing |
| DELETE | `/api/pipes/:id`      | `{ ok: true }` |
| GET    | `/pipes/:id/run`      | executes saved pipe. `?format=json` → `{ items }`; default (or `format=rss`) → RSS 2.0 (channel title = pipe name, link = request URL). Every **other** query param becomes a pipe param (for `${name}`). Requires exactly one `output` module → else 400. Any module error → 502 `{error}` (JSON). |

Implementation notes: hand-rolled router (method + regex table). JSON bodies
limited to 1 MB. Pipe ids validated `[a-z0-9-]{1,64}` before touching the
filesystem; static paths resolved and verified inside their root dir. `Cache-
Control: no-store` on `/api/*`. Server logs one line per request. On boot,
create `data/pipes/` if missing and print the URL. `baseUrl` passed to the
engine = `http://<Host header>` (fallback `http://127.0.0.1:<port>`).

## Frontend (public/)

Single-page editor, Yahoo Pipes style: **vertical dataflow, top → bottom**
(input ports on the top edge of a module card, output ports on the bottom edge).

Layout: top bar (logo "OpenPipes", pipe-name input, buttons **New / Load ▾ /
Save / Run ▶**) · left palette (modules grouped by category, drag onto canvas)
· center canvas (large scrollable area, dotted grid, SVG layer for wires under
absolutely-positioned module cards) · bottom **debugger panel** (fixed ~230px,
collapsible) showing the selected module's last output.

Behaviors (state mirrors the pipe JSON exactly, plus `id` of the saved pipe):

- Palette items are HTML5-draggable; drop on canvas creates a module instance
  with the catalog defaults (deep-cloned) at the drop point.
- Cards: colored header per category (drag handle, name, item-count badge after
  a run, ✕ delete), body renders params from the catalog schema (`text`,
  `number`, `select`, `list`, `rules` — rules/list rows have + / ✕ buttons).
  Input ports are small circles on the top edge (spread evenly), output ports
  on the bottom edge. Ports show the port name in a tooltip (`title` attr).
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
  one loads it. Loading sanitizes the file first (drop non-object or
  duplicate-id modules, wires whose endpoints don't exist, malformed
  list/rules rows) so a hand-edited file can't leave the canvas broken. Also offers "Open RSS" link to `/pipes/<id>/run` once saved.
  **New**: confirm() when there are unsaved changes.
- Canvas panning via scrollbars (the canvas inner area is ~4000×3000). Module
  drag updates wires live. No zoom (keep it robust).
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
