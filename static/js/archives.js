/**
 * @fileoverview Public game archives (Lichess, Chess.com), normalized.
 *
 * Both the Review page import modals (`lichess.js`, `chesscom.js`) and the
 * Training source picker (`training-source.js`) pull games from the same two
 * public APIs. Only their rendering differs, so the fetching, the NDJSON
 * parsing and the per-platform field mapping live here once.
 *
 * Every fetcher returns records in one shape, newest game first:
 *
 *     {
 *       pgn,            // the game's PGN text
 *       white, black,   // player names ("Anonymous" when unavailable)
 *       result,         // "1-0" | "0-1" | "½-½"
 *       date,           // Date the game finished, or null
 *       meta,           // short platform-specific descriptor, e.g. "blitz • standard"
 *     }
 *
 * These calls go straight from the browser to the platforms — both allow CORS
 * on their public endpoints, so no backend proxy is involved. (The server has
 * its own copy in `player_db/sources.py` for batch ingestion, which runs
 * without a browser.)
 */

const DRAW = "½-½";

/**
 * Fetches a Lichess user's most recent games.
 *
 * @param {string} username - Lichess account name.
 * @param {number|string} [count=10] - How many games to request.
 * @returns {Promise<Array<Object>>} Normalized game records, newest first.
 * @throws {Error} If the user does not exist or the API rejects the request.
 */
export async function fetchLichessGames(username, count = 10) {
  // pgnInJson=true so the PGN arrives inside each JSON record.
  const res = await fetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
      `?max=${encodeURIComponent(count)}&pgnInJson=true`,
    { headers: { Accept: "application/x-ndjson" } }
  );
  if (!res.ok) throw new Error("Lichess user not found or API error.");

  // Lichess answers with NDJSON. Read the body to completion: a single network
  // chunk may hold only the first game or two, depending on buffering.
  const text = await res.text();

  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .filter((game) => game.pgn)
    .map((game) => ({
      pgn: game.pgn,
      white: game.players?.white?.user?.name || "Anonymous",
      black: game.players?.black?.user?.name || "Anonymous",
      result:
        game.winner === "white" ? "1-0" : game.winner === "black" ? "0-1" : DRAW,
      date: game.createdAt ? new Date(game.createdAt) : null,
      meta: [game.speed, game.variant].filter(Boolean).join(" • "),
    }));
}

/**
 * Fetches one month of a Chess.com user's archive.
 *
 * @param {string} username - Chess.com account name.
 * @param {number|string} year - Four-digit year.
 * @param {number|string} month - Month, zero-padded or not.
 * @returns {Promise<Array<Object>>} Normalized game records, newest first.
 * @throws {Error} If the user or the month's archive does not exist.
 */
export async function fetchChessComGames(username, year, month) {
  const paddedMonth = String(month).padStart(2, "0");
  const res = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}` +
      `/games/${encodeURIComponent(year)}/${paddedMonth}`
  );
  if (!res.ok) throw new Error("User not found or no data for this month.");

  const data = await res.json();

  return (data.games || [])
    .filter((game) => game.pgn)
    .reverse() // the archive is oldest-first; everything here is newest-first
    .map((game) => ({
      pgn: game.pgn,
      white: game.white?.username || "Anonymous",
      black: game.black?.username || "Anonymous",
      result:
        game.white?.result === "win"
          ? "1-0"
          : game.black?.result === "win"
          ? "0-1"
          : DRAW,
      date: game.end_time ? new Date(game.end_time * 1000) : null,
      meta: game.time_class || "",
    }));
}

/**
 * Formats a record's date for display, tolerating a missing timestamp.
 *
 * @param {Object} game - A normalized record from this module.
 * @returns {string} Localized date, or "" when unknown.
 */
export function gameDate(game) {
  return game.date ? game.date.toLocaleDateString() : "";
}
