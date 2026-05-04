/**
 * @fileoverview Move-history rendering for both the main line and any
 * deviation (variation) the user has played.
 *
 * The DOM layout is two side-by-side columns:
 *   - `#historyMain`        : pure PGN main line, in pairs (white / black).
 *   - `#historyVariations`  : main-line prefix up to the deviation point,
 *                              then the deviation moves separated by a marker.
 *
 * Each move cell is clickable and jumps the board via `jumpToMove`.
 */

import { state } from "./state.js";
import { fenToPos } from "./api.js";
import { analyzeCurrentPosition } from "./analysis.js";
import { updatePgnNav } from "./navigation.js";

/**
 * Re-renders both the main-line and deviation tables.
 */
export function renderHistory() {
  renderMain();
  renderVariations();
}

/**
 * Renders the main-line table into `#historyMain`.
 *
 * Move evaluation symbols (e.g. "??", "!!") and colors come from
 * `move.evalData` populated by the backend after each `/api/analyze` call.
 */
function renderMain() {
  const div = document.getElementById("historyMain");
  div.innerHTML = "";

  if (!state.historyMain.length) {
    div.innerHTML = "—";
    return;
  }

  for (let i = 0; i < state.historyMain.length; i += 2) {
    const row = document.createElement("div");
    row.className = "history-row";

    const moveNumber = Math.floor(i / 2) + 1;

    const numCell = document.createElement("div");
    numCell.className = "move-number";
    numCell.textContent = `${moveNumber}.`;

    const whiteCell = buildMainCell(state.historyMain[i], i);
    const blackCell = buildMainCell(state.historyMain[i + 1], i + 1);

    row.appendChild(numCell);
    row.appendChild(whiteCell);
    row.appendChild(blackCell);
    div.appendChild(row);
  }
}

/**
 * Builds a single clickable move cell for the main-line table.
 *
 * @param {Object|undefined} move - The move record, or undefined for empty cells.
 * @param {number} index - 0-based ply index in the main line.
 * @returns {HTMLDivElement}
 */
function buildMainCell(move, index) {
  const cell = document.createElement("div");
  cell.className = "move-cell";
  if (!move) return cell;

  let txt = move.san;
  if (move.evalData?.symbol && move.evalData.symbol !== "–") {
    txt += move.evalData.symbol;
  }
  cell.textContent = txt;
  cell.onclick = () => jumpToMove(index, true);

  if (!state.in_deviation && state.currentMainlineIndex - 1 === index) {
    cell.classList.add("active-main");
  }
  if (move.evalData?.color) cell.style.color = move.evalData.color;
  return cell;
}

/**
 * Renders the deviation table into `#historyVariations`. The table includes
 * the inherited main-line prefix (greyed out as `inherited-move`) followed
 * by the deviation proper.
 */
function renderVariations() {
  const div = document.getElementById("historyVariations");
  div.innerHTML = "";

  if (!state.historyVariations.length) {
    div.innerHTML = "—";
    return;
  }

  const prefix = document.createElement("div");
  prefix.className = "variation-prefix";
  prefix.textContent = `Following main line until move ${Math.ceil(
    state.deviationStartIndex / 2
  )}`;
  div.appendChild(prefix);

  const inheritedLine = state.historyMain.slice(0, state.deviationStartIndex);
  const fullLine = [...inheritedLine, ...state.historyVariations];

  for (let i = 0; i < fullLine.length; i += 2) {
    if (i === state.deviationStartIndex || i + 1 === state.deviationStartIndex) {
      const separator = document.createElement("div");
      separator.className = "deviation-separator";
      separator.textContent = "↳ Deviation starts";
      div.appendChild(separator);
    }

    const row = document.createElement("div");
    row.className = "history-row";

    const moveNumber = Math.floor(i / 2) + 1;

    const numCell = document.createElement("div");
    numCell.className = "move-number";
    numCell.textContent = `${moveNumber}.`;

    const whiteCell = buildVariationCell(fullLine[i], i);
    const blackCell = buildVariationCell(fullLine[i + 1], i + 1);

    row.appendChild(numCell);
    row.appendChild(whiteCell);
    row.appendChild(blackCell);
    div.appendChild(row);
  }
}

/**
 * Builds a single move cell for the deviation table. Cells in the inherited
 * prefix are non-clickable; cells in the deviation proper jump back to that
 * point via `jumpToMove`.
 *
 * @param {Object|undefined} move - The move record, or undefined for empty cells.
 * @param {number} indexInFullLine - 0-based ply index within `fullLine`.
 * @returns {HTMLDivElement}
 */
function buildVariationCell(move, indexInFullLine) {
  const cell = document.createElement("div");
  cell.className = "move-cell";
  if (!move) return cell;

  let txt = move.san;
  if (move.evalData?.symbol && move.evalData.symbol !== "–") {
    txt += move.evalData.symbol;
  }
  cell.textContent = txt;

  const isInherited = indexInFullLine < state.deviationStartIndex;
  if (isInherited) {
    cell.classList.add("inherited-move");
  } else {
    const localIndex = indexInFullLine - state.deviationStartIndex;
    cell.onclick = () => jumpToMove(localIndex, false);
    if (state.currentVariationIndex - 1 === localIndex) {
      cell.classList.add("active-var");
    }
  }
  if (move.evalData?.color) cell.style.color = move.evalData.color;
  return cell;
}

/**
 * Restores the board to a previously played position and re-runs analysis.
 *
 * @param {number} index - Index in the corresponding history array.
 * @param {boolean} isMainLine - True for the main line, false for a deviation.
 */
export function jumpToMove(index, isMainLine) {
  let targetMove;

  if (isMainLine) {
    targetMove = state.historyMain[index];
    state.currentMainlineIndex = index + 1;
    state.historyVariations = [];
    state.currentVariationIndex = -1;
    state.in_deviation = false;
    state.pgn_index = state.currentMainlineIndex;
  } else {
    targetMove = state.historyVariations[index];
    state.currentVariationIndex = index + 1;
    state.in_deviation = true;
  }

  state.game_fen = targetMove.fen_after;
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();
  analyzeCurrentPosition(targetMove.fen_before, targetMove.uci);
}
