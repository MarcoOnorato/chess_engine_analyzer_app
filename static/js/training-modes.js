/**
 * @fileoverview Per-mode logic for the training session.
 *
 * Each mode is a small object with the same shape:
 *
 *   {
 *     id, label, description,
 *     pickPositions(opts) → ScenarioSpec[],
 *     onScenarioStart(session, ctx) → Promise<void>,
 *     evaluateOutcome(session) → { headline, detail }
 *   }
 *
 * Why polymorphic objects rather than `if (mode === "error")` everywhere?
 * Because the differences are small but real, and grouping them together
 * keeps each mode readable in isolation and easy to extend without
 * rewriting the orchestrator.
 *
 *   ERROR_MODE     : user replays their own mistakes.
 *   WHAT_IF_MODE   : user faces the alternate timeline where the opponent
 *                    had played the engine's top move instead of their
 *                    actual mistake; user must respond correctly.
 *   RESILIENCE_MODE: user starts already worse; goal is to "hold" — final
 *                    eval shouldn't drop more than a tolerance below the
 *                    baseline.
 */

import {
  pickWorstErrors,
  pickOpponentMistakes,
  pickResiliencePositions,
} from "./training-selectors.js";
import {
  fetchEngineMoves,
  pickOpponentReply,
  playOpponentMove,
} from "./training-board.js";
import { MODES } from "./training-session.js";

/**
 * Tolerance in pawns: scenario is "successful" if the eval drop from
 * baseline → final is no worse than this many pawns.
 */
const SUCCESS_TOLERANCE_PAWNS = 0.5;

/* ==========================================================================
   ERROR mode
   ========================================================================== */

const ERROR_MODE = {
  id: MODES.ERROR,
  label: "Error Training",
  description:
    "Replay positions where you erred. Find the engine's preferred move " +
    "before continuing the line.",

  pickPositions(opts) {
    return pickWorstErrors(opts);
  },

  /**
   * No pre-action needed: the scenario starts at the FEN already, with
   * the user to move.
   */
  async onScenarioStart() {
    /* no-op */
  },

  evaluateOutcome(session) {
    return defaultOutcome(session, "Find the right move and play on");
  },
};

/* ==========================================================================
   WHAT-IF mode
   ========================================================================== */

const WHAT_IF_MODE = {
  id: MODES.WHAT_IF,
  label: "What-If Tree",
  description:
    "Alternate timeline: the opponent plays the engine's top move " +
    "instead of their actual mistake. Continue the line correctly.",

  pickPositions(opts) {
    return pickOpponentMistakes(opts);
  },

  /**
   * Before handing control to the user, simulate the *engine's* top
   * move for the opponent — the "what if they had played correctly"
   * replacement. After this, it's the user's turn.
   */
  async onScenarioStart(session, ctx) {
    const engineData = await fetchEngineMoves(session.fen);
    const reply = pickOpponentReply(engineData.top_moves, session.config);
    if (!reply) return;
    playOpponentMove(ctx.boardCtx, reply);
    session.fen = ctx.boardCtx.chess.fen();
  },

  evaluateOutcome(session) {
    return defaultOutcome(session, "Capitalize on the corrected line");
  },
};

/* ==========================================================================
   RESILIENCE mode
   ========================================================================== */

const RESILIENCE_MODE = {
  id: MODES.RESILIENCE,
  label: "Resilience Mode",
  description:
    "You're already worse. The goal isn't to win — it's to hold. " +
    "Play the engine's top moves and minimize further damage.",

  pickPositions(opts) {
    return pickResiliencePositions(opts);
  },

  async onScenarioStart() {
    /* user is already to move at the chosen FEN */
  },

  evaluateOutcome(session) {
    const drop =
      session.baselineEval != null && session.finalEval != null
        ? session.baselineEval - session.finalEval
        : null;

    if (drop == null) {
      return { headline: "Scenario complete", detail: "" };
    }
    if (drop <= SUCCESS_TOLERANCE_PAWNS) {
      return {
        headline: "Held the position 🛡️",
        detail: `Eval drift: ${drop >= 0 ? "+" : ""}${drop.toFixed(2)} pawns`,
      };
    }
    return {
      headline: "Position deteriorated",
      detail: `Eval dropped by ${drop.toFixed(2)} pawns past tolerance`,
    };
  },
};

/* ==========================================================================
   Public registry
   ========================================================================== */

/**
 * Map mode-id → mode object.
 * @type {Record<string, ModeHandler>}
 */
export const MODE_HANDLERS = {
  [MODES.ERROR]: ERROR_MODE,
  [MODES.WHAT_IF]: WHAT_IF_MODE,
  [MODES.RESILIENCE]: RESILIENCE_MODE,
};

/**
 * Returns the registered handler for a mode id.
 * Throws on unknown ids — callers shouldn't reach this with bad input.
 *
 * @param {string} id
 * @returns {ModeHandler}
 */
export function getModeHandler(id) {
  const h = MODE_HANDLERS[id];
  if (!h) throw new Error(`Unknown training mode: ${id}`);
  return h;
}

/* ==========================================================================
   Helpers
   ========================================================================== */

/**
 * Default scenario outcome: success if user found correct moves on at
 * least 70% of attempts, plus headline based on final eval delta.
 *
 * @param {import("./training-session.js").Session} session
 * @param {string} fallback
 */
function defaultOutcome(session, fallback) {
  const drop =
    session.baselineEval != null && session.finalEval != null
      ? session.baselineEval - session.finalEval
      : 0;
  if (drop <= SUCCESS_TOLERANCE_PAWNS) {
    return {
      headline: "Scenario solved ✅",
      detail: `Eval drift: ${drop >= 0 ? "+" : ""}${(-drop).toFixed(2)} pawns`,
    };
  }
  return {
    headline: "Could be improved",
    detail: fallback + ` — eval dropped ${drop.toFixed(2)} pawns`,
  };
}

/**
 * @typedef {Object} ModeHandler
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {(opts:{userColor:string,max:number}) => any[]} pickPositions
 * @property {(session:any, ctx:any) => Promise<void>} onScenarioStart
 * @property {(session:any) => {headline:string,detail:string}} evaluateOutcome
 */
