/**
 * @fileoverview PGN loading pipeline.
 *
 * High-level flow:
 *   1. POST `/api/load_pgn` to convert PGN text into a list of moves and FENs.
 *   2. For each move, POST `/api/analyze` so we get a classification, eval,
 *      and centipawn-loss for the accuracy panel and history symbols.
 *   3. Build `historyMain` from the analyzed moves, position the cursor at
 *      the end of the game, render history, accuracy, and the eval chart.
 *
 * On success, the load panel auto-collapses (via `collapseLoadPanel`).
 */

import { state } from "./state.js";
import { api, fenToPos } from "./api.js";
import { renderHistory } from "./history.js";
import {
  updatePgnNav,
  jumpToMainLineFromChart,
} from "./navigation.js";
import { analyzeCurrentPosition } from "./analysis.js";
import { calculateGameAccuracy, renderEvalChart } from "./accuracy.js";
import { collapseLoadPanel } from "./collapsible.js";

/**
 * Wires the "Load PGN" button to the loading pipeline.
 */
export function bindPgnLoader() {
  document.getElementById("loadPgnBtn").onclick = loadPgn;
}

/**
 * Reads the PGN text area, parses + analyzes the game, and refreshes the UI.
 */
async function loadPgn() {
  const txt = document.getElementById("pgnInput").value.trim();
  if (!txt) return;

  const depth = parseInt(document.getElementById("depth").value, 10) || 14;
  const overlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  overlay.classList.remove("hidden");

  try {
    const data = await api("/api/load_pgn", { pgn: txt });
    state.pgn_moves = data.moves || [];
    state.pgn_fens = data.fens || [];

    // -----------------------------------------------------------------------
    // Analyze every move sequentially. Sequential rather than parallel keeps
    // the engine's load predictable on the backend and lets us update the
    // progress label in order.
    // -----------------------------------------------------------------------
    for (let i = 0; i < state.pgn_moves.length; i++) {
      loadingText.textContent = `Analyzing move ${i + 1} of ${state.pgn_moves.length}...`;

      const analysis = await api("/api/analyze", {
        fen: state.pgn_fens[i + 1],
        prev_fen: state.pgn_fens[i],
        last_move_uci: state.pgn_moves[i].uci,
        depth,
      });

      state.pgn_moves[i].evalData = analysis.classification;
      state.pgn_moves[i].eval = analysis.eval;
      state.pgn_moves[i].cpLoss = Math.max(0, analysis.best_eval_loss || 0);
    }

    // -----------------------------------------------------------------------
    // Build the main-line history array from the analyzed moves.
    // -----------------------------------------------------------------------
    state.historyMain = state.pgn_moves.map((m, i) => ({
      san: m.san,
      uci: m.uci,
      fen_before: state.pgn_fens[i],
      fen_after: state.pgn_fens[i + 1],
      evalData: m.evalData,
      cpLoss: m.cpLoss,
      eval: m.eval,
    }));

    // -----------------------------------------------------------------------
    // Reset deviation state and park the cursor at the end of the game.
    // -----------------------------------------------------------------------
    state.historyVariations = [];
    state.deviationStartIndex = 0;
    state.pgn_index = state.pgn_moves.length;
    state.currentMainlineIndex = state.pgn_moves.length;
    state.currentVariationIndex = -1;
    state.in_deviation = false;
    state.game_fen = state.pgn_fens[state.pgn_moves.length];

    const moveSlider = document.getElementById("moveSlider");
    moveSlider.max = state.pgn_moves.length;
    moveSlider.value = state.pgn_moves.length;

    state.board.position(fenToPos(state.game_fen));

    renderHistory();
    updatePgnNav();
    calculateGameAccuracy();
    renderEvalChart(jumpToMainLineFromChart);

    overlay.classList.add("hidden");

    // Final position analysis so the side panels reflect the end state.
    analyzeCurrentPosition(
      state.pgn_moves.length > 0 ? state.pgn_fens[state.pgn_moves.length - 1] : null,
      state.pgn_moves.length > 0
        ? state.pgn_moves[state.pgn_moves.length - 1].uci
        : null
    );

    // Successful load → tuck the import controls away to give the board room.
    collapseLoadPanel();
  } catch (e) {
    overlay.classList.add("hidden");
    alert("Error loading PGN");
    console.error(e);
  }
}
