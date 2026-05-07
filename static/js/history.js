/**
 * @fileoverview Game-tree rendering — paired-rows layout with inline
 * variation blocks.
 *
 * Visual model (matches the old two-column layout the user prefers):
 *
 *   1.  e4    e5
 *   ( 2. d4 d5 3. Nf3 Nf6 ... )         ← variation block, inline parentheses
 *   2.  Nf3   Nc6
 *   3.  Bc4   Bc5
 *
 * Rules:
 *   - Each main-line row holds one full move: number | white | black.
 *   - When a main-line node has sidelines (children[1:]), we emit a
 *     "variation row" *immediately above* the row that starts at that
 *     branching point. The variation row contains all the sidelines that
 *     branch off the *previous* main-line node, between parentheses.
 *   - Nested variations stay inline with extra parentheses, so the user
 *     reads them like PGN — `1. e4 e5 (1... c5 2. Nf3 (2. Nc3) Nc6) 2. Nf3`.
 *
 * The branching-point semantics:
 *   - Sidelines off the white move of move N share the same parent as that
 *     white move. They render *above* the row containing move N's white move.
 *   - Sidelines off the black move of move N share the parent of that black
 *     move. They also render *above* the row of move N (because the black
 *     move sits in the same row as its white half) — but we mark them with
 *     the "..." continuation prefix.
 *
 * Active cursor handling: the row whose white or black cell corresponds to
 * `state.currentNode` gets `.active-row`. The specific cell gets
 * `.active-move` plus a color flavour (main vs var). Variation tokens use
 * the same convention so the user can tell where they are at a glance.
 */

import { state, isOnMainLine, mainLineNodes } from "./state.js";
import { fenToPos } from "./api.js";
import { analyzeCurrentPosition } from "./analysis.js";
import { updatePgnNav } from "./navigation.js";
import { refreshEvalChartHighlight } from "./accuracy.js";

/**
 * Re-renders the game tree into `#gameTree`. Idempotent.
 *
 * Layout rule:
 *   - Every main-line pair gets one `.history-row` (number, white, black).
 *   - A sideline of `parent` is, semantically, an alternative to
 *     `parent.children[0]` (the main-line move that was actually played
 *     after `parent`). The variation row is therefore anchored to the
 *     **row that contains `parent.children[0]`**, regardless of whether
 *     `parent.children[0]` is the white or the black half of that row:
 *
 *       parent  = root              → main-line move = ml[0]   (white)  → row 1
 *       parent  = whiteNode of N    → main-line move = ml[2N-1] (black)  → row N
 *       parent  = blackNode of N    → main-line move = ml[2N]   (white)  → row N+1
 *
 *     Concretely, sidelines of the *black* node of pair N belong **below**
 *     pair N+1, alongside any sidelines of the white node of pair N+1.
 *   - Sidelines off the root anchor to row 1 like any other "alternative
 *     to the main-line move".
 *   - Each sideline gets its own `.variation-row` so multiple alternatives
 *     stack vertically below the row they belong to.
 */
export function renderHistory() {
  const container = document.getElementById("gameTree");
  if (!container) return;
  container.innerHTML = "";

  const ml = mainLineNodes();
  if (ml.length === 0) {
    container.innerHTML = "<span class='tree-empty'>—</span>";
    return;
  }

  const frag = document.createDocumentFragment();

  // For each main-line pair, build the row and append the sidelines that
  // are alternatives to *either* the white or the black move of that pair.
  //
  // Anchoring map (pair index i, 0-based, covers ml[2i] white and ml[2i+1]
  // black):
  //   - sidelines that are alternatives to ml[2i]   (white of this pair)
  //       come from `parent` = ml[2i-1] (previous black) OR root if i = 0
  //   - sidelines that are alternatives to ml[2i+1] (black of this pair)
  //       come from `parent` = ml[2i] (this row's white)
  for (let i = 0; i < ml.length; i += 2) {
    const whiteNode = ml[i];          // ply 2k+1
    const blackNode = ml[i + 1];      // ply 2k+2 or undefined

    frag.appendChild(buildMainRow(whiteNode, blackNode));

    // Alternatives to whiteNode → sidelines of whiteNode.parent.
    // For row 1 (i = 0) that parent is the root.
    const parentOfWhite = whiteNode.parent;
    if (parentOfWhite) emitSidelinesBelow(frag, parentOfWhite, whiteNode);

    // Alternatives to blackNode → sidelines of whiteNode.
    // (whiteNode is the parent of blackNode on the main line.)
    if (blackNode) emitSidelinesBelow(frag, whiteNode, blackNode);
  }

  container.appendChild(frag);
  container.onclick = onTreeClick;
}

/* ==========================================================================
   Main rows
   ========================================================================== */

/**
 * Builds a single main-line row: `N.  white  black`. `blackNode` may be
 * undefined when the game ends on white's move.
 *
 * @param {import("./state.js").Node} whiteNode
 * @param {import("./state.js").Node|undefined} blackNode
 * @returns {HTMLDivElement}
 */
function buildMainRow(whiteNode, blackNode) {
  const row = document.createElement("div");
  row.className = "history-row";

  const moveNumber = Math.floor((whiteNode.ply - 1) / 2) + 1;

  const numCell = document.createElement("div");
  numCell.className = "move-number";
  numCell.textContent = `${moveNumber}.`;
  row.appendChild(numCell);

  row.appendChild(buildMainCell(whiteNode));
  row.appendChild(blackNode ? buildMainCell(blackNode) : emptyCell());

  // Mark the row active if the cursor is on either of its cells.
  if (state.currentNode === whiteNode || state.currentNode === blackNode) {
    row.classList.add("active-row");
  }
  return row;
}

/**
 * Builds a clickable SAN cell for the main-line column.
 *
 * @param {import("./state.js").Node} node
 * @returns {HTMLDivElement}
 */
function buildMainCell(node) {
  const cell = document.createElement("div");
  cell.className = "move-cell";
  cell.dataset.nodeId = String(node.id);

  let txt = node.san || "";
  if (node.evalData?.symbol && node.evalData.symbol !== "–") {
    txt += node.evalData.symbol;
  }
  cell.textContent = txt;
  if (node.evalData?.color) cell.style.color = node.evalData.color;

  if (state.currentNode === node) {
    cell.classList.add("active-move");
    cell.classList.add(isOnMainLine(node) ? "active-main" : "active-var");
  }
  return cell;
}

/** Empty placeholder cell so grids stay aligned. */
function emptyCell() {
  const c = document.createElement("div");
  c.className = "move-cell empty";
  return c;
}

/* ==========================================================================
   Sideline rows
   ========================================================================== */

/**
 * Emits the sidelines of `parent` (i.e. `parent.children[1:]`) as one
 * `.variation-row` per sideline, appended directly to `frag`. These are,
 * by definition, the alternatives to `mainChild` (= `parent.children[0]`).
 *
 * `mainChild` is taken as a parameter only for documentation / debugging;
 * it equals `parent.children[0]`. Pass it explicitly at the call site so
 * the anchoring intent is obvious there.
 *
 * @param {DocumentFragment|HTMLElement} frag
 * @param {import("./state.js").Node} parent
 * @param {import("./state.js").Node} mainChild
 *   The main-line move the sidelines are alternatives to. Must equal
 *   `parent.children[0]`.
 */
function emitSidelinesBelow(frag, parent, mainChild) {
  if (parent.children.length <= 1) return;
  // Sanity check (cheap and helps catch mis-wirings during refactors).
  // eslint-disable-next-line no-unused-expressions
  parent.children[0] === mainChild;
  const sidelines = parent.children.slice(1);
  for (const sideline of sidelines) {
    frag.appendChild(buildSingleSidelineRow(sideline));
  }
}

/**
 * Builds one variation row for a single top-level sideline. The row holds
 * exactly one `(...)` block. The first move of the sideline always carries
 * a number prefix; from there `renderInlineVariation` handles the rest.
 *
 * @param {import("./state.js").Node} startNode - First move of the sideline.
 * @returns {HTMLDivElement}
 */
function buildSingleSidelineRow(startNode) {
  const row = document.createElement("div");
  row.className = "variation-row";

  const block = document.createElement("span");
  block.className = "variation depth-1";
  appendText(block, "(");
  renderInlineVariation(startNode, block, /*depth=*/ 1, /*needNumber=*/ true);
  appendText(block, ")");
  row.appendChild(block);
  return row;
}

/**
 * Renders a variation subtree inline into `out`, starting from `startNode`
 * and walking children[0] forward. Sidelines (children[1:]) of every
 * traversed node are emitted as nested parentheses *immediately after*
 * the children[0] move they're alternatives to — matching PGN convention.
 *
 *   "1... c5 2. Nf3 (2. Nc3 d6) Nc6"
 *
 * Here `Nc3 d6` is a sideline of the node whose children[0] is `Nf3`, so
 * it appears between `Nf3` and `Nc6`.
 *
 * @param {import("./state.js").Node} startNode - First move of the variation.
 * @param {Node} out
 * @param {number} depth - Variation nesting depth (1 for top-level sideline).
 * @param {boolean} needNumber - Whether to emit a move-number prefix on
 *   `startNode`'s black move (white moves always get a number). True for
 *   the very first move of a variation, true again right after a `)` closes.
 */
function renderInlineVariation(startNode, out, depth, needNumber) {
  // First, emit `startNode` itself with its number prefix.
  emitVariationToken(startNode, out, depth, /*forceNumber=*/ needNumber);
  appendText(out, " ");

  // Then walk forward: at each step, emit children[0] of the current node,
  // emit the sidelines of the *current* node (alternatives to children[0]),
  // and descend into children[0].
  let n = startNode;
  while (n.children.length > 0) {
    const main = n.children[0];

    // children[0] continuation
    emitVariationToken(main, out, depth, /*forceNumber=*/ false);
    appendText(out, " ");

    // Sidelines of `n` are alternatives to `main`, render after `main`.
    const sidelines = n.children.slice(1);
    for (const s of sidelines) {
      const block = document.createElement("span");
      block.className = `variation depth-${Math.min(depth + 1, 4)}`;
      appendText(block, "(");
      renderInlineVariation(s, block, depth + 1, /*needNumber=*/ true);
      appendText(block, ") ");
      out.appendChild(block);
    }

    // After parens close, the next move (if any) needs to repeat its number
    // for the black case. We bake that into emitVariationToken by passing
    // forceNumber on the next iteration.
    n = main;
    if (n.children.length === 0) break;
    if (sidelines.length > 0) {
      // Re-emit number on next move only if it's a black move (white always
      // gets a number anyway). Push it via a tiny lookahead.
      const next = n.children[0];
      if (next.ply % 2 === 0) {
        // Black move: explicitly prefix with "N..." since parens just closed.
        const moveNo = Math.floor((next.ply - 1) / 2) + 1;
        appendText(out, `${moveNo}... `);
      }
    }
  }
}

/**
 * Emits a single variation token (`N. ` / `N... ` prefix + clickable SAN).
 * White moves always get a number; black moves get a number only when
 * `forceNumber` is true.
 *
 * @param {import("./state.js").Node} node
 * @param {Node} out
 * @param {number} depth
 * @param {boolean} forceNumber
 */
function emitVariationToken(node, out, depth, forceNumber) {
  const isWhite = node.ply % 2 === 1;
  const moveNo = Math.floor((node.ply - 1) / 2) + 1;
  if (isWhite) {
    appendText(out, `${moveNo}. `);
  } else if (forceNumber) {
    appendText(out, `${moveNo}... `);
  }
  out.appendChild(buildVariationToken(node, depth));
}

/**
 * Builds a clickable SAN token for use inside a variation block.
 *
 * @param {import("./state.js").Node} node
 * @param {number} depth
 * @returns {HTMLSpanElement}
 */
function buildVariationToken(node, depth) {
  const span = document.createElement("span");
  span.className = "move-token variation-move";
  span.dataset.nodeId = String(node.id);

  let txt = node.san || "";
  if (node.evalData?.symbol && node.evalData.symbol !== "–") {
    txt += node.evalData.symbol;
  }
  span.textContent = txt;
  if (node.evalData?.color) span.style.color = node.evalData.color;

  if (state.currentNode === node) {
    span.classList.add("active-move", "active-var");
  }
  return span;
}

/* ==========================================================================
   Plumbing
   ========================================================================== */

/**
 * Appends a plain text token (move numbers, parens, spaces) into `parent`.
 * @param {Node} parent
 * @param {string} txt
 */
function appendText(parent, txt) {
  parent.appendChild(document.createTextNode(txt));
}

/**
 * Click handler for the game-tree container. Looks up the data-node-id on
 * the closest move-bearing element and jumps the cursor there. Works for
 * both the .move-cell elements (main rows) and .move-token elements
 * (variation blocks) since both expose `dataset.nodeId`.
 *
 * @param {MouseEvent} ev
 */
function onTreeClick(ev) {
  const tok = ev.target.closest("[data-node-id]");
  if (!tok) return;
  const id = Number(tok.dataset.nodeId);
  const node = state.nodeIndex.get(id);
  if (node) jumpToNode(node);
}

/**
 * Restores the board to the position represented by `node` and re-runs
 * the per-position analysis.
 *
 * @param {import("./state.js").Node} node
 */
export function jumpToNode(node) {
  state.currentNode = node;
  state.game_fen = node.fenAfter;
  state.board.position(fenToPos(state.game_fen));

  renderHistory();
  scrollHistoryToCurrentMove();
  updatePgnNav();
  refreshEvalChartHighlight();

  const prev_fen = node.parent ? node.parent.fenAfter : null;
  const last_move_uci = node.uci || null;
  analyzeCurrentPosition(prev_fen, last_move_uci);
}

/**
 * Convenience: jump to the n-th node on the main line (1-based).
 * Used by chart click and by keyboard navigation. n=0 → root.
 *
 * @param {number} index - 1-based main-line ply, or 0 for the root.
 */
export function jumpToMainLineIndex(index) {
  if (index <= 0) {
    jumpToNode(state.root);
    return;
  }
  const ml = mainLineNodes();
  const target = ml[Math.min(index, ml.length) - 1];
  if (target) jumpToNode(target);
}

/**
 * Helper: autoscroll history section to match eval chart selection
 */
function scrollHistoryToCurrentMove() {
  const container = document.getElementById("gameTree");
  if (!container) return;

  const active = container.querySelector(".active-move");
  if (!active) return;

  const containerRect = container.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();

  const fullyVisible =
    activeRect.top >= containerRect.top &&
    activeRect.bottom <= containerRect.bottom;

  if (!fullyVisible) {
    active.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}
