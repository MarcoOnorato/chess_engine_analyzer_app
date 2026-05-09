/**
 * @fileoverview Training session state — pure data, no DOM.
 *
 * A "session" is one training run from the moment the user opens the
 * training modal until they click "Return to main game". It walks through
 * a series of phases:
 *
 *   MODE_SELECT  → user picks Error / What-If / Resilience
 *   CONFIG       → user picks color, depth K, count of positions, deep mode
 *   POSITION_LIST→ session has been prepared; user sees the picked positions
 *                  and clicks Start (or skip directly into PLAYING)
 *   PLAYING      → user is on the training board, attempting a position
 *   RESULTS      → all positions consumed; show summary
 *
 * Per-position state (reset between positions): `attempts`, `hintLevel`,
 * `movesPlayed`, `chess`, `fen`, `expectedMoves`, `evalDeltaTrack`.
 *
 * Per-session state (kept across positions): `score`, `config`, `positions`.
 *
 * The session never mutates the main-app state in `state.js`. The only
 * cross-talk is *reading* from the analyzed game tree to pick positions.
 */

/** Phases of the training flow. */
export const PHASES = Object.freeze({
  MODE_SELECT: "mode_select",
  CONFIG: "config",
  POSITION_LIST: "position_list",
  PLAYING: "playing",
  RESULTS: "results",
});

/** Available training modes. */
export const MODES = Object.freeze({
  ERROR: "error",
  WHAT_IF: "what_if",
  RESILIENCE: "resilience",
});

/** Default configuration applied on session creation. */
const DEFAULT_CONFIG = Object.freeze({
  /** How many half-moves the simulation continues after each scenario starts. */
  depthK: 6,
  /** How many training scenarios to generate. */
  maxPositions: 5,
  /**
   * Deep mode: opponent replies are picked uniformly among engine top moves
   * within a tolerance (instead of always playing top-1). Forces the user
   * to handle slightly different replies on retries.
   */
  deepMode: false,
  /**
   * acceptTopN: how many of the top engine moves count as "correct".
   * 1 means only the very best move. 2 means top 1 or 2 are accepted.
   */
  acceptTopN: 3,
  /** Tolerance (centipawns) below top move that still counts as correct. */
  cpTolerance: 30,
});

/**
 * Builds a fresh, blank session. The caller is responsible for filling in
 * the picked `positions` after the user chooses mode + color.
 *
 * @returns {Session}
 */
export function createSession() {
  return {
    phase: PHASES.MODE_SELECT,
    mode: null,
    userColor: "white",
    config: { ...DEFAULT_CONFIG },

    /** @type {ScenarioSpec[]} Filled in by the mode-specific selector. */
    positions: [],
    currentPositionIdx: 0,

    // Per-position state (reset by `enterScenario`).
    movesPlayed: 0,
    attempts: 0,
    hintLevel: 0,
    chess: null,
    fen: null,
    /** Top-engine SAN list at the current step. */
    expectedTopMoves: [],
    /** Eval (signed for user) at the start of current scenario, used as baseline. */
    baselineEval: null,
    /** Eval at end of K moves — written when scenario finishes. */
    finalEval: null,

    // Cumulative session stats.
    score: {
      scenariosCompleted: 0,
      correctFirstTry: 0,
      correctWithHints: 0,
      failed: 0,
      hintsUsed: 0,
    },
  };
}

/**
 * Resets per-position counters when starting a new scenario.
 * @param {Session} session
 */
export function resetPositionState(session) {
  session.movesPlayed = 0;
  session.attempts = 0;
  session.hintLevel = 0;
  session.expectedTopMoves = [];
  session.baselineEval = null;
  session.finalEval = null;
}

/**
 * Returns whether more scenarios remain after the current one.
 * @param {Session} session
 */
export function hasMoreScenarios(session) {
  return session.currentPositionIdx + 1 < session.positions.length;
}

/**
 * @typedef {Object} ScenarioSpec
 * @property {string} fen          FEN where the scenario begins (user to move).
 * @property {string} contextSan   SAN of the move played in the original game
 *                                  *from* this position (for display).
 * @property {string} reason       Human-readable label: "Blunder (-2.4)" etc.
 * @property {number} cpLoss       Centipawn loss of the original move (if any).
 * @property {number} ply          Original ply in the main line.
 * @property {string=} note        Optional extra note for the UI.
 *
 * @typedef {ReturnType<typeof createSession>} Session
 */
