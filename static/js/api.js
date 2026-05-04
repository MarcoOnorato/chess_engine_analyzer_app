/**
 * @fileoverview Thin HTTP and FEN helpers.
 *
 * `api(path, body)` is the single entry point for talking to the Python
 * backend — every other module funnels its requests through it so error
 * handling, headers, and serialization stay in one place.
 *
 * `fenToPos(fen)` extracts only the board layout from a full FEN string,
 * which is what chessboard.js expects when calling `board.position(...)`.
 */

/**
 * Performs a JSON POST request against the local backend.
 *
 * @param {string} path - API endpoint, e.g. "/api/analyze".
 * @param {Object} [body={}] - JSON-serializable payload.
 * @returns {Promise<Object>} Parsed JSON response.
 * @throws {Error} If the response status is not 2xx.
 */
export async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

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
