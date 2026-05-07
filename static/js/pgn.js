/**
 * @fileoverview PGN loading pipeline (game-tree edition, with variations).
 *
 * The backend's `/api/load_pgn` now returns a full tree:
 *
 *   {
 *     start_fen, headers,
 *     tree: { fenAfter, children: [Node, ...] },     // root (no move)
 *     moves, fens                                    // legacy main-line flat lists
 *   }
 *
 * Each Node has { san, uci, fenBefore, fenAfter, comment, nags, children }.
 * children[0] is the main-line continuation; children[1:] are sidelines.
 *
 * High-level flow:
 *   1. POST `/api/load_pgn`. Receive the tree.
 *   2. Walk the tree depth-first and convert backend Nodes into our internal
 *      Node objects (with id/parent/ply/evalData), registering each in
 *      `state.nodeIndex`.
 *   3. For every node in the tree, POST `/api/analyze` to fill in eval,
 *      classification, and cpLoss. We deduplicate by `fenAfter` so positions
 *      that appear identically in multiple branches are analyzed once.
 *   4. Render the tree, set the cursor at the tip of the main line, kick
 *      off the post-game accuracy panel and eval chart.
 *
 * On success, the load panel auto-collapses (via `collapseLoadPanel`).
 */

import { state, resetTree, indexNode, nextNodeId, mainLineNodes } from "./state.js";
import { api, fenToPos } from "./api.js";
import { renderHistory, jumpToMainLineIndex, scrollHistoryToCurrentMove } from "./history.js";
import { updatePgnNav } from "./navigation.js";
import { analyzeCurrentPosition } from "./analysis.js";
import { calculateGameAccuracy, renderEvalChart } from "./accuracy.js";
import { collapseLoadPanel } from "./collapsible.js";

/** Wires the PGN loading modal and buttons to the pipeline. */
export function bindPgnLoader() {
  const modal = document.getElementById("pgnModal");
  const openModalBtn = document.getElementById("openPgnModalBtn");
  const closeModalBtn = document.getElementById("closePgnModalBtn");
  const submitPgnBtn = document.getElementById("submitPgnBtn");
  const pgnInput = document.getElementById("pgnInput");

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });

  window.loadAndAnalyze = async (pgnString) => {
    modal.style.display = "none";
  
    await new Promise((resolve) => requestAnimationFrame(resolve));
  
    const success = await loadPgn(pgnString);
  
    if (success) {
      pgnInput.value = "";
    }
  };
  
  openModalBtn.onclick = () => {
    modal.style.display = "flex";
    pgnInput.focus();
    pgnInput.click();
    pgnInput.setSelectionRange(0, pgnInput.value.length);
  };

  closeModalBtn.onclick = () => {
    modal.style.display = "none";
  };

  submitPgnBtn.onclick = () => window.loadAndAnalyze();

  pgnInput.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window.loadAndAnalyze();
    }
  };
}

/* ==========================================================================
   Pipeline
   ========================================================================== */

/**
 * Loads and analyzes a PGN string, populating the game tree.
 * @param {string|null} directPgn - Optional PGN; if null, reads from #pgnInput.
 * @returns {Promise<boolean>}
 */
export async function loadPgn(directPgn = null) {
  const txt = directPgn
    ? directPgn.trim()
    : document.getElementById("pgnInput").value.trim();
  if (!txt) return false;

  // --- Header extraction (player names + result) ---
  const whiteMatch = txt.match(/\[White\s+"([^"]+)"\]/);
  const blackMatch = txt.match(/\[Black\s+"([^"]+)"\]/);
  const resultMatch = txt.match(/\[Result\s+"([^"]+)"\]/);

  state.whitePlayer =
    whiteMatch && whiteMatch[1] !== "?" ? whiteMatch[1] : "";
  state.blackPlayer =
    blackMatch && blackMatch[1] !== "?" ? blackMatch[1] : "";
  state.gameResult = resultMatch ? resultMatch[1] : "";
  state.playersPrefix =
    state.whitePlayer && state.blackPlayer
      ? `⚪ ${state.whitePlayer} vs ⚫ ${state.blackPlayer} — `
      : "";
  state.currentOpeningName = "Starting Position";

  const depth = parseInt(document.getElementById("depth").value, 10) || 11;
  const overlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  overlay.classList.remove("hidden");

  try {
    // --- 1. Fetch tree from backend. ---
    const data = await api("/api/load_pgn", { pgn: txt });

    // Some backends may not yet return `tree` — fall back gracefully to the
    // flat `moves`/`fens` representation in that case.
    const startFen =
      data.start_fen ||
      (data.fens && data.fens[0]) ||
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    // --- 2. Build the in-memory tree and pick the main-line tip. ---
    resetTree(startFen);
    let mainLineTip = state.root;

    if (data.tree && Array.isArray(data.tree.children) && data.tree.children.length > 0) {
      mainLineTip = buildTreeFromBackend(data.tree, state.root);
    } else if (data.moves && data.fens) {
      mainLineTip = buildLinearChain(data.moves, data.fens, state.root);
    } else {
      throw new Error("PGN payload contained no moves");
    }

    // --- 3. Analyze every node (dedup'd by fenAfter). ---
    const allNodes = collectNodesDFS(state.root).filter((n) => n.parent !== null);
    await analyzeAllNodes(allNodes, depth, loadingText);

    // --- 4. Cursor at tip of main line. Render everything. ---
    state.currentNode = mainLineTip;
    state.game_fen = mainLineTip.fenAfter;
    state.board.position(fenToPos(state.game_fen));

    renderHistory();
    updatePgnNav();
    calculateGameAccuracy();
    renderEvalChart((mainIndex) => jumpToMainLineIndex(mainIndex + 1));
    scrollHistoryToCurrentMove();

    const prev_fen = mainLineTip.parent ? mainLineTip.parent.fenAfter : null;
    const last_move_uci = mainLineTip.uci || null;
    analyzeCurrentPosition(prev_fen, last_move_uci);

    // --- 5. Opening / players display. ---
    updateOpeningDisplay();

    overlay.classList.add("hidden");
    collapseLoadPanel();
    return true;
  } catch (e) {
    overlay.classList.add("hidden");
    alert("Error loading PGN");
    console.error(e);
    return false;
  }
}

/* ==========================================================================
   Tree building
   ========================================================================== */

/**
 * Recursively converts a backend tree node (with `children: BackendNode[]`)
 * into our internal Node and attaches it to `parent`. Returns the node that
 * sits at the end of the main-line continuation rooted at `backendNode`
 * (i.e. the "tip" you'd reach by always following children[0]).
 *
 * @param {Object} backendRoot - Backend root: { children: [...], fenAfter }.
 * @param {import("./state.js").Node} parent - Internal root to attach under.
 * @returns {import("./state.js").Node} The main-line tip after the import.
 */
function buildTreeFromBackend(backendRoot, parent) {
  let mainTip = parent;
  for (let i = 0; i < backendRoot.children.length; i++) {
    const child = backendRoot.children[i];
    const node = createNode(parent, child);
    parent.children.push(node);
    indexNode(node);

    const subTip = buildTreeFromBackend(child, node);

    // children[0] is the main continuation — its tip is *our* main tip.
    if (i === 0) mainTip = subTip;
  }
  if (backendRoot.children.length === 0) return parent;
  return mainTip;
}

/**
 * Builds an internal Node from a backend Node, without recursing.
 * @param {import("./state.js").Node} parent
 * @param {Object} backend
 * @returns {import("./state.js").Node}
 */
function createNode(parent, backend) {
  return {
    id: nextNodeId(),
    parent,
    children: [],
    san: backend.san,
    uci: backend.uci,
    fenBefore: backend.fenBefore,
    fenAfter: backend.fenAfter,
    ply: parent.ply + 1,
    evalData: null,
    cpLoss: null,
    eval: null,
    eval_mate: null,
    comment: backend.comment || "",
    nags: backend.nags || [],
  };
}

/**
 * Legacy fallback: builds a single linear chain from the old (moves, fens)
 * payload. Used when the backend doesn't yet return `tree`.
 *
 * @param {Array<{san:string,uci:string}>} moves
 * @param {string[]} fens
 * @param {import("./state.js").Node} root
 * @returns {import("./state.js").Node} Main-line tip.
 */
function buildLinearChain(moves, fens, root) {
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
      comment: "",
      nags: [],
    };
    parent.children.push(node);
    indexNode(node);
    parent = node;
  }
  return parent;
}

/**
 * Returns every node in the subtree rooted at `node`, in depth-first order.
 * Used to enumerate analysis targets after the tree is built.
 *
 * @param {import("./state.js").Node} node
 * @returns {import("./state.js").Node[]}
 */
function collectNodesDFS(node) {
  const out = [node];
  for (const c of node.children) {
    out.push(...collectNodesDFS(c));
  }
  return out;
}

/* ==========================================================================
   Analysis
   ========================================================================== */

/**
 * Runs the engine analysis on every node and writes back evalData / eval /
 * eval_mate / cpLoss in place. Positions are deduplicated by `fenAfter` so
 * the same FEN reached by two branches only hits the engine once.
 *
 * Also opportunistically updates `state.currentOpeningName` whenever a
 * recognized opening name comes back from `/api/analyze`. Only main-line
 * nodes can advance the opening name (variations are exploratory and
 * shouldn't override the played opening).
 *
 * @param {import("./state.js").Node[]} nodes - All non-root nodes.
 * @param {number} depth - Engine depth.
 * @param {HTMLElement} loadingText - DOM element for progress feedback.
 */
async function analyzeAllNodes(nodes, depth, loadingText) {
  const total = nodes.length;
  const cache = new Map(); // fenAfter -> analysis payload
  const mainLineSet = new Set(mainLineNodes());

  for (let i = 0; i < total; i++) {
    const node = nodes[i];
    loadingText.textContent = `Analyzing ${i + 1} of ${total}...`;

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

    node.evalData = analysis.classification;
    node.eval = analysis.eval;
    node.eval_mate = analysis.eval_mate;
    node.cpLoss = Math.max(0, analysis.best_eval_loss || 0);

    if (
      mainLineSet.has(node) &&
      analysis.opening &&
      analysis.opening !== "Custom Position" &&
      analysis.opening !== "Starting Position"
    ) {
      state.currentOpeningName = analysis.opening;
    }
  }
}

/* ==========================================================================
   Display helpers
   ========================================================================== */

/** Updates the opening / players banner above the board. */
function updateOpeningDisplay() {
  const displayEl = document.getElementById("openingName");
  if (!displayEl) return;

  const finalDisplay =
    state.currentOpeningName === "Starting Position" ||
    state.currentOpeningName === "Custom Position"
      ? "Custom Position"
      : state.currentOpeningName;
  const resultSuffix = state.gameResult ? ` — ${state.gameResult}` : "";
  displayEl.textContent = state.playersPrefix + resultSuffix + finalDisplay;
}
