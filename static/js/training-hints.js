/**
 * @fileoverview Hint escalation for the training board.
 *
 * Escalation policy (per-position state, resets between scenarios):
 *
 *   Attempt #1 wrong  → message "Wrong move, try again", board reset.
 *   Attempt #2 wrong  → message + light up the legal source squares of the
 *                       acceptable engine top moves.
 *   Attempt #3 wrong  → ask "Want a hint?" — on yes, draw arrows on the
 *                       acceptable engine top moves; on no, just keep
 *                       playing without escalation.
 *
 * After the user finally plays a correct move, hint state is reset for
 * the next move within the same scenario. (We don't carry hint debt
 * between moves of the same scenario.)
 *
 * The hint module renders into the *training* board container, not the
 * main board. `boardEl` is the `<div>` hosting the training chessboard.
 */

const HINT_ARROW_CLASS = "training-hint-arrow";
const HINT_HIGHLIGHT_CLASS = "training-hint-highlight";

/**
 * Clears any visual hint overlays (arrows, square highlights).
 * @param {HTMLElement} boardEl
 */
export function clearHints(boardEl) {
  boardEl.querySelectorAll(`.${HINT_ARROW_CLASS}`).forEach((e) => e.remove());
  boardEl
    .querySelectorAll(`.${HINT_HIGHLIGHT_CLASS}`)
    .forEach((e) => e.classList.remove(HINT_HIGHLIGHT_CLASS));
}

/**
 * Highlights the source squares of the engine's preferred moves so the
 * user can see *which pieces* should move, without seeing where to.
 *
 * @param {HTMLElement} boardEl
 * @param {Array<{from:string,to:string}>} moves
 */
export function highlightSourceSquares(boardEl, moves) {
  const seen = new Set();
  moves.forEach((m) => {
    if (seen.has(m.from)) return;
    seen.add(m.from);
    const sq = boardEl.querySelector(`.square-${m.from}`);
    if (sq) sq.classList.add(HINT_HIGHLIGHT_CLASS);
  });
}

/**
 * Draws SVG arrows for the engine's preferred moves overlaid on the
 * training board. Mirrors the renderer used in analysis.js but anchored
 * to a different board element.
 *
 * @param {HTMLElement} boardEl
 * @param {Array<{from:string,to:string}>} moves
 * @param {"white"|"black"} orientation
 */
export function drawHintArrows(boardEl, moves, orientation) {
  // Always start clean — never stack two SVG layers.
  boardEl.querySelectorAll(`.${HINT_ARROW_CLASS}`).forEach((e) => e.remove());
  if (!moves.length) return;

  const rect = boardEl.getBoundingClientRect();
  const sqSize = rect.width / 8;
  const svgNS = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(svgNS, "svg");
  svg.classList.add(HINT_ARROW_CLASS);
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.pointerEvents = "none";

  // Cyan-themed palette so it reads as "training hint" not "engine eval".
  const colors = ["#26bbff", "#1399ec", "#8ad2ff"];

  moves.forEach((m, i) => {
    const [fx, fy] = sqToXY(m.from, sqSize, orientation);
    const [tx, ty] = sqToXY(m.to, sqSize, orientation);

    const defs = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", `tHintArrow${i}`);
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

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", fx);
    line.setAttribute("y1", fy);
    line.setAttribute("x2", tx);
    line.setAttribute("y2", ty);
    line.setAttribute("stroke", colors[i] || "#888");
    line.setAttribute("stroke-width", 7);
    line.setAttribute("opacity", 0.85);
    line.setAttribute("marker-end", `url(#tHintArrow${i})`);

    svg.appendChild(defs);
    svg.appendChild(line);
  });

  boardEl.style.position = "relative";
  boardEl.appendChild(svg);
}

/**
 * Maps an algebraic square ("e4") to centered pixel coordinates inside the
 * board, taking orientation into account.
 *
 * @param {string} sq
 * @param {number} sqSize
 * @param {"white"|"black"} orient
 * @returns {[number,number]}
 */
function sqToXY(sq, sqSize, orient) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  if (orient === "white") {
    return [file * sqSize + sqSize / 2, (7 - rank) * sqSize + sqSize / 2];
  }
  return [(7 - file) * sqSize + sqSize / 2, rank * sqSize + sqSize / 2];
}
