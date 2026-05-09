/**
 * @fileoverview Position pickers — pure functions over the analyzed game tree.
 *
 * Each picker returns a list of `ScenarioSpec` objects (see training-session.js)
 * sorted by relevance (worst error first, biggest brilliancy first, etc.).
 *
 * Pickers read from `mainLineNodes()` and never mutate state. They rely on
 * fields that are populated by the post-load engine pass in pgn.js:
 *   - node.cpLoss       centipawn loss of the move that led to this node
 *   - node.eval         engine eval at this node (white's POV, in pawns)
 *   - node.evalData     classification { label, symbol, color }
 *   - node.parent       walking up to inspect the position before the move
 *
 * Ply convention (matches accuracy.js): odd plies are White's moves,
 * even plies are Black's. So a node represents the position *after* the
 * side identified by ply%2 just moved.
 */

import { mainLineNodes } from "./state.js";

/** Cp-loss minimum to be considered an "error" worth training. */
const ERROR_CP_THRESHOLD = 80; // ~Inaccuracy or worse
/** Eval (for the user) below which the position is considered "doomed". */
const DOOMED_EVAL = -4.0;
/** Eval window for resilience: bad but not lost. */
const RESILIENCE_RANGE = { min: -3.5, max: -0.8 };

/**
 * Returns the array of played SANs until that moment
 */
function getPastMoves(node) {
  const moves = [];
  let current = node;
  
  while (current && current.parent) {
    if (current.san) moves.push(current.san);
    current = current.parent;
  }
  
  return moves.reverse();
}

/**
 * Picks the user's worst played moves on the main line.
 *
 * Skips positions that were already losing before the move (no point
 * training "find the magic move" when the position was -8 already).
 *
 * @param {{ userColor: "white"|"black", max: number }} opts
 * @returns {ScenarioSpec[]}
 */
export function pickWorstErrors({ userColor, max }) {
  const userParity = userColor === "white" ? 1 : 0;
  const candidates = mainLineNodes()
    .filter((n) => n.ply % 2 === userParity)
    .filter((n) => (n.cpLoss ?? 0) >= ERROR_CP_THRESHOLD)
    .filter((n) => isPositionRecoverable(n, userColor))
    .sort((a, b) => (b.cpLoss || 0) - (a.cpLoss || 0))
    .slice(0, max);

  return candidates.map((n) => toScenario(n, "user-error"));
}

/**
 * Picks branching points where the *opponent* played a mistake / blunder.
 * Used by WHAT-IF mode: train the user to capitalize on those errors,
 * or to handle the line where the opponent had played the engine's choice.
 *
 * @param {{ userColor: "white"|"black", max: number }} opts
 * @returns {ScenarioSpec[]}
 */
export function pickOpponentMistakes({ userColor, max }) {
  const oppParity = userColor === "white" ? 0 : 1;
  return mainLineNodes()
    .filter((n) => n.ply % 2 === oppParity)
    .filter((n) => (n.cpLoss ?? 0) >= ERROR_CP_THRESHOLD)
    .sort((a, b) => (b.cpLoss || 0) - (a.cpLoss || 0))
    .slice(0, max)
    .map((n) => toScenario(n, "opp-error"));
}

/**
 * Picks the user's brilliant moves to replay them as a "study the line"
 * scenario. Useful for WHAT-IF: see the line that worked.
 *
 * @param {{ userColor: "white"|"black", max: number }} opts
 * @returns {ScenarioSpec[]}
 */
export function pickBrilliants({ userColor, max }) {
  const userParity = userColor === "white" ? 1 : 0;
  return mainLineNodes()
    .filter((n) => n.ply % 2 === userParity)
    .filter((n) => n.evalData?.label === "Brilliant")
    .slice(0, max)
    .map((n) => toScenario(n, "brilliant"));
}

/**
 * Picks positions where the user is significantly worse but not lost,
 * for the RESILIENCE mode: the goal is "hold the position".
 *
 * @param {{ userColor: "white"|"black", max: number }} opts
 * @returns {ScenarioSpec[]}
 */
export function pickResiliencePositions({ userColor, max }) {
  const userParity = userColor === "white" ? 1 : 0;
  // Pick parent nodes whose `eval` (user's POV) sits in the bad-but-not-lost
  // range; user is to move from that parent.
  const candidates = mainLineNodes()
    .filter((n) => n.ply % 2 === userParity) // user just played → next is opp
    .map((n) => n.parent) // position where user was to move
    .filter((p) => p && p.eval != null)
    .filter((p) => {
      const e = signedForUser(p.eval, userColor);
      return e > RESILIENCE_RANGE.min && e < RESILIENCE_RANGE.max;
    });

  // Deduplicate by FEN (in case a position recurs).
  const seen = new Set();
  const unique = candidates.filter((p) => {
    if (seen.has(p.fenAfter)) return false;
    seen.add(p.fenAfter);
    return true;
  });

  return unique
    .sort((a, b) => signedForUser(a.eval, userColor) - signedForUser(b.eval, userColor))
    .slice(0, max)
    .map((p) => ({
      fen: p.fenAfter,
      contextSan: null,
      reason: `Eval ${signedForUser(p.eval, userColor).toFixed(2)} — hold the position`,
      cpLoss: 0,
      ply: p.ply,
      note: "Resilience: minimize damage, play top engine moves.",
    }));
}

/* ==========================================================================
   Helpers
   ========================================================================== */

/**
 * Builds a ScenarioSpec from a "this is the move we are reproducing" node.
 * The training position is the FEN *before* that move (i.e. parent.fenAfter).
 *
 * @param {import("../state.js").Node} node
 * @param {"user-error"|"opp-error"|"brilliant"} kind
 * @returns {ScenarioSpec}
 */
function toScenario(node, kind) {
  const parent = node.parent;
  const reason = describe(node, kind);
  return {
    fen: parent ? parent.fenAfter : node.fenBefore,
    contextSan: node.san,
    reason,
    cpLoss: node.cpLoss || 0,
    ply: node.ply,
    note: kindNote(kind),
    precedingMoves: getPastMoves(node)
  };
}

function describe(node, kind) {
  const label = node.evalData?.label || "Move";
  const cp = node.cpLoss ? ` (-${(node.cpLoss / 100).toFixed(1)})` : "";
  if (kind === "user-error") return `Your ${label}${cp} — replay correctly`;
  if (kind === "opp-error") return `Opponent ${label}${cp} — capitalize`;
  if (kind === "brilliant") return `Your Brilliant ${node.san} — replay`;
  return label;
}

function kindNote(kind) {
  switch (kind) {
    case "user-error":
      return "Find the engine's preferred move at this position.";
    case "opp-error":
      return "Opponent erred here; you must punish with the top move.";
    case "brilliant":
      return "Replay the brilliancy from this position.";
    default:
      return "";
  }
}

/**
 * Eval is stored in white's POV, in pawns. Convert to user's POV.
 * @param {number} e
 * @param {"white"|"black"} userColor
 */
function signedForUser(e, userColor) {
  return userColor === "white" ? e : -e;
}

/**
 * A position is "recoverable" if its pre-move eval (user's POV) isn't
 * already deep-loss territory.
 * @param {import("../state.js").Node} node
 * @param {"white"|"black"} userColor
 */
function isPositionRecoverable(node, userColor) {
  const parent = node.parent;
  if (!parent || parent.eval == null) return true;
  return signedForUser(parent.eval, userColor) > DOOMED_EVAL;
}

/** @typedef {import("./training-session.js").ScenarioSpec} ScenarioSpec */
