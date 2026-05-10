/**
 * @fileoverview Training board controller.
 *
 * Builds a *separate* chessboard.js instance inside the training modal so
 * the main analysis board is never disturbed. Move legality is checked
 * locally with chess.js to keep retries instantaneous (no backend round
 * trip). Engine top-move data is still fetched from /api/analyze, but
 * cached per-FEN to avoid hammering the engine when the user retries.
 *
 * The controller exposes a small surface used by the mode logic:
 *   - mountBoard(fen, orientation, onUserMove)  → build / reset board
 *   - playMoveSilently(uci)                     → opponent move animation
 *   - getLegalDestinations(square)              → for highlight
 *   - destroy()                                 → tear down on session end
 */

import { api, fenToPos } from "./api.js";
import { bindRightClickArrows, clearUserArrows } from "./board-arrows.js";
import { onSnapEnd } from "./board.js";

 
/** A small in-memory cache: FEN → engine response. */
const engineCache = new Map();

/**
 * Asks the backend for the top engine moves at this FEN, caching the result.
 *
 * @param {string} fen
 * @param {number} depth
 * @returns {Promise<{top_moves:any[], eval:number, eval_mate:number|null}>}
 */
export async function fetchEngineMoves(fen, depth = 14) {
  if (engineCache.has(fen)) return engineCache.get(fen);
  const data = await api("/api/analyze", { fen, depth });
  engineCache.set(fen, data);
  return data;
}

/**
 * Creates a chessboard.js instance bound to `#trainingBoard`, with a fresh
 * chess.js Chess() driver for legality.
 *
 * @param {Object} opts
 * @param {string} opts.fen                 Initial FEN.
 * @param {"white"|"black"} opts.orientation
 * @param {(uci:string, san:string) => void} opts.onUserMove
 *        Called when the user successfully drops a *legal* move.
 * @returns {{ board: any, chess: any, destroy: () => void }}
 */
export function mountTrainingBoard({ fen, orientation, onUserMove, isLive = () => true }) {
  const chess = new Chess(fen);
  /* eslint-disable no-undef */
  const board = Chessboard("trainingBoard", {
    position: fenToPos(fen),
    orientation,
    draggable: true,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",

    onDragStart: (_source, piece) => {
      // Block dragging entirely while browsing history.
      if (!isLive()) {
        showHistoryToast();
        return false;
      }
      if (chess.game_over()) return false;
      const turn       = chess.turn();
      const pieceColor = piece[0];
      if (turn !== pieceColor) return false;
      const userTurn = orientation === "white" ? "w" : "b";
      if (turn !== userTurn) return false;
    },

    onDrop: (source, target) => {
      // Double-check: if somehow a drop fires while in history mode, snapback.
      if (!isLive()) {
        showHistoryToast();
        return "snapback";
      }

      const move = chess.move({
        from: source,
        to: target,
        promotion: "q",
      });
    
      if (move === null) {
        return "snapback";
      }

      clearUserArrows(document.getElementById("trainingBoard"));
      const uci = source + target + (move.promotion || "");
      onUserMove(uci, move.san, chess.fen());
    },
    
    // Sync shown state
    onSnapEnd: () => {
      board.position(fenToPos(chess.fen()));
    }
  });
  /* eslint-enable no-undef */

  // Resizing window
  const handleResize = () => {
    board.resize();
  };
  window.addEventListener("resize", handleResize);

  const ctx = {
    board,
    chess,
    destroy() {
      window.removeEventListener("resize", handleResize);
      const el = document.getElementById("trainingBoard");
      if (el) el.innerHTML = "";
    },
  };

  requestAnimationFrame(() => {
    board.resize();
    const el = document.getElementById("trainingBoard");
    if (el) bindRightClickArrows(el, () => orientation);
  });
  
  return ctx;
}

/**
 * Animates an opponent move on the board after a short delay so it doesn't
 * feel teleported. Updates the underlying chess.js state too.
 *
 * @param {{ board: any, chess: any }} ctx
 * @param {string} uci  e.g. "e7e5" or "g7g8q"
 */
export function playOpponentMove(ctx, uci) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : "q";
  const move = ctx.chess.move({ from, to, promotion });
  if (!move) return null;
  // chessboard.js animates a move when given the new position.
  ctx.board.position(fenToPos(ctx.chess.fen()));
  return move;
}

/**
 * Resets the board+chess to a fresh FEN (used when the user retries a
 * move and we want to re-show the original position).
 *
 * @param {{ board: any, chess: any }} ctx
 * @param {string} fen
 */
export function resetBoardTo(ctx, fen) {
  ctx.chess.load(fen);
  ctx.board.position(fenToPos(fen));
}

/**
 * Lists all legal destination squares from `square` in the given chess
 * position. Used by the hint system to light up source-squares of moves
 * the user might want to play.
 *
 * @param {any} chess
 * @param {string} square
 * @returns {string[]}
 */
export function legalDestinations(chess, square) {
  return chess.moves({ square, verbose: true }).map((m) => m.to);
}

/**
 * Determines whether the user's played move is "acceptable":
 * either (a) it's among the top N engine moves, OR
 *        (b) its score is within `cpTolerance` centipawns of the top.
 *
 * @param {string} userUci
 * @param {Array<{uci:string, score:number, mate:number|null}>} topMoves
 * @param {{ acceptTopN: number, cpTolerance: number }} cfg
 * @returns {boolean}
 */
export function isAcceptableMove(userUci, topMoves, cfg) {
  if (!topMoves || topMoves.length === 0) return true; // nothing to compare
  const topScore = topMoves[0].score;
  for (let i = 0; i < topMoves.length; i++) {
    const m = topMoves[i];
    if (m.uci !== userUci) continue;
    if (i < cfg.acceptTopN) return true;
    if (m.score == null || topScore == null) return false;
    return Math.abs(topScore - m.score) * 100 <= cfg.cpTolerance;
  }
  return false;
}

/**
 * Picks the opponent's reply move:
 *   - normal mode → top-1.
 *   - deep mode   → uniformly among moves within `cpTolerance` of top-1.
 *
 * @param {Array<{uci:string,score:number,mate:number|null}>} topMoves
 * @param {{ deepMode: boolean, cpTolerance: number }} cfg
 * @returns {string|null} UCI or null if no moves.
 */
export function pickOpponentReply(topMoves, cfg) {
  if (!topMoves || topMoves.length === 0) return null;
  if (!cfg.deepMode) return topMoves[0].uci;
  const top = topMoves[0];
  const pool = topMoves.filter(
    (m) =>
      m.score != null &&
      top.score != null &&
      Math.abs(top.score - m.score) * 100 <= cfg.cpTolerance
  );
  const choice = pool[Math.floor(Math.random() * pool.length)] || top;
  return choice.uci;
}

const CHECK_CLASS = "tplay-check-highlight";
 
/**
 * If the side to move in `chess` is in check, adds a red-ring CSS class to
 * the king's square element inside `#trainingBoard`. Removes it otherwise.
 *
 * Safe to call after every half-move; it always starts by clearing the old
 * highlight so stale rings never accumulate.
 *
 * @param {any} chess  A chess.js Chess instance reflecting the current position.
 */
export function highlightCheck(chess) {
  clearCheckHighlight();
  if (!chess || !chess.in_check()) return;
 
  const kingSq = findKingSquare(chess.fen(), chess.turn());
  if (!kingSq) return;
 
  const boardEl = document.getElementById("trainingBoard");
  if (!boardEl) return;
 
  const sqEl = boardEl.querySelector(`.square-${kingSq}`);
  if (sqEl) sqEl.classList.add(CHECK_CLASS);
}
 
/**
 * Removes the check-highlight from any square inside #trainingBoard.
 * Idempotent — safe to call when there is no highlight.
 */
export function clearCheckHighlight() {
  const boardEl = document.getElementById("trainingBoard");
  if (!boardEl) return;
  boardEl.querySelectorAll(`.${CHECK_CLASS}`).forEach((el) => {
    el.classList.remove(CHECK_CLASS);
  });
}
 
/**
 * Finds the square of the king for the given side by parsing the FEN
 * piece-placement string. Returns e.g. "e1" or null if not found.
 *
 * @param {string} fen
 * @param {"w"|"b"} turn  chess.js turn() value
 * @returns {string|null}
 */
function findKingSquare(fen, turn) {
  const kingChar = turn === "w" ? "K" : "k";
  const placement = fen.split(" ")[0];
  const rows = placement.split("/"); // rank 8 → rank 1
 
  for (let rankIdx = 0; rankIdx < 8; rankIdx++) {
    const rank = 8 - rankIdx; // FEN row 0 = rank 8
    let file = 0;
    for (const ch of rows[rankIdx]) {
      if (ch >= "1" && ch <= "8") {
        file += parseInt(ch, 10);
      } else {
        if (ch === kingChar) {
          return String.fromCharCode(97 + file) + String(rank); // e.g. "e1"
        }
        file++;
      }
    }
  }
  return null;
}

/* ==========================================================================
   History-mode toast
   ========================================================================== */

/** Singleton toast element, created once and reused. */
let _historyToastEl = null;
let _historyToastTimer = null;

/**
 * Shows a non-blocking toast over the training board when the user tries
 * to move a piece while browsing history.
 *
 * The toast auto-dismisses after 2 s. Multiple rapid calls debounce
 * gracefully (timer resets without creating duplicate elements).
 */
export function showHistoryToast() {
  const boardEl = document.getElementById("trainingBoard");
  if (!boardEl) return;

  // Create the element once and reuse it.
  if (!_historyToastEl) {
    _historyToastEl = document.createElement("div");
    _historyToastEl.className = "tplay-history-toast";
    _historyToastEl.textContent = "Go back to the last position to play";
  }

  // Attach to the board container if not already there.
  if (!_historyToastEl.parentElement) {
    boardEl.style.position = "relative"; // ensure positioning context
    boardEl.appendChild(_historyToastEl);
  }

  // Trigger the visible state (CSS transition handles fade-in).
  _historyToastEl.classList.add("visible");

  // Reset auto-hide timer.
  if (_historyToastTimer) clearTimeout(_historyToastTimer);
  _historyToastTimer = setTimeout(() => {
    if (_historyToastEl) _historyToastEl.classList.remove("visible");
  }, 2000);
}
