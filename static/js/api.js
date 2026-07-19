/**
 * @fileoverview Thin HTTP and FEN helpers.
 *
 * `api(path, body)` POSTs JSON; `api.get`, `api.post` and `api.del` cover the
 * other verbs. Every module talks to the Python backend through them so error
 * handling, headers and serialization stay in one place.
 *
 * Errors carry the backend's own message. The API answers failures with
 * `{"error": "..."}`, which is far more useful than a bare status code, so the
 * body is parsed before the status is checked and its `error` becomes the
 * thrown `Error`'s message.
 *
 * `fenToPos(fen)` extracts only the board layout from a full FEN string,
 * which is what chessboard.js expects when calling `board.position(...)`.
 */

/**
 * Performs a JSON request and unwraps the response.
 *
 * @param {string} method - HTTP verb.
 * @param {string} path - API endpoint, e.g. "/api/analyze".
 * @param {Object} [body] - JSON-serializable payload; omitted for GET/DELETE.
 * @returns {Promise<Object|null>} Parsed JSON, or null for an empty body.
 * @throws {Error} If the response status is not 2xx.
 */
async function request(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);

  // Read the body first: error responses carry the reason, and some endpoints
  // legitimately answer with no content at all.
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (!res.ok) {
    throw new Error((data && data.error) || `${path} -> ${res.status}`);
  }
  return data;
}

/**
 * Performs a JSON POST request against the backend.
 *
 * @param {string} path - API endpoint, e.g. "/api/analyze".
 * @param {Object} [body={}] - JSON-serializable payload.
 * @returns {Promise<Object>} Parsed JSON response.
 * @throws {Error} If the response status is not 2xx.
 */
export async function api(path, body) {
  return request("POST", path, body || {});
}

/** GET `path`. @see request */
api.get = (path) => request("GET", path);

/** POST `body` to `path`. @see request */
api.post = (path, body) => request("POST", path, body);

/** DELETE `path`. @see request */
api.del = (path) => request("DELETE", path);

/**
 * Strips the side-to-move / castling / en-passant / clock fields from a FEN,
 * returning only the position layout (the part chessboard.js renders).
 *
 * @param {string} fen - Full FEN string.
 * @returns {string} The piece-placement field of the FEN.
 */
export function fenToPos(fen) {
  return fen.split(" ")[0];
}
