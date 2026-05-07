/**
 * @fileoverview Chessboard.js drag/drop handlers and the promotion modal.
 *
 * `onDrop` and `onSnapEnd` are passed directly to the chessboard.js
 * constructor in `main.js`. Promotion is handled in two phases:
 *   1. Validate the move with a placeholder "queen" promotion.
 *   2. If legal, ask the user which piece they want via the modal, then
 *      replay the move with the chosen piece.
 *
 * Tree-model note: there is no longer a "deviation tip" guard. Dragging a
 * piece is always allowed; if the move differs from any existing child of
 * the current node, a new variation is appended automatically. If it
 * matches an existing child, we descend into that child (auto-merge,
 * see `pushMove` in moves.js).
 */

import { state } from "./state.js";
import { api, fenToPos } from "./api.js";
import { pushMove } from "./moves.js";

/**
 * Chessboard.js `onDrop` callback. Returning the string "snapback" tells the
 * board to revert the visual move; returning anything else accepts it.
 *
 * @param {string} source - Origin square.
 * @param {string} target - Destination square.
 * @param {string} piece  - Piece code (e.g. "wP").
 * @returns {string|undefined} "snapback" to cancel.
 */
export function onDrop(source, target, piece) {
  if (source === target) return "snapback";

  const isPromotion =
    (piece === "wP" && target[1] === "8") ||
    (piece === "bP" && target[1] === "1");

  if (isPromotion) {
    handlePromotion(source, target, piece === "wP" ? "white" : "black");
    return "snapback"; // we'll redraw correctly after the user picks a piece
  }
  handleNormalMove(source, target);
}

/**
 * Chessboard.js `onSnapEnd` callback. Resyncs the visual board with the
 * authoritative FEN after each animation, fixing pieces that look "stuck"
 * after invalid drops or promotion flows.
 */
export function onSnapEnd() {
  state.board.position(fenToPos(state.game_fen));
}

/**
 * Validates and commits a non-promotion move via the backend.
 *
 * @param {string} source
 * @param {string} target
 */
async function handleNormalMove(source, target) {
  if (state.is_moving) {
    state.board.position(fenToPos(state.game_fen));
    return;
  }
  state.is_moving = true;
  try {
    const fen_before = state.game_fen;
    const result = await api("/api/legal_moves", {
      fen: state.game_fen,
      from: source,
      to: target,
      promotion: "q",
    });
    if (!result.legal) {
      state.board.position(fenToPos(state.game_fen));
      return;
    }
    pushMove(result, fen_before);
  } finally {
    state.is_moving = false;
  }
}

/**
 * Handles a promotion drop. Validates legality first (avoiding a useless
 * modal on illegal moves), asks the user which piece, then commits.
 *
 * @param {string} source
 * @param {string} target
 * @param {"white"|"black"} color
 */
async function handlePromotion(source, target, color) {
  if (state.is_moving) {
    state.board.position(fenToPos(state.game_fen));
    return;
  }
  state.is_moving = true;

  try {
    const fen_before = state.game_fen;

    const legalityCheck = await api("/api/legal_moves", {
      fen: state.game_fen,
      from: source,
      to: target,
      promotion: "q",
    });
    if (!legalityCheck.legal) {
      state.board.position(fenToPos(state.game_fen));
      return;
    }

    const choice = await askPromotion(color);
    if (!choice) {
      state.board.position(fenToPos(state.game_fen));
      return;
    }

    const result = await api("/api/legal_moves", {
      fen: state.game_fen,
      from: source,
      to: target,
      promotion: choice,
    });
    if (result.legal) pushMove(result, fen_before);
  } finally {
    state.is_moving = false;
  }
}

/**
 * Shows the promotion modal and resolves to the user's chosen piece code,
 * or null if they cancel.
 *
 * @param {"white"|"black"} color
 * @returns {Promise<"q"|"r"|"b"|"n"|null>}
 */
function askPromotion(color) {
  return new Promise((resolve) => {
    const modal = document.getElementById("promoModal");
    const piecesEl = document.getElementById("promoPieces");
    const cancelBtn = document.getElementById("promoCancel");
    piecesEl.innerHTML = "";

    const pieces = [
      { code: "q", label: "Queen" },
      { code: "r", label: "Rook" },
      { code: "b", label: "Bishop" },
      { code: "n", label: "Knight" },
    ];
    const colorPrefix = color === "white" ? "w" : "b";

    pieces.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = "promo-piece";
      const img = document.createElement("img");
      img.src = `https://chessboardjs.com/img/chesspieces/wikipedia/${colorPrefix}${p.code.toUpperCase()}.png`;
      btn.appendChild(img);
      btn.onclick = () => close(p.code);
      piecesEl.appendChild(btn);
    });

    function close(value) {
      modal.classList.add("hidden");
      document.removeEventListener("keydown", onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === "Escape") close(null);
    }

    cancelBtn.onclick = () => close(null);
    document.addEventListener("keydown", onKey);
    modal.classList.remove("hidden");
  });
}
