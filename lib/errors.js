// The one error shape every layer agrees on: an Error carrying the HTTP status
// the router should answer with (and optional response headers). Lives in its
// own module because the store and the auth code raise these too, and neither
// may import server.js.
export function httpError(status, message, headers) {
  const err = new Error(message);
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}
