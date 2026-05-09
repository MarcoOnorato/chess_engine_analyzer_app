/**
 * @fileoverview Position pickers — pure functions over the analyzed game tree.
 *
 * Each picker returns a list of `ScenarioSpec` objects (see training-session.js)
 * sorted by relevance (worst error first, biggest brilliancy first, etc.).
 *
 * Pickers read from `mainLineNodes()` and never mutate state. They rely on
 * fields populated by the post-load engine pass in pgn.js:
 *   - node.cpLoss       centipawn loss of the move that led to this node
 *   - node.eval         engine eval at this node (white's POV, in pawns)
 *   - node.eval_mate    forced-mate distance at this node (white POV, or null)
 *   - node.evalData     classification { label, symbol, color }
 *   - node.parent       walking up to inspect the position before the move
 *
 * Ply convention: odd plies are White's moves, even are Black's. A node
 * represents the position *after* the side identified by ply%2 just moved.
 */

import { mainLineNodes } from "./state.js";

/** Cp-loss minimum to be considered an "error" worth training. */
const ERROR_CP_THRESHOLD = 80;
/** Eval (for the user) below which the position is considered "doomed". */
const DOOMED_EVAL = -4.0;
/** Eval window for resilience: bad but not lost. */
const RESILIENCE_RANGE = { min: -3.5, max: -0.8 };

/* ==========================================================================
   Helpers
   ========================================================================== */

/** Returns the SAN array of all moves played from the root up to (but not
 *  including) `node` — the "context" preceding this position. */
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
 * Eval is stored white-POV. Convert to user's POV (positive = user winning).
 * @param {number|null} e
 * @param {"white"|"black"} userColor
 * @returns {number|null}
 */
function signedForUser(e, userColor) {
  if (e == null) return null;
  return userColor === "white" ? e : -e;
}

/** A position is recoverable if its pre-move eval (user's POV) is not deep loss. */
function isPositionRecoverable(node, userColor) {
  const parent = node.parent;
  if (!parent || parent.eval == null) return true;
  return signedForUser(parent.eval, userColor) > DOOMED_EVAL;
}

/* ==========================================================================
   Missed-mate detection
   ========================================================================== */

/**
 * Checks whether the user missed a forced mate that was available from the
 * parent position.
 *
 * `eval_mate` on a node is the engine's mate-in-N from *white's* POV:
 *   > 0 → white mates in N half-moves
 *   < 0 → black mates in |N| half-moves
 *   null → no forced mate
 *
 * @param {import("./state.js").Node} node  The move the user actually played.
 * @param {"white"|"black"} userColor
 * @returns {{ isMissedMate: boolean, mateIn: number }}
 */
function detectMissedMate(node, userColor) {
  const parent = node.parent;
  if (!parent) return { isMissedMate: false, mateIn: 0 };

  const parentMateUser = signedForUser(parent.eval_mate, userColor);
  if (parentMateUser == null || parentMateUser <= 0) {
    return { isMissedMate: false, mateIn: 0 };
  }

  // The user had a forced mate-in-N. Did they stay on the mating line?
  // Correct play: node.eval_mate should now be mate-in-(N-1) for the user,
  // or the user delivered checkmate (san ends with #).
  const nodeMateUser = signedForUser(node.eval_mate, userColor);
  const deliveredMate = Boolean(node.san?.endsWith("#"));

  if (deliveredMate) return { isMissedMate: false, mateIn: 0 };
  if (nodeMateUser != null && nodeMateUser === parentMateUser - 1) {
    return { isMissedMate: false, mateIn: 0 };
  }

  return { isMissedMate: true, mateIn: parentMateUser };
}

/* ==========================================================================
   ScenarioSpec builders
   ========================================================================== */

/**
 * Builds a ScenarioSpec from a node.
 * The training position is parent.fenAfter (the position before the user's move).
 *
 * Extra fields for mate scenarios:
 *   - `isMateScenario`   : true when the user must find a forced mate.
 *   - `mateForcedDepth`  : total half-moves until checkmate (used by the
 *                          orchestrator to override config.depthK precisely).
 *
 * @param {import("./state.js").Node} node
 * @param {"user-error"|"opp-error"|"brilliant"|"missed-mate"} kind
 * @param {number} [mateIn=0]  Mate-in-N (user's POV). 0 means not a mate scenario.
 * @returns {ScenarioSpec}
 */
function toScenario(node, kind, mateIn = 0) {
  const parent = node.parent;
  return {
    fen: parent ? parent.fenAfter : node.fenBefore,
    contextSan: node.san,
    reason: describe(node, kind, mateIn),
    cpLoss: node.cpLoss || 0,
    ply: node.ply,
    note: kindNote(kind, mateIn),
    precedingMoves: getPastMoves(node),
    // Mate-specific: orchestrator reads these to lock depthK and tighten
    // move acceptance (only the exact mating line is acceptable).
    isMateScenario: mateIn > 0,
    // Total half-moves until checkmate: the user makes ⌈N/2⌉ moves and the
    // engine replies ⌊N/2⌋ times (for mate-in-N measured in user moves).
    // We store N * 2 - 1 because the last move is always the user's (mate).
    mateForcedDepth: mateIn > 0 ? mateIn * 2 - 1 : null,
  };
}

function describe(node, kind, mateIn = 0) {
  if (kind === "missed-mate") return `Missed Mate in ${mateIn} — find it`;
  const label = node.evalData?.label || "Move";
  const cp    = node.cpLoss ? ` (-${(node.cpLoss / 100).toFixed(1)})` : "";
  if (kind === "user-error") return `Your ${label}${cp} — replay correctly`;
  if (kind === "opp-error")  return `Opponent ${label}${cp} — capitalize`;
  if (kind === "brilliant")  return `Your Brilliant ${node.san} — replay`;
  return label;
}

function kindNote(kind, mateIn = 0) {
  if (kind === "missed-mate") {
    return `There was a forced Mate in ${mateIn}. Find every move of the mating line — no deviations allowed.`;
  }
  switch (kind) {
    case "user-error": return "Find the engine's preferred move at this position.";
    case "opp-error":  return "Opponent erred here; you must punish with the top move.";
    case "brilliant":  return "Replay the brilliancy from this position.";
    default:           return "";
  }
}

/* ==========================================================================
   Public pickers
   ========================================================================== */

/**
 * Picks the user's worst moves on the main line.
 *
 * Missed mates are always included and sorted first (shortest mate-in-N
 * first). Regular errors follow, sorted by cpLoss descending.
 *
 * @param {{ userColor: "white"|"black", max: number }} opts
 * @returns {ScenarioSpec[]}
 */
export function pickWorstErrors({ userColor, max }) {
  const userParity = userColor === "white" ? 1 : 0;
  const nodes = mainLineNodes().filter((n) => n.ply % 2 === userParity);

  // 1. Missed mates — highest priority, sorted shortest mate first
  const missedMateResults = nodes.map((n) => ({ n, ...detectMissedMate(n, userColor) }));
  const missedMateSpecs = missedMateResults
    .filter(({ isMissedMate }) => isMissedMate)
    .sort((a, b) => a.mateIn - b.mateIn)
    .map(({ n, mateIn }) => toScenario(n, "missed-mate", mateIn));

  const missedMateNodeIds = new Set(
    missedMateResults.filter(({ isMissedMate }) => isMissedMate).map(({ n }) => n.id)
  );

  // 2. Regular errors — skip nodes already listed as missed mates
  const errorSpecs = nodes
    .filter((n) => !missedMateNodeIds.has(n.id))
    .filter((n) => (n.cpLoss ?? 0) >= ERROR_CP_THRESHOLD)
    .filter((n) => isPositionRecoverable(n, userColor))
    .sort((a, b) => (b.cpLoss || 0) - (a.cpLoss || 0))
    .map((n) => toScenario(n, "user-error"));

  return [...missedMateSpecs, ...errorSpecs].slice(0, max);
}

/**
 * Picks positions where the *opponent* erred. Used by WHAT-IF mode.
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
 * Picks the user's brilliant moves.
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
 * for RESILIENCE mode.
 * @param {{ userColor: "white"|"black", max: number }} opts
 * @returns {ScenarioSpec[]}
 */
export function pickResiliencePositions({ userColor, max }) {
  const userParity = userColor === "white" ? 1 : 0;
  const candidates = mainLineNodes()
    .filter((n) => n.ply % 2 === userParity)
    .map((n) => n.parent)
    .filter((p) => p && p.eval != null)
    .filter((p) => {
      const e = signedForUser(p.eval, userColor);
      return e > RESILIENCE_RANGE.min && e < RESILIENCE_RANGE.max;
    });

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
      precedingMoves: [],
      isMateScenario: false,
      mateForcedDepth: null,
    }));
}

/** @typedef {import("./training-session.js").ScenarioSpec} ScenarioSpec */
