/**
 * @fileoverview RMB creates custom arrows.
 *
 * Use: call bindRightClickArrows(boardEl) on <div id="board">.
 * Overlay SVG on chessboard.
 * RMB on empty space deletes all.
 */

import { state } from "./state.js";

let _arrowStart = null;
let _arrows     = [];
let _highlights = [];

/**
 * @param {HTMLElement} boardEl - <div id="board">
 * @param {"white"|"black"} getOrientation - current side of the board
 */
export function bindRightClickArrows(boardEl, getOrientation) {
  boardEl.addEventListener("contextmenu", (e) => e.preventDefault());

  boardEl.addEventListener("mousedown", (e) => {
      if (e.button !== 2) return;
  
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
  
      const sq = squareFromEvent(e, boardEl, getOrientation());
      if (sq) _arrowStart = sq;
    },
    true // capture phase
  );

  boardEl.addEventListener("mouseup", (e) => {
      if (e.button !== 2) return;
  
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
  
      if (!_arrowStart) return;
  
      const sq = squareFromEvent(e, boardEl, getOrientation());
  
      if (sq) {
        if (sq === _arrowStart) {
          // Right click -> toggle square highlight
          const idx = _highlights.indexOf(sq);
          if (idx >= 0) {
            _highlights.splice(idx, 1);
          } else {
            _highlights.push(sq);
          }
          redrawHighlights(boardEl);
          saveToNode(boardEl);
        } else {
          // Right drag -> toggle arrow
          const idx = _arrows.findIndex(
            (a) => a.from === _arrowStart && a.to === sq
          );
  
          if (idx >= 0) {
            _arrows.splice(idx, 1);
          } else {
            _arrows.push({ from: _arrowStart, to: sq });
          }
          redraw(boardEl, getOrientation());
          saveToNode(boardEl);
        }
      }
  
      _arrowStart = null;
    },
    true // capture phase
  );
}

/** Clear arrows */
export function clearUserArrows(boardEl) {
  _arrows = [];
  const svg = boardEl.querySelector(".user-arrow-layer");
  if (svg) svg.remove();
}

/** Clear highlights */
export function clearHighlights(boardEl) {
  _highlights = [];
  boardEl.querySelectorAll(".highlight-right-click").forEach((e) => {
    e.classList.remove("highlight-right-click");
  });
}

/** Redraw highlights */
export function redrawHighlights(boardEl) {
  boardEl.querySelectorAll(".highlight-right-click").forEach((e) => {
    e.classList.remove("highlight-right-click");
  });
  _highlights.forEach((sq) => {
    const sqEl = boardEl.querySelector(`.square-${sq}`);
    if (sqEl) {
      sqEl.classList.add("highlight-right-click");
    }
  });
}

/** Clear everything and save */
export function clearAllUserOverlays(boardEl) {
  _arrows = [];
  _highlights = [];
  const svg = boardEl.querySelector(".user-arrow-layer");
  if (svg) svg.remove();
  boardEl.querySelectorAll(".highlight-right-click").forEach((e) => {
    e.classList.remove("highlight-right-click");
  });
  saveToNode(boardEl);
}

/** Save to state node */
function saveToNode(boardEl) {
  if (boardEl && boardEl.id === "board" && state.currentNode) {
    state.currentNode.userArrows = [..._arrows];
    state.currentNode.userHighlights = [..._highlights];
  }
}

/** Load from current node */
export function loadFromCurrentNode() {
  const boardEl = document.getElementById("board");
  if (!boardEl || !state.currentNode) return;
  _arrows = state.currentNode.userArrows ? [...state.currentNode.userArrows] : [];
  _highlights = state.currentNode.userHighlights ? [...state.currentNode.userHighlights] : [];
  redraw(boardEl, () => state.board.orientation());
  redrawHighlights(boardEl);
}

/** Redraw overlays in current state (e.g. on resize or flip) */
export function redrawCurrentOverlays() {
  const boardEl = document.getElementById("board");
  if (!boardEl) return;
  redraw(boardEl, () => state.board.orientation());
  redrawHighlights(boardEl);
}

/* internals */

function redraw(boardEl, orientation) {
  const existing = boardEl.querySelector(".user-arrow-layer");
  if (existing) existing.remove();
  if (!_arrows.length) return;

  const rect   = boardEl.getBoundingClientRect();
  const sqSize = rect.width / 8;
  const svgNS  = "http://www.w3.org/2000/svg";
  const COLOR  = "#f6822a";

  const svg = document.createElementNS(svgNS, "svg");
  svg.classList.add("user-arrow-layer");
  Object.assign(svg.style, {
    position: "absolute", top: "0", left: "0", pointerEvents: "none", zIndex: 10,
  });
  svg.setAttribute("width",  rect.width);
  svg.setAttribute("height", rect.height);

  _arrows.forEach(({ from, to }, i) => {
    const [fx, fy] = sqCenter(from, sqSize, orientation);
    const [tx, ty] = sqCenter(to,   sqSize, orientation);

    const markId = `uarrow-${i}`;
    const defs   = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", markId);
    marker.setAttribute("markerWidth", "3.5");
    marker.setAttribute("markerHeight", "3.5");
    marker.setAttribute("refX", "2.5");
    marker.setAttribute("refY", "1.75");
    marker.setAttribute("orient", "auto");
    const tri = document.createElementNS(svgNS, "polygon");
    tri.setAttribute("points", "0,0 3.5,1.75 0,3.5");
    tri.setAttribute("fill", COLOR);
    marker.appendChild(tri);
    defs.appendChild(marker);

    // Shorter line
    const dx = tx - fx, dy = ty - fy;
    const len = Math.sqrt(dx * dx + dy * dy);
    const shrink = sqSize * 0.28;
    const ex = tx - (dx / len) * shrink;
    const ey = ty - (dy / len) * shrink;

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", fx); line.setAttribute("y1", fy);
    line.setAttribute("x2", ex); line.setAttribute("y2", ey);
    line.setAttribute("stroke", COLOR);
    line.setAttribute("stroke-width", "8");
    line.setAttribute("opacity", "0.82");
    line.setAttribute("marker-end", `url(#${markId})`);

    svg.appendChild(defs);
    svg.appendChild(line);
  });

  boardEl.style.position = "relative";
  boardEl.appendChild(svg);
}

function sqCenter(sq, sqSize, orientation) {
  const file = sq.charCodeAt(0) - 97;  // a=0 … h=7
  const rank = parseInt(sq[1], 10) - 1;  // 1=0 … 8=7
  const orientStr = typeof orientation === "function" ? orientation() : orientation;
  if (orientStr === "white") {
    return [file * sqSize + sqSize / 2, (7 - rank) * sqSize + sqSize / 2];
  }
  return [(7 - file) * sqSize + sqSize / 2, rank * sqSize + sqSize / 2];
}

export function squareFromEvent(e, boardEl, orientation) {
  const rect   = boardEl.getBoundingClientRect();
  const x      = e.clientX - rect.left;
  const y      = e.clientY - rect.top;
  const sqSize = rect.width / 8;
  const col    = Math.floor(x / sqSize);
  const row    = Math.floor(y / sqSize);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;

  const orientStr = typeof orientation === "function" ? orientation() : orientation;
  const file = orientStr === "white" ? col         : 7 - col;
  const rank = orientStr === "white" ? 7 - row     : row;
  return String.fromCharCode(97 + file) + (rank + 1);
}
