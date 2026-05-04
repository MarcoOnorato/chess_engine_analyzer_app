/**
 * @fileoverview Move execution and the rules around the main-line / deviation
 * branching state machine.
 *
 * `playMoveUci`        : programmatically plays a move from the engine's
 *                       suggestions (top moves panel).
 * `playAlternativeMove`: rewinds one ply, then plays a move — used when the
 *                       user picks a "Best Alternative" to the last move.
 * `pushMove`           : the central commit point. Decides whether the new
 *                       move continues the main line or starts / extends a
 *                       deviation, then triggers a follow-up classification.
 * `revertOneStep`      : pure state mutation — undoes the most recent ply,
 *                       crossing the deviation boundary if needed.
 * `isAtDeviationTip`   : guard used to block dragging the board when the
 *                       cursor is mid-deviation rather than at its tip.
 */

import { state, STARTING_FEN } from "./state.js";
import { api, fenToPos } from "./api.js";
import { renderHistory } from "./history.js";
import { analyzeCurrentPosition, renderArrows } from "./analysis.js";
import { updatePgnNav } from "./navigation.js";

/**
 * Plays a UCI move from the current FEN, appending it to history.
 * No-op if a move is already being processed.
 *
 * @param {string} uci - UCI move string (e.g. "e2e4" or "e7e8q").
 */
export async function playMoveUci(uci) {
  if (state.is_moving) return;
  state.is_moving = true;

  try {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci.length > 4 ? uci[4] : "q";
    const result = await api("/api/legal_moves", {
      fen: state.game_fen,
      from,
      to,
      promotion: promo,
    });
    if (!result.legal) return;
    pushMove(result, state.game_fen);
  } finally {
    state.is_moving = false;
  }
}

/**
 * Rewinds one ply and then plays the provided alternative — i.e. replaces
 * the last move with a different one, creating a deviation if needed.
 *
 * @param {string} uci - UCI of the alternative move to play.
 */
export async function playAlternativeMove(uci) {
  if (state.is_moving) return;

  revertOneStep();

  state.board.position(fenToPos(state.game_fen));
  renderHistory();
  updatePgnNav();

  renderArrows([]);
  document.getElementById("topMoves").innerHTML = "<li>Branching...</li>";
  document.getElementById("altMoves").innerHTML = "<li>Branching...</li>";
  await playMoveUci(uci);
}

/**
 * Reverts the most recent ply in place. Knows how to:
 *   - Pop one move from `historyVariations` and stay in deviation mode.
 *   - Exit deviation mode entirely if the deviation was a single ply.
 *   - Walk back the main-line cursor if not currently in a deviation.
 *
 * Mutates `state` only — the caller is responsible for redrawing.
 */
export function revertOneStep() {
  if (state.in_deviation) {
    const movesToKeep = state.currentVariationIndex - 1;
    state.historyVariations = state.historyVariations.slice(0, movesToKeep);

    if (state.historyVariations.length > 0) {
      const last = state.historyVariations[state.historyVariations.length - 1];
      state.game_fen = last.fen_after;
      state.currentVariationIndex = state.historyVariations.length;
    } else {
      state.in_deviation = false;
      state.currentVariationIndex = -1;
      state.currentMainlineIndex = state.deviationStartIndex;
      state.pgn_index = state.deviationStartIndex;
      state.game_fen =
        state.deviationStartIndex > 0
          ? state.historyMain[state.deviationStartIndex - 1].fen_after
          : state.pgn_fens.length > 0
          ? state.pgn_fens[0]
          : STARTING_FEN;
    }
  } else {
    if (state.pgn_index > 0) {
      state.pgn_index--;
      state.currentMainlineIndex = state.pgn_index;
      state.game_fen = state.pgn_fens[state.pgn_index];
    }
  }
}

/**
 * Commits a legality-checked move into the state machine and triggers a
 * follow-up classification request whose result is folded into `evalData`.
 *
 * Branching rules:
 *   - Not in deviation, and the move matches the next PGN move → advance the
 *     main-line cursor.
 *   - Not in deviation, but the move differs → switch to deviation mode and
 *     start a new variation.
 *   - Already in deviation → simply append to the variation.
 *
 * @param {Object} legalResult - Payload from `/api/legal_moves`.
 * @param {string} fen_before - FEN immediately before the move.
 */
export function pushMove(legalResult, fen_before) {
  const moveObj = {
    san: legalResult.san,
    uci: legalResult.uci,
    fen_before,
    fen_after: legalResult.new_fen,
    evalData: null,
  };

  if (!state.in_deviation) {
    if (
      state.pgn_moves.length > 0 &&
      state.pgn_index < state.pgn_moves.length &&
      state.pgn_moves[state.pgn_index].uci === legalResult.uci
    ) {
      state.currentMainlineIndex++;
      state.pgn_index++;
    } else {
      state.in_deviation = true;
      state.deviationStartIndex = state.currentMainlineIndex;
      state.historyVariations = [];
      state.currentVariationIndex = 1;
      state.historyVariations.push(moveObj);
    }
  } else {
    state.historyVariations.push(moveObj);
    state.currentVariationIndex++;
  }

  state.game_fen = legalResult.new_fen;
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  // After the position-level analysis runs, request a classification for the
  // move just played and fold it back into `moveObj` so history symbols/colors
  // appear next time we render.
  analyzeCurrentPosition(fen_before, legalResult.uci).then(async () => {
    try {
      const analysis = await api("/api/analyze", {
        fen: legalResult.new_fen,
        prev_fen: fen_before,
        last_move_uci: legalResult.uci,
        depth: parseInt(document.getElementById("depth").value, 10) || 14,
      });
      moveObj.evalData = analysis.classification;
      renderHistory();
    } catch (e) {
      console.error("Deviation move classification failed:", e);
    }
  });
}

/**
 * Returns true when the cursor sits at the end of an active deviation.
 * Used to allow dragging only when there is no "future" deviation to overwrite.
 *
 * @returns {boolean}
 */
export function isAtDeviationTip() {
  return (
    state.in_deviation &&
    state.currentVariationIndex === state.historyVariations.length
  );
}
