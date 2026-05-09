/**
 * @fileoverview Application entry point.
 *
 * Responsible for:
 *   - Constructing the chessboard.js instance and parking it on `state.board`.
 *   - Wiring DOM event handlers from each module (navigation, openings, etc).
 *   - Kicking off an initial analysis of the starting position.
 *
 * The game-tree model lives in `state.js`. Every module reads/mutates
 * `state.root` / `state.currentNode` instead of the old flat
 * `historyMain` / `historyVariations` arrays.
 *
 * Everything below `window.load` runs exactly once when the page is ready.
 */

import { state } from "./state.js";
import { onDrop, onSnapEnd } from "./board.js";
import { analyzeCurrentPosition, renderArrows } from "./analysis.js";
import { bindNavigation } from "./navigation.js";
import { bindOpenings } from "./openings.js";
import { bindChessCom } from "./chesscom.js";
import { bindLichess } from "./lichess.js";
import { bindPgnLoader } from "./pgn.js";
import { bindCollapsible } from "./collapsible.js";
import { renderHistory } from "./history.js";
import { bindRightClickArrows, clearUserArrows } from "./board-arrows.js";


window.addEventListener("load", () => {
  state.board = Chessboard("board", {
    position: "start",
    draggable: true,
    onDrop,
    onSnapEnd,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });

  // Arrows creation with RMB drag
  bindRightClickArrows(
    document.getElementById("board"),
    () => state.board.orientation()
  );

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

  // Initial render: empty tree, starting position analysis.
  renderHistory();
  analyzeCurrentPosition();
});
