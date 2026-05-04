/**
 * @fileoverview Game navigation: slider, prev/next, flip, reset, undo, and
 * the chart click-to-jump handler.
 *
 * `updatePgnNav` is the canonical place to refresh the PGN cursor labels and
 * the slider's bounds — it's called from any module that mutates the cursor.
 */

import { state, STARTING_FEN } from "./state.js";
import { fenToPos } from "./api.js";
import { renderHistory } from "./history.js";
import { analyzeCurrentPosition } from "./analysis.js";

/** Cached reference to the move slider. Initialized in `bindNavigation`. */
let moveSlider = null;

/**
 * Refreshes the slider bounds, position label, and prev/next button states
 * to match the current cursor. Also re-renders the eval chart's highlight.
 */
export function updatePgnNav() {
  const total = state.pgn_moves.length;
  const pos = document.getElementById("pgnPos");
  const sliderMaxLabel = document.getElementById("sliderMax");

  if (moveSlider) {
    moveSlider.max = total;
    moveSlider.value = state.pgn_index;
  }
  sliderMaxLabel.textContent = total;

  if (total === 0) {
    pos.textContent = "0 / 0";
    document.getElementById("pgnPrev").disabled = true;
    document.getElementById("pgnNext").disabled = true;
    return;
  }

  pos.textContent =
    `${state.pgn_index} / ${total}` + (state.in_deviation ? " (var)" : "");
  document.getElementById("pgnPrev").disabled = false;
  document.getElementById("pgnNext").disabled = false;

  if (state.evalChart) state.evalChart.update();
}

/**
 * Forces a return from any deviation to a specific point on the main line.
 * Used by both the chart click handler and the eval-chart factory.
 *
 * @param {number} index - 0-based ply index in the main line.
 */
export function jumpToMainLineFromChart(index) {
  // Reset deviation state.
  state.historyVariations = [];
  state.deviationStartIndex = 0;
  state.in_deviation = false;
  state.currentVariationIndex = -1;

  // Move main-line cursor to the target.
  state.currentMainlineIndex = index + 1;
  state.pgn_index = index + 1;
  state.game_fen = state.historyMain[index].fen_after;

  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  const prev_fen = state.historyMain[index].fen_before;
  const last_move_uci = state.historyMain[index].uci;
  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Steps the cursor one move forward along the main PGN line.
 */
function nextMove() {
  if (state.pgn_index >= state.pgn_moves.length) return;

  state.pgn_index++;
  state.currentMainlineIndex = state.pgn_index;
  state.in_deviation = false;
  state.historyVariations = [];
  state.currentVariationIndex = -1;

  state.game_fen = state.pgn_fens[state.pgn_index];
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  const prev_fen = state.pgn_index > 0 ? state.pgn_fens[state.pgn_index - 1] : null;
  const last_move_uci =
    state.pgn_index > 0 ? state.pgn_moves[state.pgn_index - 1].uci : null;
  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Steps the cursor one move backward along the main PGN line.
 */
function prevMove() {
  if (state.pgn_index <= 0) return;

  state.pgn_index--;
  state.currentMainlineIndex = state.pgn_index;
  state.in_deviation = false;
  state.historyVariations = [];
  state.currentVariationIndex = -1;

  state.game_fen = state.pgn_fens[state.pgn_index];
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  const prev_fen = state.pgn_index > 0 ? state.pgn_fens[state.pgn_index - 1] : null;
  const last_move_uci =
    state.pgn_index > 0 ? state.pgn_moves[state.pgn_index - 1].uci : null;
  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Resets the entire application state to the starting position and clears
 * any loaded PGN.
 */
function resetAll() {
  state.game_fen = STARTING_FEN;
  state.historyMain = [];
  state.historyVariations = [];
  state.pgn_index = 0;
  state.in_deviation = false;
  state.pgn_moves = [];
  state.pgn_fens = [];
  state.board.position("start");
  document.getElementById("pgnInput").value = "";
  renderHistory();
  updatePgnNav();
  analyzeCurrentPosition();
}

/**
 * Pops the most recent move off the deviation stack and re-syncs the board.
 * If the deviation becomes empty, resumes the main line at the deviation
 * start point.
 */
function undoLastDeviationMove() {
  if (state.historyVariations.length === 0) return;

  state.historyVariations.pop();

  if (state.historyVariations.length > 0) {
    const last = state.historyVariations[state.historyVariations.length - 1];
    state.game_fen = last.fen_after;
    state.currentVariationIndex = state.historyVariations.length;
    state.in_deviation = true;
  } else {
    state.in_deviation = false;
    state.currentVariationIndex = -1;
    state.currentMainlineIndex = state.deviationStartIndex;
    state.pgn_index = state.deviationStartIndex;
    state.game_fen =
      state.deviationStartIndex > 0
        ? state.historyMain[state.deviationStartIndex - 1].fen_after
        : state.pgn_fens[0];
  }

  state.board.position(fenToPos(state.game_fen));
  renderHistory();
  updatePgnNav();

  let prev_fen = null;
  let last_move_uci = null;

  if (state.historyVariations.length > 0) {
    const last = state.historyVariations[state.historyVariations.length - 1];
    prev_fen = last.fen_before;
    last_move_uci = last.uci;
  } else if (
    state.in_deviation === false &&
    state.currentMainlineIndex > 0
  ) {
    prev_fen = state.historyMain[state.currentMainlineIndex - 1].fen_before;
    last_move_uci = state.historyMain[state.currentMainlineIndex - 1].uci;
  }

  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Wires up every navigation control to its handler. Must be called once
 * after the DOM is ready.
 */
export function bindNavigation() {
  moveSlider = document.getElementById("moveSlider");

  document.getElementById("pgnNext").onclick = nextMove;
  document.getElementById("pgnPrev").onclick = prevMove;
  document.getElementById("resetBtn").onclick = resetAll;
  document.getElementById("flipBtn").onclick = () => state.board.flip();
  document.getElementById("undoBtn").onclick = undoLastDeviationMove;

  // Slider: scrub silently while dragging, run analysis once on release.
  moveSlider.addEventListener("input", function () {
    const targetIndex = parseInt(this.value);
    if (state.pgn_moves.length > 0 && state.pgn_fens.length > targetIndex) {
      state.pgn_index = targetIndex;
      state.currentMainlineIndex = targetIndex;
      state.in_deviation = false;
      state.historyVariations = [];
      state.currentVariationIndex = -1;
      state.game_fen = state.pgn_fens[targetIndex];
      state.board.position(fenToPos(state.game_fen), false);

      renderHistory();
      updatePgnNav();

      document.getElementById("topMoves").innerHTML =
        "<li style='color:#888;'>Sliding...</li>";
      // No need for renderArrows([]) here — analysis on release will redraw.
    }
  });

  moveSlider.addEventListener("change", function () {
    let prev_fen = null;
    let last_move_uci = null;
    if (state.pgn_index > 0) {
      prev_fen = state.pgn_fens[state.pgn_index - 1];
      last_move_uci = state.pgn_moves[state.pgn_index - 1].uci;
    }
    analyzeCurrentPosition(prev_fen, last_move_uci);
  });
}
