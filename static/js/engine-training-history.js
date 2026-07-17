/**
 * @fileoverview Tree-aware move history for the "Train vs engine" modal.
 *
 * The engine-training session keeps its own local game tree (rooted at the
 * selected start position); this renderer draws it into `#trainingHistoryPanel`
 * with the same paired-row + inline-variation look as the main analysis board
 * (`history.js`), so the user can click any move to jump there, branch off it,
 * and see sidelines in parentheses.
 *
 * Differences from `history.js`:
 *   - Move numbering is absolute: a training node at relative `ply` sits at
 *     absolute ply `startPly + ply`, so numbers continue from the preceding
 *     context moves (the moves already played before the training start).
 *   - The `startPly` context moves are rendered first, muted and non-clickable.
 *   - It is fully self-contained: it takes the session + an `onJump(node)`
 *     callback and never touches global app state.
 */

/**
 * Follows children[0] from the tree root, returning the main-line nodes
 * (root excluded), in order.
 *
 * @param {object} root
 * @returns {object[]}
 */
function mainLine(root) {
  const out = [];
  let n = root;
  while (n.children.length > 0) {
    n = n.children[0];
    out.push(n);
  }
  return out;
}

/**
 * True when `node` is reachable from the root by only ever taking children[0].
 * The root itself counts as main line.
 *
 * @param {object} node
 * @returns {boolean}
 */
function isOnMainLine(node) {
  let n = node;
  while (n.parent) {
    if (n.parent.children[0] !== n) return false;
    n = n.parent;
  }
  return true;
}

/**
 * (Re)draws the session's game tree into `#trainingHistoryPanel`.
 *
 * @param {object} session   The training session (needs root, currentNode,
 *                            startPly, precedingSans).
 * @param {(node:object)=>void} onJump  Called when a move token is clicked.
 */
export function renderEngineTrainingHistory(session, onJump) {
  const container = document.getElementById("trainingHistoryPanel");
  if (!container) return;
  container.innerHTML = "";

  const startPly = session.startPly || 0;
  const preceding = session.precedingSans || [];
  const treeMain = mainLine(session.root);
  const current = session.currentNode;
  const absPly = (node) => startPly + node.ply;

  // Absolute-ply → display token. Context tokens carry only a SAN string;
  // tree tokens carry the node itself.
  const tokenAt = (abs) => {
    if (abs <= 0) return null;
    if (abs <= startPly) return { context: true, san: preceding[abs - 1] };
    const node = treeMain[abs - startPly - 1];
    return node ? { node } : null;
  };

  const maxAbs = startPly + treeMain.length;
  if (maxAbs === 0) {
    container.innerHTML = "<div class='tplay-no-moves'>No moves yet</div>";
    return;
  }

  const frag = document.createDocumentFragment();

  const lastMove = Math.ceil(maxAbs / 2);
  for (let m = 1; m <= lastMove; m++) {
    const whiteTok = tokenAt(2 * m - 1);
    const blackTok = tokenAt(2 * m);

    frag.appendChild(buildRow(m, whiteTok, blackTok, current));

    // Sidelines are alternatives to a main-line node → render them just below
    // the row that contains that node (mirrors history.js anchoring).
    if (whiteTok?.node) emitSidelines(frag, whiteTok.node.parent, whiteTok.node, current, startPly);
    if (blackTok?.node) emitSidelines(frag, blackTok.node.parent, blackTok.node, current, startPly);
  }

  container.appendChild(frag);
  container.onclick = (ev) => {
    const tok = ev.target.closest("[data-node-id]");
    if (!tok) return;
    const id = Number(tok.dataset.nodeId);
    const node = session.nodeIndex.get(id);
    if (node) onJump(node);
  };

  const active = container.querySelector(".active-move");
  if (active) active.scrollIntoView({ block: "nearest" });
}

/* ==========================================================================
   Main rows
   ========================================================================== */

function buildRow(moveNo, whiteTok, blackTok, current) {
  const row = document.createElement("div");
  row.className = "history-row";

  const num = document.createElement("span");
  num.className = "move-number";
  num.textContent = `${moveNo}.`;
  row.appendChild(num);

  row.appendChild(buildMainCell(whiteTok, current));
  row.appendChild(buildMainCell(blackTok, current));
  return row;
}

function buildMainCell(tok, current) {
  const cell = document.createElement("span");
  cell.className = "tplay-move-cell";

  if (!tok) {
    cell.classList.add("empty");
    cell.textContent = "";
    return cell;
  }

  if (tok.context) {
    cell.classList.add("tplay-move-context");
    cell.textContent = tok.san || "";
    return cell;
  }

  cell.dataset.nodeId = String(tok.node.id);
  cell.textContent = tok.node.san || "";
  if (tok.node === current) cell.classList.add("active-main", "active-move");
  return cell;
}

/* ==========================================================================
   Sideline rows (inline parentheses, PGN style)
   ========================================================================== */

function emitSidelines(frag, parent, mainChild, current, startPly) {
  if (!parent || parent.children.length <= 1) return;
  // parent.children[0] === mainChild by construction.
  for (const sideline of parent.children.slice(1)) {
    const row = document.createElement("div");
    row.className = "variation-row";
    const block = document.createElement("span");
    block.className = "variation depth-1";
    appendText(block, "(");
    renderInline(sideline, block, 1, true, current, startPly);
    appendText(block, ")");
    row.appendChild(block);
    frag.appendChild(row);
  }
}

function renderInline(startNode, out, depth, needNumber, current, startPly) {
  emitToken(startNode, out, needNumber, current, startPly);
  appendText(out, " ");

  let n = startNode;
  while (n.children.length > 0) {
    const main = n.children[0];
    emitToken(main, out, false, current, startPly);
    appendText(out, " ");

    for (const s of n.children.slice(1)) {
      const block = document.createElement("span");
      block.className = `variation depth-${Math.min(depth + 1, 4)}`;
      appendText(block, "(");
      renderInline(s, block, depth + 1, true, current, startPly);
      appendText(block, ") ");
      out.appendChild(block);
    }

    n = main;
    if (n.children.length === 0) break;
    // After a `)` closes, a following black move must repeat its number.
    if (n.children.length > 0 && (n.parent?.children.length ?? 0) > 1) {
      const next = n.children[0];
      if ((startPly + next.ply) % 2 === 0) {
        const moveNo = Math.floor((startPly + next.ply - 1) / 2) + 1;
        appendText(out, `${moveNo}... `);
      }
    }
  }
}

function emitToken(node, out, forceNumber, current, startPly) {
  const abs = startPly + node.ply;
  const isWhite = abs % 2 === 1;
  const moveNo = Math.floor((abs - 1) / 2) + 1;
  if (isWhite) appendText(out, `${moveNo}. `);
  else if (forceNumber) appendText(out, `${moveNo}... `);

  const span = document.createElement("span");
  span.className = "move-token variation-move";
  span.dataset.nodeId = String(node.id);
  span.textContent = node.san || "";
  if (node === current) span.classList.add("active-move", "active-var");
  out.appendChild(span);
}

function appendText(parent, txt) {
  parent.appendChild(document.createTextNode(txt));
}

export { mainLine, isOnMainLine };
