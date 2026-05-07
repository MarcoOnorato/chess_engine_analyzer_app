/**
 * @fileoverview Move execution on the game tree.
 *
 * `playMoveUci`        : programmatically plays a move from the engine's
 *                       suggestions (top moves panel).
 * `playAlternativeMove`: rewinds one ply, then plays a move — used when the
 *                       user picks a "Best Alternative" to the last move.
 * `pushMove`           : commits a legality-checked move into the tree.
 *
 * Branching rules on `pushMove`:
 *   - If the parent already has a child with the same UCI → reuse it
 *     (the user just replayed an existing line; no duplication).
 *   - Otherwise, append a new child:
 *       * If the parent had no children → it becomes children[0] (main line
 *         continuation).
 *       * If the parent already had children → the new node is children[i>0]
 *         (a sideline / variation).
 *
 * Notice we no longer have an "in_deviation" boolean: any node that isn't
 * on the main-line path is, by definition, in a variation. Variations can
 * be nested arbitrarily deep — playing a move from inside a variation just
 * appends children to that node.
 */

import { state, indexNode, nextNodeId, findChildByUci } from "./state.js";
import { api, fenToPos } from "./api.js";
import { renderHistory } from "./history.js";
import { analyzeCurrentPosition, renderArrows } from "./analysis.js";
import { updatePgnNav } from "./navigation.js";

/**
 * Plays a UCI move from the current node, appending it to the tree.
 * No-op if a move is already being processed.
 *
 * @param {string} uci - UCI move string (e.g. "e2e4" or "e7e8q").
 */
export async function playMoveUci(uci) {
  if (state.is_moving) return;
  state.is_moving = true;

  try {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci.length > 4 ? uci[4] : "q";
    const result = await api("/api/legal_moves", {
      fen: state.game_fen,
      from,
      to,
      promotion: promo,
    });
    if (!result.legal) return;
    pushMove(result, state.game_fen);
  } finally {
    state.is_moving = false;
  }
}

/**
 * Rewinds one ply (moves the cursor to the parent) and then plays the
 * provided alternative — i.e. introduces a sibling to the move that was
 * previously the cursor's last step.
 *
 * @param {string} uci - UCI of the alternative move to play.
 */
export async function playAlternativeMove(uci) {
  if (state.is_moving) return;
  if (!state.currentNode.parent) return; // already at root

  // Rewind to parent
  state.currentNode = state.currentNode.parent;
  state.game_fen = state.currentNode.fenAfter;
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  renderArrows([]);
  document.getElementById("topMoves").innerHTML = "<li>Branching...</li>";
  document.getElementById("altMoves").innerHTML = "<li>Branching...</li>";
  await playMoveUci(uci);
}

/**
 * Commits a legality-checked move into the tree at the current node, then
 * triggers a follow-up classification request whose result is folded back
 * into the new node's `evalData`.
 *
 * @param {Object} legalResult - Payload from `/api/legal_moves`.
 * @param {string} fen_before  - FEN immediately before the move (== parent.fenAfter).
 */
export function pushMove(legalResult, fen_before) {
  const parent = state.currentNode;

  // Auto-merge: if a child with this UCI already exists, just descend into it.
  const existing = findChildByUci(parent, legalResult.uci);
  let node;
  if (existing) {
    node = existing;
  } else {
    node = {
      id: nextNodeId(),
      parent,
      children: [],
      san: legalResult.san,
      uci: legalResult.uci,
      fenBefore: fen_before,
      fenAfter: legalResult.new_fen,
      ply: parent.ply + 1,
      evalData: null,
      cpLoss: null,
      eval: null,
      eval_mate: null,
    };
    parent.children.push(node);
    indexNode(node);
  }

  state.currentNode = node;
  state.game_fen = node.fenAfter;
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  updatePgnNav();

  // After the position-level analysis runs, also request a per-move
  // classification so the symbol/color show up in the tree next render.
  analyzeCurrentPosition(fen_before, legalResult.uci).then(async () => {
    if (node.evalData) return; // already analyzed (auto-merge case)
    try {
      const analysis = await api("/api/analyze", {
        fen: node.fenAfter,
        prev_fen: fen_before,
        last_move_uci: legalResult.uci,
        depth: parseInt(document.getElementById("depth").value, 10) || 14,
      });
      node.evalData = analysis.classification;
      node.eval = analysis.eval;
      node.eval_mate = analysis.eval_mate;
      node.cpLoss = Math.max(0, analysis.best_eval_loss || 0);
      renderHistory();
    } catch (e) {
      console.error("Move classification failed:", e);
    }
  });
}

/**
 * Removes the current node (and its subtree) from the tree, moving the
 * cursor up to its parent. No-op at the root.
 *
 * Used for "Undo last move" and as the implementation of the variation
 * delete button.
 */
export function deleteCurrentNode() {
  const node = state.currentNode;
  if (!node.parent) return;
  const parent = node.parent;
  const idx = parent.children.indexOf(node);
  if (idx >= 0) {
    parent.children.splice(idx, 1);
    state.nodeIndex.delete(node.id);
    // Also purge descendants from the index.
    purgeSubtreeFromIndex(node);
  }
  state.currentNode = parent;
  state.game_fen = parent.fenAfter;
  state.board.position(fenToPos(state.game_fen));
}

/**
 * Promotes the current node so that it becomes children[0] of its parent
 * — i.e. the new "main line" choice at that branching point. Recursively
 * walks up the tree so the entire ancestry leading to this node is on the
 * main line. Idempotent if the node is already on main line.
 */
export function promoteCurrentVariation() {
  let n = state.currentNode;
  while (n.parent) {
    const parent = n.parent;
    const i = parent.children.indexOf(n);
    if (i > 0) {
      parent.children.splice(i, 1);
      parent.children.unshift(n);
    }
    n = parent;
  }
}

/**
 * Removes every node in `node`'s subtree (including `node` itself) from
 * `state.nodeIndex`. Helper for `deleteCurrentNode`.
 *
 * @param {import("./state.js").Node} node
 */
function purgeSubtreeFromIndex(node) {
  state.nodeIndex.delete(node.id);
  for (const c of node.children) purgeSubtreeFromIndex(c);
}
