/**
 * @fileoverview Builds an analyzed main line into `state`, without any Review
 * page DOM.
 *
 * The position pickers in `training-selectors.js` read the game through
 * `mainLineNodes()`, so training a game means putting that game in `state`
 * first. On the Review page `loadPgn()` does it as a side effect of rendering
 * the board, the history, the eval chart and the review panel — none of which
 * exist on the Training page. This module does the same job with nothing but
 * the tree: parse, then fill in the engine fields the pickers rely on
 * (cpLoss, eval, eval_mate, evalData, topMoves).
 *
 * Games coming from the Player DB arrive with that analysis already done, so
 * they skip the engine entirely; every other source pays for a full pass.
 *
 * Variations are not built: the pickers only ever walk the main line.
 */

import { state, resetTree, indexNode, nextNodeId } from "./state.js";
import { api } from "./api.js";
import { labelStyle } from "./game-review.js";

/**
 * @param {Object} source - A resolved source from `training-source.js`.
 * @param {Object} opts
 * @param {number} opts.depth - Engine depth, ignored when the source is stored.
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<{analyzed: number, fromStore: boolean}>}
 */
export async function loadGameIntoState(source, { depth, onProgress }) {
  const startFen = source.startFen;
  resetTree(startFen);

  const nodes = buildMainLine(source.fens, source.moves, state.root);
  if (!nodes.length) throw new Error("That game has no moves to train on.");

  const stored = storedByFen(source.stored);
  if (stored) {
    nodes.forEach((node) => applyAnalysis(node, stored.get(node.fenAfter)));
    onProgress?.(nodes.length, nodes.length);
    return { analyzed: nodes.length, fromStore: true };
  }

  const cache = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    onProgress?.(i, nodes.length);
    let analysis = cache.get(node.fenAfter);
    if (!analysis) {
      analysis = await api("/api/analyze", {
        fen: node.fenAfter,
        prev_fen: node.fenBefore,
        last_move_uci: node.uci,
        depth,
      });
      cache.set(node.fenAfter, analysis);
    }
    applyAnalysis(node, {
      eval: analysis.eval,
      eval_mate: analysis.eval_mate,
      cp_loss: Math.max(0, analysis.best_eval_loss || 0),
      classification: analysis.classification,
      top_moves: analysis.top_moves || [],
    });
  }
  onProgress?.(nodes.length, nodes.length);
  return { analyzed: nodes.length, fromStore: false };
}

/** Linear chain of nodes for the main line, all registered in the index. */
function buildMainLine(fens, moves, root) {
  const nodes = [];
  let parent = root;
  for (let i = 0; i < moves.length; i++) {
    const node = {
      id: nextNodeId(),
      parent,
      children: [],
      san: moves[i].san,
      uci: moves[i].uci,
      fenBefore: fens[i],
      fenAfter: fens[i + 1],
      ply: parent.ply + 1,
      evalData: null,
      cpLoss: null,
      eval: null,
      eval_mate: null,
      topMoves: [],
      opening: null,
      comment: "",
      nags: [],
    };
    parent.children.push(node);
    indexNode(node);
    nodes.push(node);
    parent = node;
  }
  return nodes;
}

/**
 * Indexes a stored Player DB analysis by the FEN it belongs to, in the shape
 * `applyAnalysis` expects. Returns null when there is nothing stored.
 */
function storedByFen(stored) {
  if (!stored || !stored.moves || !stored.moves.length) return null;
  const map = new Map();
  for (const m of stored.moves) {
    if (!m.fen_after) continue;
    map.set(m.fen_after, {
      eval: m.eval,
      eval_mate: m.eval_mate,
      cp_loss: Math.max(0, m.cp_loss || 0),
      classification: m.label
        ? { label: m.label, ...labelStyle(m.label), diff_cp: Math.max(0, m.cp_loss || 0) }
        : null,
      // Only the engine's first choice is persisted — that is all the error
      // categoriser reads. Older rows have none, and the categories that need
      // it are simply not detected for those games.
      top_moves: m.best_uci
        ? [{ uci: m.best_uci, san: m.best_san, score: m.best_score, mate: m.best_mate }]
        : [],
    });
  }
  return map;
}

function applyAnalysis(node, data) {
  if (!data) return;
  node.eval = data.eval ?? null;
  node.eval_mate = data.eval_mate ?? null;
  node.cpLoss = data.cp_loss ?? 0;
  node.evalData = data.classification || null;
  node.topMoves = data.top_moves || [];
}
