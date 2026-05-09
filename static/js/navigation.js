/**
 * @fileoverview Game navigation: prev/next, slider, flip, reset, undo, plus
 * the new variation-promote / variation-delete buttons.
 *
 * "Current line" semantics:
 *   - Prev   : move cursor to currentNode.parent.
 *   - Next   : move cursor to currentNode.children[0] (deeper into the
 *              same continuation we're already on; this matches Lichess).
 *   - Slider : scrubs along the *main line only*, snapping out of any
 *              variation. This keeps the slider behaviour predictable.
 *
 * `updatePgnNav` is the canonical place to refresh the cursor labels and
 * the slider's bounds — it's called from any module that mutates the cursor.
 */

import {
  state,
  STARTING_FEN,
  resetTree,
  mainLineNodes,
  isOnMainLine,
} from "./state.js";
import { fenToPos } from "./api.js";
import { renderHistory, jumpToNode, jumpToMainLineIndex } from "./history.js";
import { analyzeCurrentPosition } from "./analysis.js";
import { deleteCurrentNode, promoteCurrentVariation } from "./moves.js";

/** Cached reference to the move slider. Initialized in `bindNavigation`. */
let moveSlider = null;

/**
 * Refreshes the slider bounds, position label, and prev/next button states
 * to match the current cursor. Also re-renders the eval chart's highlight.
 */
export function updatePgnNav() {
  const ml = mainLineNodes();
  const total = ml.length;
  const sliderMaxLabel = document.getElementById("sliderMax");

  // The "main-line index" reflected on the slider: 0 = root, N = last main move.
  const cursor = state.currentNode;
  const inVar = cursor.parent && !isOnMainLine(cursor);
  const mainIndex = inVar ? indexOfNearestMainAncestor(cursor) : cursor.ply;

  if (moveSlider) {
    moveSlider.max = total;
    moveSlider.value = mainIndex;
  }
  if (sliderMaxLabel) sliderMaxLabel.textContent = total;

  const prevBtn = document.getElementById("pgnPrev");
  const nextBtn = document.getElementById("pgnNext");

  if (total === 0 && state.currentNode === state.root) {
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  } else {
    const labelIndex = inVar ? `${cursor.ply}` : `${cursor.ply}`;
    const suffix = inVar ? " (var)" : "";
    prevBtn.disabled = !cursor.parent;
    nextBtn.disabled = cursor.children.length === 0;
  }

  // Promote/Delete only make sense when the cursor is on a variation node.
  const promoteBtn = document.getElementById("promoteBtn");
  const deleteBtn = document.getElementById("deleteVarBtn");
  if (promoteBtn) promoteBtn.disabled = !cursor.parent || isOnMainLine(cursor);
  if (deleteBtn) deleteBtn.disabled = !cursor.parent || isOnMainLine(cursor);

  if (state.evalChart) state.evalChart.update();
}

/**
 * Walks up from `node` until we reach a main-line ancestor and returns
 * its `ply`. Used by the slider to snap variation positions to the closest
 * main-line move number.
 *
 * @param {import("./state.js").Node} node
 * @returns {number}
 */
function indexOfNearestMainAncestor(node) {
  let n = node;
  while (n && !isOnMainLine(n)) n = n.parent;
  return n ? n.ply : 0;
}

/**
 * Steps the cursor one move forward along the current line. Following the
 * Lichess convention, "forward" means children[0] of the current node, so
 * once you've entered a variation, Next continues *inside* that variation.
 */
function nextMove() {
  const n = state.currentNode;
  if (n.children.length === 0) return;
  jumpToNode(n.children[0]);
}

/**
 * Steps the cursor one move backward (to the parent).
 */
function prevMove() {
  const n = state.currentNode;
  if (!n.parent) return;
  jumpToNode(n.parent);
}

/**
 * Resets the entire application state to the starting position and clears
 * any loaded PGN.
 */
function resetAll() {

  // reset logic state
  resetTree(STARTING_FEN);

  // reset cursor
  state.currentNode = state.root;
  state.game_fen = STARTING_FEN;

  // reset board UI
  state.board.position("start");

  // reset input
  document.getElementById("pgnInput").value = "";

  // reset labels UI
  state.whitePlayer = "";
  state.blackPlayer = "";
  state.gameResult = "";
  state.playersPrefix = "";
  state.currentOpeningName = "Starting Position";

  const openingEl = document.getElementById("openingName");
  if (openingEl) {
    openingEl.textContent = "Starting Position";
  }

  // rerender
  renderHistory();
  updatePgnNav();

  // reset eval chart
  if (state.evalChart) {
    state.evalChart.destroy();
    state.evalChart = null;
  }

  // new eval of position
  analyzeCurrentPosition();
}

/**
 * Undoes the last move on whatever line the cursor is on. Equivalent to
 * "delete current node and step up". If you're on the main line, this
 * truncates the main line by one ply.
 */
function undoLastMove() {
  if (!state.currentNode.parent) return;
  deleteCurrentNode();
  renderHistory();
  updatePgnNav();
  const n = state.currentNode;
  const prev_fen = n.parent ? n.parent.fenAfter : null;
  const last_move_uci = n.uci || null;
  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Promotes the entire ancestry of the current node so it becomes the main
 * line. After this, isOnMainLine(currentNode) is true.
 */
function promoteVariation() {
  if (!state.currentNode.parent || isOnMainLine(state.currentNode)) return;
  promoteCurrentVariation();
  renderHistory();
  updatePgnNav();
}

/**
 * @typedef {import("./state.js").Node} GameNode
 * @param {GameNode} node
 * @returns {GameNode}
 */
function variationBranchRoot(node) {
  let n = node;

  while (n.parent) {
    const parent = n.parent;

    // If this node is NOT the main continuation of parent,
    // then THIS is the root of the current variation branch.
    if (parent.children[0] !== n) {
      return n;
    }

    n = parent;
  }

  return node;
}

/**
 * Deletes the current variation subtree and moves the cursor up to the
 * parent. No-op on the main line (use Undo for that).
 */
function deleteVariation() {
  const current = state.currentNode;

  if (!current.parent || isOnMainLine(current)) return;

  // Root of the CURRENT variation level
  const root = variationBranchRoot(current);

  const parent = root.parent;
  if (!parent) return;

  // Remove only this variation branch
  parent.children = parent.children.filter((c) => c !== root);

  // Move cursor back to branching point
  state.currentNode = parent;
  state.game_fen = parent.fenAfter;
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  const prev_fen = parent.parent ? parent.parent.fenAfter : null;
  const last_move_uci = parent.uci || null;

  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Wires up every navigation control to its handler. Must be called once
 * after the DOM is ready.
 */
export function bindNavigation() {
  moveSlider = document.getElementById("moveSlider");

  document.getElementById("pgnNext").onclick = nextMove;
  document.getElementById("pgnPrev").onclick = prevMove;
  document.getElementById("resetBtn").onclick = resetAll;
  document.getElementById("flipBtn").onclick = () => state.board.flip();
  document.getElementById("undoBtn").onclick = undoLastMove;

  const promoteBtn = document.getElementById("promoteBtn");
  if (promoteBtn) promoteBtn.onclick = promoteVariation;

  const deleteBtn = document.getElementById("deleteVarBtn");
  if (deleteBtn) deleteBtn.onclick = deleteVariation;

  // Slider scrubs along the main line. Dragging silently updates the
  // board; release runs analysis once.
  moveSlider.addEventListener("input", function () {
    const targetIndex = parseInt(this.value, 10);
    jumpToMainLineIndex(targetIndex);
    document.getElementById("topMoves").innerHTML =
      "<li style='color:#888;'>Sliding...</li>";
  });

  // Keyboard shortcuts: ←/→ for prev/next.
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevMove();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nextMove();
    }
  });
}
