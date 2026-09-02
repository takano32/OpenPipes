// Login plumbing: cookies, the OpenID Connect dance, and id_token
// verification. Everything in this file that can be pure is pure, so the
// interesting rules (what a token has to satisfy, what a return_to may look
// like) are unit-testable without an HTTP server or a network.
import crypto from 'node:crypto';

import { httpError } from './errors.js';

// Hashing first so the comparison is over equal-length buffers whatever the
// inputs were.
export function secretEquals(a, b) {
  const digest = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/* ---------- cookies ---------- */

// Null-prototype, so a cookie called `constructor` cannot be mistaken for one.
// The first occurrence of a name wins, which is what browsers mean by sending
// the most specific one first.
export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || name in out) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/* ---------- where to go after logging in ---------- */

// Only a path on this server, so the login link cannot be turned into an open
// redirect. `//evil.example` and `/\evil.example` are protocol-relative URLs
// in a browser, which is why they are refused as well.
export function safeReturnTo(value) {
  if (typeof value !== 'string') return '/';
  if (value.length === 0 || value.length > 2048) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\r\n]/.test(value)) return '/';
  return value;
}

/* ---------- allowlist ---------- */

// Comma-separated emails and @domains. An empty list means no restriction at
// all: anyone with an account at the provider may sign in.
export function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

export function matchesAllowlist(email, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return true;
  if (typeof email !== 'string' || email === '') return false;
  const address = email.trim().toLowerCase();
  return entries.some((entry) =>
    entry.startsWith('@') ? address.endsWith(entry) : address === entry);
}

/* ---------- PKCE ---------- */

// The verifier stays in a cookie on this server; only its hash travels to the
// provider, so a stolen authorization code is useless on its own.
export function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

/* ---------- id_token ---------- */

function decodeSegment(segment, what) {
  let json;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new Error(`id_token ${what} is not base64url`);
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`id_token ${what} is not JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`id_token ${what} is not a JSON object`);
  }
  return value;
}

// Splits the token so the caller can pick a key by `header.kid` before
// verifying anything. Nothing here is trusted yet.
export function decodeJwt(token) {
  if (typeof token !== 'string') throw new Error('id_token is not a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('id_token must have three parts');
  return {
    header: decodeSegment(parts[0], 'header'),
    payload: decodeSegment(parts[1], 'payload'),
    signingInput: parts[0] + '.' + parts[1],
    signature: parts[2],
  };
}

// Google historically issued `accounts.google.com` for an issuer configured as
// `https://accounts.google.com`, and still documents both as acceptable.
const issuerForms = (issuer) => {
  const trimmed = String(issuer).replace(/\/+$/, '');
  return [trimmed, trimmed.replace(/^https?:\/\//, '')];
};

// Pure and synchronous: give it the key, the expectations and the clock.
// Throws on anything that does not add up; returns the payload when it does.
export function verifyIdToken(token, { key, issuer, clientId, nonce, now = Date.now() }) {
  const { header, payload, signingInput, signature } = decodeJwt(token);

  // RS256 only. `none` is the classic forgery, and accepting HS256 would let
  // the (public) signing key be used as an HMAC secret.
  if (header.alg !== 'RS256') throw new Error(`id_token alg must be RS256, got ${header.alg}`);
  if (!key) throw new Error('no key to verify the id_token with');
  const ok = crypto.verify('sha256', Buffer.from(signingInput),
    key, Buffer.from(signature, 'base64url'));
  if (!ok) throw new Error('id_token signature does not verify');

  if (!issuerForms(issuer).includes(String(payload.iss))) {
    throw new Error(`id_token iss is ${payload.iss}, expected ${issuer}`);
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) {
    throw new Error('id_token aud does not contain this client id');
  }
  // A minute of skew in both directions: clocks drift, and a token that is
  // barely expired is a clock problem, not an attack.
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now - 60000) {
    throw new Error('id_token has expired');
  }
  if (payload.iat !== undefined && !(typeof payload.iat === 'number' && payload.iat * 1000 < now + 60000)) {
    throw new Error('id_token was issued in the future');
  }
  if (payload.nonce !== nonce) throw new Error('id_token nonce does not match this login');
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new Error('id_token has no sub');
  }
  return payload;
}

/* ---------- the provider ---------- */

const DISCOVERY_TIMEOUT_MS = 15000;
const JWKS_MIN_INTERVAL_MS = 60_000;      // a stream of bad kids must not turn
const JWKS_MAX_AGE_MS = 24 * 3600 * 1000; // this server into a JWKS amplifier

// Everything that has to talk to the OpenID provider. `fetch` is a constructor
// option so a test can stub it; by default it is the global one, deliberately
// not lib/feed.js's fetchURL — the issuer is operator configuration, not a URL
// a pipe author chose, and in the tests it lives on loopback.
export class OidcClient {
  #fetch;
  #config = null;
  #keys = null;
  #keysAt = 0;

  constructor({ issuer, clientId, clientSecret, redirectUri, fetch: fetchImpl }) {
    this.issuer = String(issuer).replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.#fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  // Lazy, and memoised only on success: the server must boot even when the
  // provider is unreachable, and a failed attempt must not poison the next one.
  async discover() {
    if (this.#config) return this.#config;
    const url = this.issuer + '/.well-known/openid-configuration';
    let doc;
    try {
      const res = await this.#fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
    } catch (err) {
      throw httpError(502, `OIDC discovery failed for ${url}: ${err.message}`);
    }
    if (!doc || typeof doc !== 'object') throw httpError(502, 'OIDC discovery returned no document');
    // A document that names another issuer is not this issuer's document.
    if (String(doc.issuer).replace(/\/+$/, '') !== this.issuer) {
      throw httpError(502, `OIDC discovery issuer mismatch: ${doc.issuer}`);
    }
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof doc[field] !== 'string' || doc[field] === '') {
        throw httpError(502, `OIDC discovery has no ${field}`);
      }
    }
    this.#config = {
      issuer: String(doc.issuer),
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
    };
    return this.#config;
  }

  // Built by hand rather than with URLSearchParams, which would write the
  // scope separator as `+`; providers accept it, but %20 is what the spec
  // shows and what is easiest to read in a redirect.
  async authorizationUrl({ state, nonce, challenge }) {
    const { authorizationEndpoint } = await this.discover();
    const query = Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return authorizationEndpoint + (authorizationEndpoint.includes('?') ? '&' : '?') + query;
  }

  // Google wants the client secret here even with PKCE. The access_token in
  // the answer is of no use to us; only the id_token is.
  async exchangeCode({ code, verifier }) {
    const { tokenEndpoint } = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: verifier,
    });
    let json;
    try {
      const res = await this.#fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      throw httpError(502, `OIDC token request failed: ${err.message}`);
    }
    if (!json || typeof json.id_token !== 'string') {
      throw httpError(502, 'OIDC token response carried no id_token');
    }
    return json;
  }

  async #fetchJwks() {
    const { jwksUri } = await this.discover();
    let doc;
    try {
      const res = await this.#fetch(jwksUri, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json();
    } catch (err) {
      throw httpError(502, `JWKS fetch failed: ${err.message}`);
    }
    const keys = new Map();
    for (const jwk of Array.isArray(doc?.keys) ? doc.keys : []) {
      if (!jwk || typeof jwk.kid !== 'string') continue;
      try {
        keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      } catch { /* a key we cannot build is a key we cannot verify with */ }
    }
    this.#keys = keys;
    this.#keysAt = Date.now();
  }

  // Refetch on an unknown kid — providers rotate — but at most once a minute,
  // and refetch anyway once the cache is a day old.
  async keyFor(kid) {
    if (!this.#keys || Date.now() - this.#keysAt > JWKS_MAX_AGE_MS) await this.#fetchJwks();
    let key = this.#keys.get(kid);
    if (!key && Date.now() - this.#keysAt > JWKS_MIN_INTERVAL_MS) {
      await this.#fetchJwks();
      key = this.#keys.get(kid);
    }
    return key || null;
  }

  async verify(idToken, nonce) {
    const config = await this.discover();
    const { header } = decodeJwt(idToken);
    const key = await this.keyFor(header.kid);
    return verifyIdToken(idToken, {
      key, issuer: config.issuer, clientId: this.clientId, nonce,
    });
  }
}
