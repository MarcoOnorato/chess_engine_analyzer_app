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
import { onDrop, onSnapEnd, bindClickToMove } from "./board.js";
import { analyzeCurrentPosition, renderArrows } from "./analysis.js";
import { bindNavigation } from "./navigation.js";
import { bindOpenings } from "./openings.js";
import { bindChessCom } from "./chesscom.js";
import { bindLichess } from "./lichess.js";
import { bindPgnLoader } from "./pgn.js";
import { bindCollapsible } from "./collapsible.js";
import { renderHistory } from "./history.js";
import { bindRightClickArrows, clearUserArrows, redrawCurrentOverlays } from "./board-arrows.js";
import { bindGameReviewToggle } from "./game-review.js";


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

  // Click to select & move pieces
  bindClickToMove(document.getElementById("board"));

  // Keep the SVG arrow overlay aligned with the board on resize.
  window.addEventListener("resize", () => {
    state.board.resize();
    renderArrows(state.topMovesCache);
    redrawCurrentOverlays();
  });

  // Re-render engine arrows after board flip so they follow the new orientation.
  // We intercept the flip button here (after the board is mounted) rather than
  // inside navigation.js so the fix is self-contained in the entry point.
  document.getElementById("flipBtn")?.addEventListener("click", () => {
    // board.flip() is already called by bindNavigation; we just need to
    // schedule a re-render *after* the flip animation settles.
    requestAnimationFrame(() => {
      renderArrows(state.topMovesCache);
      redrawCurrentOverlays();
    });
  });

  // Wire every UI subsystem.
  bindNavigation();
  bindOpenings();
  bindChessCom();
  bindLichess();
  bindPgnLoader();
  bindCollapsible();
  bindGameReviewToggle();

  // Initial render: empty tree, starting position analysis.
  renderHistory();
  analyzeCurrentPosition();

  // Deep-link from the Players dashboard: /?pgn_game=<id> loads that stored
  // game's PGN into the Review pipeline via the existing loadAndAnalyze flow.
  maybeLoadGameFromQuery();
});

/**
 * If the URL carries `?pgn_game=<id>`, fetch that game from the Player DB and
 * put it on the board.
 *
 * `?depth=<n>` selects the engine depth. When it is absent or equal to the
 * depth the game was ingested at, the analysis stored in the Player DB is
 * replayed as-is — no engine work, the game appears instantly. Any other depth
 * re-analyzes the game from scratch at that depth.
 */
async function maybeLoadGameFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get("pgn_game");
  if (!gameId) return;

  try {
    const res = await fetch(`/api/players/game/${encodeURIComponent(gameId)}/pgn`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.pgn || !window.loadAndAnalyze) return;

    const asked = parseInt(params.get("depth"), 10);
    const storedDepth = data.analysis_depth;
    const reuse = !Number.isFinite(asked) || asked === storedDepth;

    // Keep the depth selector honest about what is on the board — it also
    // drives the depth used for any sideline the user adds afterwards.
    const depthInput = document.getElementById("depth");
    const shown = reuse ? storedDepth : asked;
    if (depthInput && shown) depthInput.value = shown;

    await window.loadAndAnalyze(
      data.pgn,
      reuse && data.moves && data.moves.length ? data : null,
    );
  } catch (e) {
    console.error("Failed to load game from Players DB", e);
  }
}
