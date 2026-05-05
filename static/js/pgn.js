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
 * Wires the PGN loading modal and buttons to the pipeline.
 */
export function bindPgnLoader() {
  const modal = document.getElementById("pgnModal");
  const openModalBtn = document.getElementById("openPgnModalBtn");
  const closeModalBtn = document.getElementById("closePgnModalBtn");
  const submitPgnBtn = document.getElementById("submitPgnBtn");
  const pgnInput = document.getElementById("pgnInput");

  window.loadAndAnalyze = async (pgnString) => {
    const success = await loadPgn(pgnString);
    if (success) {
      modal.style.display = "none";
      pgnInput.value = "";
    }
  };

  openModalBtn.onclick = () => { modal.style.display = "flex"; pgnInput.focus(); };
  closeModalBtn.onclick = () => { modal.style.display = "none"; };

  submitPgnBtn.onclick = () => window.loadAndAnalyze();

  pgnInput.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.loadAndAnalyze();
    }
  };
}

/**
 * Reads the PGN text area, parses + analyzes the game, and refreshes the UI.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
/**
 * Loads and analyzes the PGN.
 */
/**
 * Loads and analyzes the PGN.
 */
/**
 * Loads and analyzes the PGN.
 */
export async function loadPgn(directPgn = null) {
  const txt = directPgn ? directPgn.trim() : document.getElementById("pgnInput").value.trim();
  if (!txt) return false;

  // --- Player names ---
  const whiteMatch = txt.match(/\[White\s+"([^"]+)"\]/);
  const blackMatch = txt.match(/\[Black\s+"([^"]+)"\]/);

  state.whitePlayer = (whiteMatch && whiteMatch[1] !== "?") ? whiteMatch[1] : "";
  state.blackPlayer = (blackMatch && blackMatch[1] !== "?") ? blackMatch[1] : "";

  // Always reset
  state.playersPrefix = "";

  // Update name only if both players exist
  if (state.whitePlayer && state.blackPlayer) {
    state.playersPrefix = `⚪ ${state.whitePlayer} vs ⚫ ${state.blackPlayer} — `;
  }

  state.currentOpeningName = "Starting Position";
  // -----------------------------

  const depth = parseInt(document.getElementById("depth").value, 10) || 11;
  const overlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  
  overlay.classList.remove("hidden");

  try {
    const data = await api("/api/load_pgn", { pgn: txt });
    state.pgn_moves = data.moves || [];
    state.pgn_fens = data.fens || [];
  
    // Analysis
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

      // Update opening's name only if a real one is found
      if (analysis.opening && analysis.opening !== "Custom Position" && analysis.opening !== "Starting Position") {
        state.currentOpeningName = analysis.opening;
      }
    }

    state.historyMain = state.pgn_moves.map((m, i) => ({
      san: m.san,
      uci: m.uci,
      fen_before: state.pgn_fens[i],
      fen_after: state.pgn_fens[i + 1],
      evalData: m.evalData,
      cpLoss: m.cpLoss,
      eval: m.eval,
    }));

    state.pgn_index = state.pgn_moves.length;
    state.game_fen = state.pgn_fens[state.pgn_moves.length];
    
    const moveSlider = document.getElementById("moveSlider");
    moveSlider.max = state.pgn_moves.length;
    moveSlider.value = state.pgn_moves.length;
    document.getElementById("sliderMax").textContent = state.pgn_moves.length;

    state.board.position(fenToPos(state.game_fen));

    let prev_fen = null;
    let last_move_uci = null;
      if (state.pgn_index > 0) {
        prev_fen = state.pgn_fens[state.pgn_index - 1];
        last_move_uci = state.pgn_moves[state.pgn_index - 1].uci;
        state.currentMainlineIndex = state.pgn_index;
      }
    renderHistory();
    updatePgnNav();
    calculateGameAccuracy();
    renderEvalChart(jumpToMainLineFromChart);
    analyzeCurrentPosition(prev_fen, last_move_uci);

    // Update opening name after loading
    const displayEl = document.getElementById("openingName");
    let finalDisplay = (state.currentOpeningName === "Starting Position" || state.currentOpeningName === "Custom Position") 
                       ? "Custom Position" 
                       : state.currentOpeningName;
    if (displayEl) displayEl.textContent = state.playersPrefix + finalDisplay;

    overlay.classList.add("hidden");
    collapseLoadPanel();
    
    return true; 
  } catch (e) {
    overlay.classList.add("hidden");
    alert("Error loading PGN");
    console.error(e);
    return false;
  }
}
