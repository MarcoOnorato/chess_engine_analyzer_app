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
export function mountTrainingBoard({ fen, orientation, onUserMove }) {
  const chess = new Chess(fen);
  /* eslint-disable no-undef */
  const board = Chessboard("trainingBoard", {
    position: fenToPos(fen),
    orientation,
    draggable: true,
    pieceTheme:
      "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",

    onDragStart: (_source, piece) => {
      if (chess.game_over()) return false;
      const turn       = chess.turn();          
      const pieceColor = piece[0];              
      if (turn !== pieceColor) return false;
      const userTurn = orientation === "white" ? "w" : "b";
      if (turn !== userTurn) return false;
    },

    onDrop: (source, target) => {
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
