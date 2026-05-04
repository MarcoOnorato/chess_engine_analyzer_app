/**
 * @fileoverview Application entry point.
 *
 * Responsible for:
 *   - Constructing the chessboard.js instance and parking it on `state.board`.
 *   - Wiring DOM event handlers from each module (navigation, openings, etc).
 *   - Kicking off an initial analysis of the starting position.
 *
 * Everything below `window.load` runs exactly once when the page is ready.
 */

import { state } from "./state.js";
import { onDrop, onSnapEnd } from "./board.js";
import { analyzeCurrentPosition, renderArrows } from "./analysis.js";
import { bindNavigation } from "./navigation.js";
import { bindOpenings } from "./openings.js";
import { bindChessCom } from "./chesscom.js";
import { bindLichess } from './lichess.js';
import { bindPgnLoader } from "./pgn.js";
import { bindCollapsible } from "./collapsible.js";

window.addEventListener("load", () => {
  // Build the visual board. We keep the instance on `state.board` so every
  // module can access it without the import graph forming cycles.
  state.board = Chessboard("board", {
    position: "start",
    draggable: true,
    onDrop,
    onSnapEnd,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });

  // Keep the SVG arrow overlay aligned with the board on resize.
  window.addEventListener("resize", () => {
    state.board.resize();
    renderArrows(state.topMovesCache);
  });

  // Wire every UI subsystem.
  bindNavigation();
  bindOpenings();
  bindChessCom();
  bindLichess();
  bindPgnLoader();
  bindCollapsible();

  // Kick off the first analysis pass for the starting position.
  analyzeCurrentPosition();
});
