/**
 * @fileoverview Engine-driven analysis layer.
 *
 * Responsibilities:
 *   - Querying `/api/analyze` for the current FEN and rendering the result:
 *       * eval bar + numeric eval
 *       * top engine moves (`#topMoves`) and best alternatives to the move
 *         actually played (`#altMoves`)
 *       * move classification card (Brilliant / Good / Blunder / …)
 *       * SVG arrows overlaid on the board for the top moves
 *   - Updating the opening name display when the backend recognizes one.
 */

import { state } from "./state.js";
import { api } from "./api.js";
import { playMoveUci, playAlternativeMove } from "./moves.js";

/**
 * Updates the side-evaluation bar UI.
 *
 * @param {number} score - Engine evaluation in pawns; clamped to ±10 for display.
 */
export function updateEvalBar(score, result = null, mate = null) {
  const evalText = document.getElementById("evalText");
  const evalFill = document.getElementById("evalFill");

  // If game ended
  if (result) {
    evalText.textContent = result;

    if (result === "1-0") evalFill.style.height = "100%";
    else if (result === "0-1") evalFill.style.height = "0%";
    else evalFill.style.height = "50%";

    return;
  }

  // Forced mate lines
  if (mate !== null && mate !== undefined) {
    evalText.textContent = mate > 0
      ? `M${mate}`
      : `-M${Math.abs(mate)}`;

    // Full eval bar for winner
    evalFill.style.height = mate > 0 ? "100%" : "0%";
    return;
  }

  // Normal eval
  if (score === null || score === undefined) {
    evalText.textContent = "–";
    return;
  }

  const clamped = Math.max(-10, Math.min(10, score));
  const pct = ((clamped + 10) / 20) * 100;

  evalFill.style.height = pct + "%";
  evalText.textContent =
    (score >= 0 ? "+" : "") + score.toFixed(1);
}

/**
 * Renders a list of moves into `<ul id={elementId}>` with rank, SAN,
 * evaluation score, and a continuation preview line.
 *
 * @param {Array<Object>} moves - Engine move objects: { san, uci, score, continuation, from, to }.
 * @param {string} elementId - DOM id of the target `<ul>`.
 * @param {boolean} [isAlternative=false] - True for the "best alternatives"
 *   list (clicking creates a deviation), false for the "next best moves" list
 *   (clicking plays the move forward).
 */
export function renderMovesList(moves, elementId, isAlternative = false) {
  const ul = document.getElementById(elementId);
  ul.innerHTML = "";

  if (!moves || moves.length === 0) {
    ul.innerHTML = `<li style="color:#888; font-style:italic; pointer-events: none;">N/A ${
      isAlternative ? "(Starting Pos)" : ""
    }</li>`;
    return;
  }

  moves.forEach((m, i) => {
    const li = document.createElement("li");
    let scoreText;

    if (m.mate !== null && m.mate !== undefined) {
      scoreText = m.mate > 0
        ? `M${m.mate}`
        : `-M${Math.abs(m.mate)}`;
    } else if (m.score !== null && m.score !== undefined) {
      scoreText = `${m.score >= 0 ? "+" : ""}${m.score.toFixed(2)}`;
    } else {
      scoreText = "–"; // fallback
    }

    const mainRow = document.createElement("div");
    mainRow.className = "move-row-main";
    mainRow.innerHTML = `
      <span>
        <span class="rank">${i + 1}.</span>
        <span class="san">${m.san}</span>
      </span>
      <span class="score">${scoreText}</span>
    `;

    const continuationRow = document.createElement("div");
    continuationRow.className = "continuation-text";
    continuationRow.textContent = m.continuation;

    li.appendChild(mainRow);
    li.appendChild(continuationRow);

    if (!isAlternative) {
      li.onclick = () => playMoveUci(m.uci);
    } else {
      li.onclick = () => playAlternativeMove(m.uci);
      li.title = "Click to play this alternative and create a variation";
      li.style.cursor = "pointer";
    }

    ul.appendChild(li);
  });
}

/**
 * Renders the move-classification card (symbol, label, accent color).
 *
 * @param {Object|null} c - Classification object with `symbol`, `label`, `color`.
 */
export function renderClassification(c) {
  const card = document.getElementById("classificationCard");
  const sym = document.getElementById("classSymbol");
  const lab = document.getElementById("classLabel");

  if (!c || c.error) {
    sym.textContent = "–";
    lab.textContent = "Waiting";
    card.style.borderColor = "#333";
    sym.style.color = "#888";
    return;
  }

  sym.textContent = c.symbol;
  lab.textContent = c.label;
  sym.style.color = c.color;
  card.style.borderColor = c.color;
}

/**
 * Draws SVG arrows for the engine's top moves, overlaid on the board.
 *
 * The arrows are appended into `#board` and removed at the start of every
 * call, so callers can pass `[]` to clear all arrows.
 *
 * @param {Array<{from: string, to: string}>} moves - Up to three engine moves.
 */
export function renderArrows(moves) {
  document.querySelectorAll(".move-arrow").forEach((e) => e.remove());
  if (!moves || !moves.length) return;

  const boardEl = document.getElementById("board");
  const rect = boardEl.getBoundingClientRect();
  const sqSize = rect.width / 8;
  const orient = state.board.orientation();
  const svgNS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(svgNS, "svg");
  svg.classList.add("move-arrow");
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.pointerEvents = "none";

  const colors = ["#0C6499", "#1399EC", "#8AD2FF"];

  moves.forEach((m, i) => {
    const [fx, fy] = sqToXY(m.from, sqSize, orient);
    const [tx, ty] = sqToXY(m.to, sqSize, orient);

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", fx);
    line.setAttribute("y1", fy);
    line.setAttribute("x2", tx);
    line.setAttribute("y2", ty);
    line.setAttribute("stroke", colors[i] || "#888");
    line.setAttribute("stroke-width", 7);
    line.setAttribute("opacity", 0.8);
    line.setAttribute("marker-end", `url(#arrow${i})`);

    const defs = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", `arrow${i}`);
    marker.setAttribute("markerWidth", "3");
    marker.setAttribute("markerHeight", "3");
    marker.setAttribute("refX", "2");
    marker.setAttribute("refY", "1.5");
    marker.setAttribute("orient", "auto");

    const tri = document.createElementNS(svgNS, "polygon");
    tri.setAttribute("points", "0,0 3,1.5 0,3");
    tri.setAttribute("fill", colors[i] || "#888");
    marker.appendChild(tri);
    defs.appendChild(marker);
    svg.appendChild(defs);
    svg.appendChild(line);
  });

  boardEl.style.position = "relative";
  boardEl.appendChild(svg);
}

/**
 * Converts an algebraic square (e.g. "e4") to pixel coordinates relative
 * to the SVG overlay, taking board orientation into account.
 *
 * @param {string} sq - Algebraic square.
 * @param {number} sqSize - Square side length in pixels.
 * @param {string} orient - "white" or "black".
 * @returns {[number, number]} [x, y] center coordinates.
 */
function sqToXY(sq, sqSize, orient) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  if (orient === "white") {
    return [file * sqSize + sqSize / 2, (7 - rank) * sqSize + sqSize / 2];
  }
  return [(7 - file) * sqSize + sqSize / 2, rank * sqSize + sqSize / 2];
}

/**
 * Asks the backend for a full analysis and updates the UI.
 * Now includes filtering logic to hide moves that are significantly worse 
 * than the top engine choice.
 */
export async function analyzeCurrentPosition(
  prev_fen = null,
  last_move_uci = null
) {
  const depth = parseInt(document.getElementById("depth").value, 10) || 14;
  const topMovesEl = document.getElementById("topMoves");
  const openingEl = document.getElementById("openingName");

  /**
   * SCORE_THRESHOLD (Delta):
   * If a move is more than 1.0 pawns worse than the best move, it is hidden.
   * This prevents showing blunders as "suggested" alternatives.
   */
  const SCORE_THRESHOLD = 1.0;

  if (topMovesEl)
    topMovesEl.innerHTML = "<li style='color:#888;'>Analyzing…</li>";
  
  renderArrows([]);
  renderClassification(null);

  try {
    const data = await api("/api/analyze", {
      fen: state.game_fen,
      depth,
      prev_fen,
      last_move_uci,
    });

    /**
     * Helper: filterMoves
     * Filters an array of moves by comparing their scores to the best move (index 0).
     */
    const filterMoves = (moves) => {
      if (!moves || moves.length === 0) return [];
    
      const best = moves[0];
    
      return moves.filter((move, index) => {
        if (index === 0) return true;
    
        // If any is mate keep only mate
        if (best.mate !== null || move.mate !== null) {
          return move.mate !== null;
        }
    
        // Safety
        if (best.score == null || move.score == null) return false;
    
        const delta = Math.abs(best.score - move.score);
        return delta <= SCORE_THRESHOLD;
      });
    };

    // Filter both Top Moves and Alternative Moves
    const filteredTopMoves = filterMoves(data.top_moves);
    const filteredAltMoves = filterMoves(data.alternative_moves);

    // Update state and UI with filtered data
    state.topMovesCache = filteredTopMoves;
    updateEvalBar(data.eval, data.result, data.eval_mate);
    
    // Render only the moves that passed the filter
    renderMovesList(filteredTopMoves, "topMoves", false);
    renderMovesList(filteredAltMoves, "altMoves", true);
    
    renderClassification(data.classification);
    
    // Arrows on the board will now strictly match the filtered list
    renderArrows(filteredTopMoves);

    // --- Opening & Player UI Logic ---
    if (data.opening && data.opening !== "Custom Position" && data.opening !== "Starting Position") {
      state.currentOpeningName = data.opening;
    }

    let displayName = "Custom Position";
    if (state.currentOpeningName !== "Starting Position" && state.currentOpeningName !== "Custom Position") {
      displayName = state.currentOpeningName;
    }

    if (state.game_fen === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1") {
      displayName = "Starting Position";
    }

    if (openingEl) {
      const white = state.whitePlayer;
      const black = state.blackPlayer;
      let prefix = (white && black) ? `⚪ ${white} vs ⚫ ${black} — ` : "";
      openingEl.textContent = prefix + displayName;
    }

  } catch (e) {
    console.error("Error during analysis:", e);
    if (topMovesEl) {
      topMovesEl.innerHTML = `<li style='color:#e6912c;'>Error: ${e.message}</li>`;
    }
  }
}
