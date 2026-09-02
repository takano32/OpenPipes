// A miniature OpenID Connect provider, in-process, on loopback. It exists so
// the login flow can be tested end to end with no network and no Google: it
// checks the things a real provider checks (client id and secret, the PKCE
// challenge, the redirect_uri, single-use codes) and answers a real RS256
// id_token, so a client that passes here is at least internally consistent.
//
//   const issuer = await startFakeIssuer({ clientId, clientSecret });
//   issuer.setUser({ sub: 'u2', email: 'b@example.com' });
//   await issuer.close();
import http from 'node:http';
import crypto from 'node:crypto';

const KID = 'test-key';
const DEFAULT_USER = {
  sub: 'fake-sub-a',
  email: 'a@example.com',
  email_verified: true,
  name: 'Fake User A',
  picture: 'https://example.com/avatar-a.png',
};

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signJwt(payload, privateKey) {
  const input = b64({ alg: 'RS256', typ: 'JWT', kid: KID }) + '.' + b64(payload);
  return input + '.' + crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url');
}

function send(res, status, body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startFakeIssuer({ clientId, clientSecret }) {
  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  let user = { ...DEFAULT_USER };
  const codes = new Map(); // code -> { nonce, challenge, redirectUri }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const issuer = `http://127.0.0.1:${server.address().port}`;

    if (url.pathname === '/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }

    if (url.pathname === '/jwks') {
      return send(res, 200, { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
    }

    // Every missing parameter is named in the body, so a broken client is
    // diagnosable straight from the test output.
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      for (const name of ['response_type', 'client_id', 'redirect_uri', 'state', 'nonce',
                          'code_challenge', 'code_challenge_method']) {
        if (!q.get(name)) return send(res, 400, `missing ${name}`, 'text/plain');
      }
      if (q.get('response_type') !== 'code') return send(res, 400, 'bad response_type', 'text/plain');
      if (q.get('client_id') !== clientId) return send(res, 400, 'bad client_id', 'text/plain');
      if (q.get('code_challenge_method') !== 'S256') {
        return send(res, 400, 'bad code_challenge_method', 'text/plain');
      }
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, {
        nonce: q.get('nonce'),
        challenge: q.get('code_challenge'),
        redirectUri: q.get('redirect_uri'),
      });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const code = form.get('code');
      const saved = codes.get(code);
      if (form.get('grant_type') !== 'authorization_code') {
        return send(res, 400, { error: 'unsupported_grant_type' });
      }
      if (!saved) return send(res, 400, { error: 'invalid_grant' });
      codes.delete(code); // an authorization code is good exactly once
      if (form.get('redirect_uri') !== saved.redirectUri) {
        return send(res, 400, { error: 'invalid_grant', detail: 'redirect_uri' });
      }
      if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
        return send(res, 400, { error: 'invalid_client' });
      }
      const verifier = form.get('code_verifier') || '';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== saved.challenge) return send(res, 400, { error: 'invalid_grant', detail: 'pkce' });

      const iat = Math.floor(Date.now() / 1000);
      const idToken = signJwt({
        iss: issuer,
        aud: clientId,
        ...user,
        nonce: saved.nonce,
        iat,
        exp: iat + 3600,
      }, keyPair.privateKey);
      return send(res, 200, {
        access_token: 'x', token_type: 'Bearer', expires_in: 3600, id_token: idToken,
      });
    }

    send(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    issuer: `http://127.0.0.1:${server.address().port}`,
    keyPair,
    setUser(claims) {
      user = { ...DEFAULT_USER, ...claims };
    },
    // Both runners rely on the process exiting by itself, so this has to let
    // go of keep-alive sockets as well as the listener.
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    },
  };
}
