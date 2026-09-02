// Storage for users, sessions and pipes, on top of node:sqlite.
//
// Synchronous throughout, because node:sqlite is: every call here returns its
// result rather than a promise, and the request handlers simply do not await
// them. The one rule the whole file exists to enforce is that every statement
// touching `pipes` carries `WHERE owner_id = ?` — except the single lookup
// behind publishedPipe(), which is what makes a feed URL public.
import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { httpError } from './errors.js';

export const PIPE_ID_RE = /^[a-z0-9-]{1,64}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT,
  name          TEXT,
  picture       TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS pipes (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  saved_at    TEXT NOT NULL,
  definition  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipes_owner ON pipes(owner_id, saved_at DESC);
`;

// The slug is only there to make an id readable; the random half is what makes
// it unguessable. Capped at 40 so the whole id stays well inside PIPE_ID_RE's
// 64 characters.
export function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'pipe';
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Rejects anything the editor could not render again. Used by the save
// endpoint and by the system-pipe loader, so a shipped demo is held to exactly
// the standard a saved pipe is. The `id` is not its business: whichever code
// receives an id checks its format.
export function validatePipeBody(body) {
  if (
    !isPlainObject(body) ||
    typeof body.name !== 'string' || !Array.isArray(body.modules) || !Array.isArray(body.wires)
  ) {
    throw httpError(400, 'Body must include name (string), modules (array) and wires (array)');
  }
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
  return body;
}

function requireId(id) {
  if (typeof id !== 'string' || !PIPE_ID_RE.test(id)) throw httpError(400, 'Invalid pipe id');
  return id;
}

const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token), 'utf8').digest('base64url');

const nowISO = () => new Date().toISOString();

// The demo pipes ship as files and are read once at boot. They belong to
// nobody, are listed for everybody, and are never written to the database, so
// an operator can change them by editing the files.
function readSystemPipes(dir) {
  const pipes = new Map();
  if (!dir) return pipes;
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new Error(`Cannot read the built-in pipes in ${dir}: ${err.message}`);
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Built-in pipe ${file} is not valid JSON: ${err.message}`);
    }
    validatePipeBody(raw);
    if (typeof raw.id !== 'string' || !PIPE_ID_RE.test(raw.id)) {
      throw new Error(`Built-in pipe ${file} has no valid "id"`);
    }
    if (name !== raw.id + '.json') {
      throw new Error(`Built-in pipe ${file} must be named ${raw.id}.json`);
    }
    if (typeof raw.savedAt !== 'string' || raw.savedAt === '') {
      throw new Error(`Built-in pipe ${file} has no "savedAt"`);
    }
    if (pipes.has(raw.id)) throw new Error(`Duplicate built-in pipe id: ${raw.id}`);
    pipes.set(raw.id, {
      id: raw.id,
      name: raw.name,
      savedAt: raw.savedAt,
      modules: raw.modules,
      wires: raw.wires,
      readOnly: true,
    });
  }
  return pipes;
}

class Store {
  constructor(db, systemPipes) {
    this.db = db;
    this.systemPipes = systemPipes;
  }

  ensureLocalUser() {
    const at = nowISO();
    this.db.prepare(`
      INSERT OR IGNORE INTO users (id, provider, subject, email, name, picture, created_at, last_login_at)
      VALUES ('local', 'local', 'local', NULL, NULL, NULL, ?, ?)
    `).run(at, at);
    return 'local';
  }

  upsertUser({ provider, subject, email, name, picture }) {
    const at = nowISO();
    return this.db.prepare(`
      INSERT INTO users (id, provider, subject, email, name, picture, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, subject) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        picture = excluded.picture,
        last_login_at = excluded.last_login_at
      RETURNING *
    `).get(
      'u-' + crypto.randomBytes(8).toString('hex'),
      String(provider), String(subject),
      email == null ? null : String(email),
      name == null ? null : String(name),
      picture == null ? null : String(picture),
      at, at,
    );
  }

  // The cookie carries the token; the database only ever sees its hash, so a
  // copied database yields no usable cookies.
  createSession(userId, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
    `).run(hashToken(token), userId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
    return token;
  }

  sessionUser(token) {
    if (typeof token !== 'string' || token === '') return null;
    const row = this.db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), nowISO());
    return row || null;
  }

  deleteSession(token) {
    if (typeof token !== 'string' || token === '') return;
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashToken(token));
  }

  purgeExpiredSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowISO());
  }

  listPipes(ownerId) {
    const own = ownerId == null ? [] : this.db.prepare(`
      SELECT id, name, saved_at FROM pipes WHERE owner_id = ? ORDER BY saved_at DESC, id ASC
    `).all(ownerId).map((r) => ({ id: r.id, name: r.name, savedAt: r.saved_at, readOnly: false }));
    const system = [...this.systemPipes.values()]
      .map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt, readOnly: true }))
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)) || a.id.localeCompare(b.id));
    return own.concat(system);
  }

  // Own row first, then the built-ins. A pipe belonging to somebody else is
  // indistinguishable from one that does not exist.
  getPipe(id, ownerId) {
    requireId(id);
    if (ownerId != null) {
      const row = this.db.prepare(`
        SELECT id, name, saved_at, definition FROM pipes WHERE id = ? AND owner_id = ?
      `).get(id, ownerId);
      if (row) return rowToPipe(row);
    }
    const system = this.systemPipes.get(id);
    return system ? structuredClone(system) : null;
  }

  savePipe(ownerId, { id, name, modules, wires }) {
    const definition = JSON.stringify({ modules, wires });
    const savedAt = nowISO();
    if (id === undefined || id === null || id === '') {
      const fresh = this.freshId(name);
      this.db.prepare(`
        INSERT INTO pipes (id, owner_id, name, saved_at, definition) VALUES (?, ?, ?, ?, ?)
      `).run(fresh, ownerId, name, savedAt, definition);
      return { id: fresh };
    }
    requireId(id);
    if (this.systemPipes.has(id)) {
      throw httpError(403, 'This pipe is a built-in demo; save it as a copy');
    }
    const info = this.db.prepare(`
      UPDATE pipes SET name = ?, saved_at = ?, definition = ? WHERE id = ? AND owner_id = ?
    `).run(name, savedAt, definition, id, ownerId);
    if (info.changes === 0) throw httpError(404, 'Pipe not found: ' + id);
    return { id };
  }

  deletePipe(id, ownerId) {
    requireId(id);
    if (this.systemPipes.has(id)) throw httpError(403, 'Built-in demo pipes cannot be deleted');
    this.db.prepare('DELETE FROM pipes WHERE id = ? AND owner_id = ?').run(id, ownerId);
  }

  // The only lookup that ignores ownership: a published feed has to be
  // readable by an RSS client that has no session. The id is the capability.
  publishedPipe(id) {
    requireId(id);
    const row = this.db.prepare(`
      SELECT id, name, saved_at, definition, owner_id FROM pipes WHERE id = ?
    `).get(id);
    if (row) return { pipe: rowToPipe(row), ownerId: row.owner_id };
    const system = this.systemPipes.get(id);
    return system ? { pipe: structuredClone(system), ownerId: null } : null;
  }

  // Ids are global, so a fresh one must miss the built-ins and every owner's
  // rows alike. 64 random bits: the loop is theory, not practice.
  freshId(name) {
    for (;;) {
      const id = slugify(name) + '-' + crypto.randomBytes(8).toString('hex');
      if (this.systemPipes.has(id)) continue;
      if (!this.db.prepare('SELECT 1 FROM pipes WHERE id = ?').get(id)) return id;
    }
  }

  close() {
    try {
      this.db.close();
    } catch { /* already closed */ }
  }
}

function rowToPipe(row) {
  let definition;
  try {
    definition = JSON.parse(row.definition);
  } catch {
    throw httpError(500, 'Stored pipe is corrupted: ' + row.id);
  }
  return {
    id: row.id,
    name: row.name,
    savedAt: row.saved_at,
    modules: definition.modules || [],
    wires: definition.wires || [],
    readOnly: false,
  };
}

export function openStore({ dbPath, systemPipesDir }) {
  const systemPipes = readSystemPipes(systemPipesDir);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return new Store(db, systemPipes);
}
