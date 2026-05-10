/**
 * @fileoverview Cross-game player analysis pipeline.
 *
 * Given a list of PGN strings and the player's username, this module:
 *   1. Sends each game to `/api/load_pgn` + `/api/analyze` (dedup'd by FEN).
 *   2. Classifies each move error into one of four tactical categories:
 *        HANGING_PIECE   — the user left a piece en prise.
 *        MISSED_CAPTURE  — a free capture was available but not taken.
 *        MISSED_MATE     — a forced mate was on the board but not played.
 *        MISSED_TACTIC   — generic: combinatorial motif that the engine
 *                          preferred by ≥ CP_TACTIC_THRESHOLD centipawns.
 *   3. Counts category frequencies and returns them with the raw scenario
 *      specs so the caller can offer a filtered training menu.
 *
 * Only the main line of each game is inspected; sidelines are ignored.
 * Analysis results are cached per FEN across all games to minimise API calls.
 */

import { api } from "./api.js";

/* ─── Thresholds ─────────────────────────────────────────────────────────── */

/** Minimum cp-loss to count as an "error" in any category. */
const CP_ERROR_MIN = 80;

/** Cp-loss above which we call something a full blunder (used for weighting). */
const CP_BLUNDER = 200;

/**
 * Cp-loss above which an error is classified as a MISSED_TACTIC
 * (vs a simpler category already matched).
 */
const CP_TACTIC_THRESHOLD = 120;

/** Maximum number of scenarios per category (prevents enormous sessions). */
const MAX_PER_CATEGORY = 8;

/* ─── Category identifiers ───────────────────────────────────────────────── */

export const PLAYER_ERROR_TYPES = Object.freeze({
  HANGING_PIECE:  "hanging_piece",
  MISSED_CAPTURE: "missed_capture",
  MISSED_MATE:    "missed_mate",
  MISSED_TACTIC:  "missed_tactic",
});

/* ─── Public entry ───────────────────────────────────────────────────────── */

/**
 * Analyses a collection of PGN strings from the player's POV.
 *
 * @param {string[]} pgns          Array of raw PGN strings.
 * @param {string}   playerName    Chess.com / Lichess username (case-insensitive).
 * @param {number}   [depth=12]    Engine depth for analysis calls.
 * @param {(done:number,total:number,label:string)=>void} [onProgress]
 * @returns {Promise<PlayerAnalysisResult>}
 */
export async function analysePlayerGames(pgns, playerName, depth = 12, onProgress) {
  const name = playerName.toLowerCase();

  /** FEN → analysis response, shared across all games. */
  const fenCache = new Map();

  /** Category → ScenarioSpec[] */
  const byCategory = {
    [PLAYER_ERROR_TYPES.HANGING_PIECE]:  [],
    [PLAYER_ERROR_TYPES.MISSED_CAPTURE]: [],
    [PLAYER_ERROR_TYPES.MISSED_MATE]:    [],
    [PLAYER_ERROR_TYPES.MISSED_TACTIC]:  [],
  };

  let totalAnalysed = 0;

  for (let gi = 0; gi < pgns.length; gi++) {
    const pgn = pgns[gi];
    onProgress?.(gi, pgns.length, `Loading game ${gi + 1} / ${pgns.length}…`);

    let treeData;
    try {
      treeData = await api("/api/load_pgn", { pgn });
    } catch (e) {
      console.warn(`[player-analysis] Failed to load game ${gi + 1}:`, e);
      continue;
    }

    // Determine the player's colour in this game.
    const whiteHeader = extractHeader(pgn, "White");
    const blackHeader = extractHeader(pgn, "Black");
    const userColor =
      whiteHeader?.toLowerCase() === name ? "white"
      : blackHeader?.toLowerCase() === name ? "black"
      : null;

    if (!userColor) {
      // Player not found in this game — skip.
      continue;
    }

    // Build a flat main-line node list from the backend tree.
    const startFen = treeData.start_fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const mainLine = extractMainLine(treeData, startFen);

    if (mainLine.length === 0) continue;

    // Analyse every node, using the shared cache.
    const total = mainLine.length;
    for (let ni = 0; ni < total; ni++) {
      const node = mainLine[ni];
      totalAnalysed++;
      onProgress?.(gi, pgns.length, `Game ${gi + 1}: analysing move ${ni + 1}/${total}…`);

      let analysis = fenCache.get(node.fenAfter);
      if (!analysis) {
        try {
          analysis = await api("/api/analyze", {
            fen: node.fenAfter,
            prev_fen: node.fenBefore,
            last_move_uci: node.uci,
            depth,
          });
          fenCache.set(node.fenAfter, analysis);
        } catch (e) {
          console.warn("[player-analysis] Engine call failed:", e);
          continue;
        }
      }

      // Annotate the node with engine data.
      node.eval     = analysis.eval;
      node.eval_mate = analysis.eval_mate;
      node.cpLoss   = Math.max(0, analysis.best_eval_loss || 0);
      node.evalData = analysis.classification;
      node.topMoves = analysis.top_moves || [];

      // Skip moves not made by the user.
      // Ply is 1-based; odd = White, even = Black.
      const isUserMove = userColor === "white"
        ? node.ply % 2 === 1
        : node.ply % 2 === 0;

      if (!isUserMove) continue;
      if (node.cpLoss < CP_ERROR_MIN) continue;

      // Classify and record.
      const category = classifyError(node, userColor, mainLine);
      if (!category) continue;

      const spec = buildSpec(node, category, userColor, startFen, mainLine, pgn);
      if (byCategory[category].length < MAX_PER_CATEGORY) {
        byCategory[category].push(spec);
      }
    }
  }

  onProgress?.(pgns.length, pgns.length, "Analysis complete.");

  // Compute category frequencies (as percentages of user errors).
  const counts = Object.fromEntries(
    Object.entries(byCategory).map(([k, v]) => [k, v.length])
  );
  const totalErrors = Object.values(counts).reduce((a, b) => a + b, 0);
  const frequencies = Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [
      k,
      totalErrors > 0 ? Math.round((v / totalErrors) * 100) : 0,
    ])
  );

  return { byCategory, counts, frequencies, totalAnalysed };
}

/* ─── Classification logic ───────────────────────────────────────────────── */

/**
 * Returns the most specific error category for a node, or null if none applies.
 *
 * Priority: missed_mate > hanging_piece > missed_capture > missed_tactic.
 *
 * @param {NodeLite} node
 * @param {"white"|"black"} userColor
 * @param {NodeLite[]} mainLine
 * @returns {string|null}
 */
function classifyError(node, userColor, mainLine) {
  const parent = node.parent;
  if (!parent) return null;

  // 1. Missed mate — the engine had a forced mate from the parent position
  //    that the user didn't follow.
  const parentMate = signedForUser(parent.eval_mate, userColor);
  if (parentMate != null && parentMate > 0) {
    const nodeMate = signedForUser(node.eval_mate, userColor);
    const deliveredMate = node.san?.endsWith("#");
    if (!deliveredMate && (nodeMate == null || nodeMate !== parentMate - 1)) {
      return PLAYER_ERROR_TYPES.MISSED_MATE;
    }
  }

  // 2. Hanging piece — a piece the user could have captured was left en prise.
  //    Heuristic: the engine's top move from the parent position is a capture
  //    (UCI target is occupied), but the user played something else.
  if (parent.topMoves?.length > 0) {
    const best = parent.topMoves[0];
    if (best && best.uci && best.uci !== node.uci) {
      if (isCapture(best.uci, parent.fenAfter)) {
        // The best move was a free capture that the user missed.
        const captureScore = best.score ?? 0;
        // Only flag as "hanging" if it represents a genuine material gain.
        if (captureScore > 0.5 || (best.mate != null && best.mate > 0)) {
          return PLAYER_ERROR_TYPES.HANGING_PIECE;
        }
      }
    }
  }

  // 3. Missed capture — the user could have taken something but didn't,
  //    and the best engine move at THIS position is a recapture or the
  //    opponent just took something. Simpler proxy: the user's move is NOT
  //    a capture but the best engine move IS, and cp-loss is significant.
  if (node.topMoves?.length > 0) {
    const bestHere = node.topMoves[0];
    const userMoveIsCapture = node.san?.includes("x");
    if (!userMoveIsCapture && bestHere?.san?.includes("x") && node.cpLoss >= CP_ERROR_MIN) {
      return PLAYER_ERROR_TYPES.MISSED_CAPTURE;
    }
  }

  // 4. Missed tactic — catch-all for high cp-loss errors not matching above.
  if (node.cpLoss >= CP_TACTIC_THRESHOLD) {
    return PLAYER_ERROR_TYPES.MISSED_TACTIC;
  }

  return null;
}

/* ─── Spec builder ───────────────────────────────────────────────────────── */

/**
 * Builds a ScenarioSpec (compatible with training-session.js) from an
 * analysed node.
 */
function buildSpec(node, category, userColor, rootFen, mainLine, pgn) {
  const parent = node.parent;
  const fen = parent ? parent.fenAfter : node.fenBefore;

  // Preceding moves up to (but not including) this node.
  const precedingMoves = getPrecedingMoves(node);

  const mateIn = category === PLAYER_ERROR_TYPES.MISSED_MATE
    ? (signedForUser(parent?.eval_mate, userColor) ?? 0)
    : 0;

  const isMateScenario = mateIn > 0;

  return {
    fen,
    rootFen,
    contextSan: node.san,
    reason: describeError(node, category, mateIn),
    cpLoss: node.cpLoss,
    ply: node.ply,
    note: categoryNote(category, mateIn),
    precedingMoves,
    isMateScenario,
    mateForcedDepth: isMateScenario ? mateIn * 2 - 1 : null,
    // Extra metadata for display.
    category,
    sourcePgn: pgn,
    userColor,
  };
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function describeError(node, category, mateIn) {
  switch (category) {
    case PLAYER_ERROR_TYPES.MISSED_MATE:
      return `Missed Mate in ${mateIn} — find the forcing line`;
    case PLAYER_ERROR_TYPES.HANGING_PIECE:
      return `Missed free piece — ${node.san} let material hang (-${(node.cpLoss / 100).toFixed(1)})`;
    case PLAYER_ERROR_TYPES.MISSED_CAPTURE:
      return `Missed capture — best was a take (-${(node.cpLoss / 100).toFixed(1)})`;
    case PLAYER_ERROR_TYPES.MISSED_TACTIC:
      return `Missed tactic — ${node.evalData?.label || "Error"} (-${(node.cpLoss / 100).toFixed(1)})`;
    default:
      return "Error — find the engine's move";
  }
}

function categoryNote(category, mateIn) {
  switch (category) {
    case PLAYER_ERROR_TYPES.MISSED_MATE:
      return `There was a forced Mate in ${mateIn}. Find every move of the mating line.`;
    case PLAYER_ERROR_TYPES.HANGING_PIECE:
      return "A piece was left en prise. Find the best capture.";
    case PLAYER_ERROR_TYPES.MISSED_CAPTURE:
      return "You could have captured material. Find the best move.";
    case PLAYER_ERROR_TYPES.MISSED_TACTIC:
      return "A strong tactical move was available. Find it.";
    default:
      return "Find the engine's preferred move.";
  }
}

/**
 * Returns true if the UCI move is a capture in the given FEN.
 * We check the destination square for an enemy piece by inspecting the
 * FEN piece-placement string.
 */
function isCapture(uci, fen) {
  if (!uci || !fen) return false;
  const to = uci.slice(2, 4);
  return fenSquareOccupied(fen, to);
}

/**
 * Checks whether a square is occupied in the given FEN.
 * @param {string} fen
 * @param {string} sq  e.g. "e4"
 * @returns {boolean}
 */
function fenSquareOccupied(fen, sq) {
  const placement = fen.split(" ")[0];
  const file = sq.charCodeAt(0) - 97; // 0-7
  const rank = parseInt(sq[1], 10) - 1; // 0-7 (0 = rank 1)
  const rows = placement.split("/");
  // FEN rows go rank 8 → rank 1, so row index = 7 - rank.
  const row = rows[7 - rank];
  if (!row) return false;

  let col = 0;
  for (const ch of row) {
    if (ch >= "1" && ch <= "8") {
      col += parseInt(ch, 10);
    } else {
      if (col === file) return true; // occupied
      col++;
    }
    if (col > file) break;
  }
  return false;
}

function signedForUser(val, userColor) {
  if (val == null) return null;
  return userColor === "white" ? val : -val;
}

/**
 * Extracts a PGN header value (e.g. White, Black, Result).
 */
function extractHeader(pgn, tag) {
  const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`));
  return m ? m[1] : null;
}

/**
 * Flattens the backend tree into a main-line node list with parent pointers.
 * Each node gets: san, uci, fenBefore, fenAfter, ply, parent, topMoves, eval, eval_mate, cpLoss.
 *
 * @param {Object} treeData  Backend response from /api/load_pgn.
 * @param {string} startFen
 * @returns {NodeLite[]}
 */
function extractMainLine(treeData, startFen) {
  const nodes = [];

  // Build a synthetic parent root.
  const root = {
    fenAfter: startFen,
    eval: null,
    eval_mate: null,
    topMoves: [],
    ply: 0,
    parent: null,
  };

  if (treeData.tree && Array.isArray(treeData.tree.children)) {
    walkMainLine(treeData.tree, root, 1, nodes);
  } else if (treeData.moves && treeData.fens) {
    // Flat fallback.
    let parent = root;
    treeData.moves.forEach((m, i) => {
      const node = {
        san: m.san,
        uci: m.uci,
        fenBefore: treeData.fens[i],
        fenAfter: treeData.fens[i + 1],
        ply: i + 1,
        parent,
        eval: null,
        eval_mate: null,
        cpLoss: 0,
        evalData: null,
        topMoves: [],
      };
      nodes.push(node);
      parent = node;
    });
  }

  return nodes;
}

/** Depth-first walk along children[0] only (main line). */
function walkMainLine(backendNode, parent, ply, out) {
  if (!backendNode.children || backendNode.children.length === 0) return;
  const child = backendNode.children[0]; // main-line continuation
  const node = {
    san: child.san,
    uci: child.uci,
    fenBefore: child.fenBefore,
    fenAfter: child.fenAfter,
    ply,
    parent,
    eval: null,
    eval_mate: null,
    cpLoss: 0,
    evalData: null,
    topMoves: [],
  };
  out.push(node);
  walkMainLine(child, node, ply + 1, out);
}

/**
 * Builds the SAN list of moves preceding `node` (context moves for display).
 */
function getPrecedingMoves(node) {
  const moves = [];
  let cur = node.parent;
  while (cur && cur.san) {
    moves.unshift(cur.san);
    cur = cur.parent;
  }
  return moves;
}

/* ─── Types ──────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} NodeLite
 * @property {string} san
 * @property {string} uci
 * @property {string} fenBefore
 * @property {string} fenAfter
 * @property {number} ply
 * @property {NodeLite|null} parent
 * @property {number|null} eval
 * @property {number|null} eval_mate
 * @property {number} cpLoss
 * @property {Object|null} evalData
 * @property {Array} topMoves
 *
 * @typedef {Object} PlayerAnalysisResult
 * @property {Record<string, ScenarioSpec[]>} byCategory
 * @property {Record<string, number>} counts
 * @property {Record<string, number>} frequencies
 * @property {number} totalAnalysed
 */
