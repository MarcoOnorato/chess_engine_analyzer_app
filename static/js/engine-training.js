/**
 * @fileoverview Free-play training against the engine.
 *
 * The game to start from comes from the shared picker in `training-source.js`;
 * the selected ply becomes the starting position.
 */

import {
  SOURCES,
  renderSourcePicker,
  submitOnEnter,
  el,
  escapeHtml,
  labeledInput,
  selectField,
  showErr,
} from "./training-source.js";
import {
  mountTrainingBoard,
  fetchEngineMoves,
  pickOpponentReply,
  playOpponentMove,
  highlightCheck,
  clearCheckHighlight,
  resetBoardTo,
} from "./training-board.js";
import {
  setEvalBar,
  setEvalResult,
  setHeader,
  setStatus,
} from "./training-ui.js";
import { drawHintArrows, clearHints } from "./training-hints.js";
import {
  renderEngineTrainingHistory,
  isOnMainLine,
} from "./engine-training-history.js";

const BODY_ID = "trainingModalBody";

/**
 * Fallback hint depth when the main screen has no readable depth value. The
 * hint runs at full engine strength (no elo/skill cap) regardless of the
 * opponent's difficulty; only the search depth is user-adjustable.
 */
const DEFAULT_HINT_DEPTH = 14;
const MIN_HINT_DEPTH = 6;
const MAX_HINT_DEPTH = 30;

const DIFFICULTIES = {
  beginner: { label: "Beginner ~900", depth: 3, skillLevel: 0, weights: [0.70, 0.20, 0.10], delay: 500 },
  casual:   { label: "Casual ~1200", depth: 5, skillLevel: 3, weights: [0.80, 0.15, 0.05], delay: 650 },
  medium:   { label: "Medium ~1500", depth: 7, engineElo: 1500, weights: [1.00, 0.00, 0.00], delay: 800 },
  strong:   { label: "Strong ~1800", depth: 9, engineElo: 1800, weights: [1.00, 0.00, 0.00], delay: 900 },
  expert:   { label: "Expert ~2200", depth: 12, engineElo: 2200, weights: [1.00, 0.00, 0.00], delay: 1000 },
};

let boardCtx = null;
let session = null;
let hintVisible = false;

/** Where to return when the flow is closed (set by the Training hub). */
let onClose = null;

/* ==========================================================================
   Local game tree (isolated from the main analysis board's state)

   The session owns its own tree, rooted at the selected start position.
   Every move played (by the user or the engine) is a node; children[0] is
   the main line, children[1:] are variations. This mirrors the main board's
   model (state.js / moves.js) so history clicks, branching, promote, and
   delete behave the same way inside the modal.
   ========================================================================== */

let etNodeSeq = 0;

/** Fresh root node anchored at `fen`. */
function etMakeRoot(fen) {
  return { id: ++etNodeSeq, parent: null, children: [], san: null, uci: null, fenAfter: fen, ply: 0 };
}

/** Child node for a played move. */
function etMakeNode(parent, san, uci, fenAfter) {
  return { id: ++etNodeSeq, parent, children: [], san, uci, fenAfter, ply: parent.ply + 1 };
}

/**
 * Commits a move under `session.currentNode`, auto-merging with an existing
 * child of the same UCI, and advances the cursor onto it.
 *
 * @returns {object} The node the cursor now sits on.
 */
function etPushMove(san, uci, fenAfter) {
  const parent = session.currentNode;
  let node = parent.children.find((c) => c.uci === uci);
  if (!node) {
    node = etMakeNode(parent, san, uci, fenAfter);
    parent.children.push(node);
    session.nodeIndex.set(node.id, node);
  }
  session.currentNode = node;
  session.fen = node.fenAfter;
  return node;
}

/** Promotes the current node's whole ancestry to the main line. */
function etPromote() {
  let n = session.currentNode;
  while (n.parent) {
    const p = n.parent;
    const i = p.children.indexOf(n);
    if (i > 0) {
      p.children.splice(i, 1);
      p.children.unshift(n);
    }
    n = p;
  }
}

/** Walks up to the node where the current variation branches off the line. */
function etBranchRoot(node) {
  let n = node;
  while (n.parent) {
    if (n.parent.children[0] !== n) return n;
    n = n.parent;
  }
  return node;
}

/** Removes a subtree (node included) from the lookup index. */
function etPurgeIndex(node) {
  session.nodeIndex.delete(node.id);
  for (const c of node.children) etPurgeIndex(c);
}

/**
 * @param {Object} [opts]
 * @param {() => void} [opts.onExit] - Called when the user leaves the flow.
 */
export function openEngineTrainingModal(opts = {}) {
  const modal = document.getElementById("trainingModal");
  if (!modal) return;

  onClose = typeof opts.onExit === "function" ? opts.onExit : null;
  cleanupBoard();
  session = null;
  modal.classList.remove("hidden");
  setHeader("Train vs engine", close);
  renderSetupScreen();
}

function body() {
  return document.getElementById(BODY_ID);
}

function renderSetupScreen() {
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-import-wrap");
  wrap.style.maxWidth = "760px";

  const sourceRoot = el("div", "");
  wrap.appendChild(sourceRoot);
  // Any game works here — a stored analysis buys nothing, the engine plays on
  // from the position rather than judging the moves already made.
  const picker = renderSourcePicker(sourceRoot, {
    sources: [
      SOURCES.NEW, SOURCES.REVIEW, SOURCES.PLAYER_DB,
      SOURCES.OPENING, SOURCES.PGN, SOURCES.LICHESS, SOURCES.CHESSCOM,
    ],
    initial: SOURCES.NEW,
  });

  const configGrid = el("div", "tap-extra-fields");
  configGrid.appendChild(selectField("Side to play", "et-side", [
    ["white", "White"],
    ["black", "Black"],
  ], "white"));
  configGrid.appendChild(selectField(
    "Engine difficulty",
    "et-difficulty",
    Object.entries(DIFFICULTIES).map(([id, cfg]) => [id, cfg.label]),
    "medium"
  ));
  wrap.appendChild(configGrid);

  const startPlyField = labeledInput("Start from ply / half-move", "et-start-ply", "number", "0");
  const startPlyInput = startPlyField.querySelector("input");
  startPlyInput.min = "0";
  startPlyInput.value = "0";
  wrap.appendChild(startPlyField);

  const err = el("div", "tap-error hidden");
  wrap.appendChild(err);

  const actions = el("div", "training-config-footer");
  const cancel = el("button", "");
  cancel.textContent = "← Close";
  cancel.onclick = close;
  const start = el("button", "training-cta");
  start.textContent = "Start vs engine →";
  start.onclick = async () => {
    err.classList.add("hidden");
    start.disabled = true;
    start.textContent = "Preparing…";
    try {
      const sourceData = await picker.resolve();
      const side = document.getElementById("et-side").value;
      const difficultyId = document.getElementById("et-difficulty").value;
      const maxPly = Math.max(0, sourceData.fens.length - 1);
      const requestedPly = parseInt(document.getElementById("et-start-ply").value, 10) || 0;
      const startPly = Math.max(0, Math.min(maxPly, requestedPly));

      const startFen = sourceData.fens[startPly];
      const root = etMakeRoot(startFen);

      session = {
        ...sourceData,
        startPly,
        userColor: side,
        difficultyId,
        difficulty: DIFFICULTIES[difficultyId],
        startFen,
        fen: startFen,
        precedingSans: sourceData.moves.slice(0, startPly).map((m) => m.san),
        root,
        currentNode: root,
        nodeIndex: new Map([[root.id, root]]),
      };

      renderPlayScreen();
    } catch (e) {
      showErr(err, e.message || "Could not prepare engine training.");
      start.disabled = false;
      start.textContent = "Start vs engine →";
    }
  };
  actions.appendChild(cancel);
  actions.appendChild(start);
  wrap.appendChild(actions);
  submitOnEnter([startPlyField], start);

  root.appendChild(wrap);
}

function renderPlayScreen() {
  setHeader("Train vs engine", close);
  const root = body();
  const defaultHintDepth = mainScreenDepth();
  root.innerHTML = `
    <div class="tplay-layout">
      <div class="tplay-board-col">
        <div class="tplay-scenario-badge">
          <span class="tplay-badge-num">Train vs engine</span>
          <span class="tplay-badge-reason">${escapeHtml(session.label)} — from ply ${session.startPly} — ${escapeHtml(session.difficulty.label)}</span>
        </div>
        <div class="tplay-board-wrap">
          <div class="evalbar" id="trainingEvalBar">
            <div class="evalfill" id="trainingEvalFill" style="height:50%"></div>
            <span class="evaltext" id="trainingEvalText">0.0</span>
          </div>
          <div id="trainingBoard" class="tplay-board"></div>
        </div>
        <div class="tplay-nav-row">
          <button id="etFlipBtn" class="tplay-nav-btn" title="Flip board">⇅</button>
          <button id="etRestartBtn" class="tplay-nav-btn tplay-reset-btn"
                  data-tip="Reset to the selected start position (ply ${session.startPly}) — clears every move and variation you've played">↺ Reset</button>
          <button id="etHintBtn" class="tplay-nav-btn tplay-hint-btn" title="Show the engine's 3 best moves (search depth adjustable in the field beside)">💡 Hint</button>
          <label class="tplay-hint-depth" title="Engine depth used for the hint">
            depth
            <input id="etHintDepth" type="number" min="6" max="30" value="${defaultHintDepth}" />
          </label>
        </div>
      </div>
      <div class="tplay-side-col">
        <div class="card tplay-history-card">
          <div class="tplay-history-head">
            <div class="tplay-history-label">📜 Move History</div>
            <div class="tplay-var-actions">
              <button id="etPromoteBtn" class="tplay-var-btn" data-tip="Make the current variation the main line" disabled>⬆ Main line</button>
              <button id="etDeleteVarBtn" class="tplay-var-btn tplay-var-btn-danger" data-tip="Delete the current variation" disabled>🗑 Delete</button>
            </div>
          </div>
          <div class="tplay-history-hint">Click a past move to jump there, then play to open a variation.</div>
          <div id="trainingHistoryPanel" class="tplay-history-scroll"></div>
        </div>
        <div class="card tplay-status-card">
          <div class="tplay-status-label">Status</div>
          <div id="trainingStatus" class="training-status-box tone-info">Loading…</div>
        </div>
        <div class="tplay-actions-row">
          <span class="tplay-moves-counter">You play <b>${session.userColor}</b></span>
          <div class="tplay-action-btns">
            <button id="etSetupBtn" class="tplay-back-list-btn">← Setup</button>
            <button id="etStopBtn" class="tplay-skip-btn">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;

  cleanupBoard();
  hintVisible = false;
  boardCtx = mountTrainingBoard({
    fen: session.fen,
    orientation: session.userColor,
    onUserMove: handleUserMove,
    isLive: () => true,
    moveSpeed: 300,
  });

  document.getElementById("etFlipBtn").onclick = () => {
    hideHint();
    boardCtx?.board?.flip();
  };
  document.getElementById("etRestartBtn").onclick = restartFromInitialPosition;
  document.getElementById("etHintBtn").onclick = toggleHint;
  document.getElementById("etPromoteBtn").onclick = promoteVariation;
  document.getElementById("etDeleteVarBtn").onclick = deleteVariation;
  document.getElementById("etSetupBtn").onclick = () => {
    cleanupBoard();
    renderSetupScreen();
  };
  document.getElementById("etStopBtn").onclick = close;

  clearCheckHighlight();
  highlightCheck(boardCtx.chess);
  updateHistory();
  updateHintButton();
  updateVariationButtons();
  refreshEval();
  maybeEngineToMove();
}

/** True when it's the human's turn to move and the game isn't over. */
function isPlayerTurn() {
  if (!boardCtx || boardCtx.chess.game_over()) return false;
  const turn = boardCtx.chess.turn() === "w" ? "white" : "black";
  return turn === session.userColor;
}

/**
 * Enables the Hint button only on the player's turn; hides any stale hint
 * arrows when it isn't (e.g. right after the player moves).
 */
function updateHintButton() {
  const btn = document.getElementById("etHintBtn");
  if (!btn) return;
  const allowed = isPlayerTurn();
  btn.disabled = !allowed;
  if (!allowed) hideHint();
}

/** Toggles the 3-best-moves hint arrows on the player's turn. */
async function toggleHint() {
  if (hintVisible) {
    hideHint();
    return;
  }
  if (!isPlayerTurn()) return;

  const ctx = boardCtx;
  const btn = document.getElementById("etHintBtn");
  if (btn) btn.textContent = "💡 …";
  try {
    // Full engine strength (no elo/skill cap) so the hint is genuinely best,
    // at the user-selected search depth.
    const data = await fetchEngineMoves(ctx.chess.fen(), selectedHintDepth());
    if (boardCtx !== ctx || !session || !isPlayerTurn()) return;
    // Only ever suggest genuinely good moves: keep at most 3, and drop any
    // that lose meaningfully vs. the best move so a hint is never misleading.
    const moves = goodHintMoves(data.top_moves || [], ctx.chess.turn());
    if (!moves.length) return;
    const boardEl = document.getElementById("trainingBoard");
    // Use the live board orientation (the user may have flipped it) so the
    // arrows land on the correct squares.
    drawHintArrows(boardEl, moves, ctx.board.orientation());
    hintVisible = true;
  } catch (e) {
    console.error(e);
  } finally {
    const b = document.getElementById("etHintBtn");
    if (b) b.textContent = "💡 Hint";
  }
}

/**
 * Centipawn loss (vs. the best available move) below which a move still
 * counts as "good" for hinting. Matches the app's classify_move boundary:
 * < 80cp is Best/Excellent/Good; 80cp+ is an Inaccuracy or worse.
 */
const HINT_GOOD_TOLERANCE_CP = 80;

/**
 * Filters the engine's ranked moves down to the ones worth suggesting:
 * at most 3, and only those within HINT_GOOD_TOLERANCE_CP of the best move
 * from the side-to-move's perspective. So if only one or two moves are good,
 * only those are shown — a hint never points at a worsening move.
 *
 * `top_moves` scores are White-POV (pawns), with `mate` (White-POV) for
 * forced-mate lines; we convert to a mover-POV value where higher is better.
 *
 * @param {Array<{from?:string,to?:string,score:?number,mate:?number}>} topMoves
 * @param {"w"|"b"} turn  Side to move (chess.js turn()).
 * @returns {Array<object>} Up to 3 good moves, best first.
 */
function goodHintMoves(topMoves, turn) {
  const moves = (topMoves || []).filter((m) => m.from && m.to);
  if (!moves.length) return [];

  const sign = turn === "w" ? 1 : -1;
  const value = (m) => {
    if (m.mate != null) {
      const mm = m.mate * sign; // mover-POV mate distance (+ = mover mates)
      return mm > 0 ? 1e7 - mm : -1e7 - mm;
    }
    return (m.score ?? 0) * 100 * sign; // mover-POV centipawns
  };

  const best = Math.max(...moves.map(value));
  return moves.filter((m) => best - value(m) < HINT_GOOD_TOLERANCE_CP).slice(0, 3);
}

/** Reads the depth from the main analysis screen (`#depth`), clamped. */
function mainScreenDepth() {
  const raw = parseInt(document.getElementById("depth")?.value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_HINT_DEPTH;
  return Math.max(MIN_HINT_DEPTH, Math.min(MAX_HINT_DEPTH, raw));
}

/** Reads the hint-depth input in the play screen, clamped to a sane range. */
function selectedHintDepth() {
  const raw = parseInt(document.getElementById("etHintDepth")?.value, 10);
  if (!Number.isFinite(raw)) return DEFAULT_HINT_DEPTH;
  return Math.max(MIN_HINT_DEPTH, Math.min(MAX_HINT_DEPTH, raw));
}

/** Removes hint arrows if shown. Safe to call unconditionally. */
function hideHint() {
  const boardEl = document.getElementById("trainingBoard");
  if (boardEl) clearHints(boardEl);
  hintVisible = false;
}

async function handleUserMove(uci, san, fenAfter) {
  hideHint();
  const node = etPushMove(san, uci, fenAfter);
  updateHistory();
  highlightCheck(boardCtx.chess);
  updateHintButton();
  updateVariationButtons();

  if (handleGameOver()) return;

  // Replaying into an already-explored line: follow the engine's known reply
  // instead of re-querying (which would spawn a duplicate sideline).
  if (node.children.length > 0) {
    setStatus(`You played ${san}.`, { tone: "success" });
    await delay(300);
    followKnownReply(node);
    return;
  }

  setStatus(`You played ${san}. Engine thinking…`, { tone: "success" });
  await delay(session.difficulty.delay);
  await engineMove(node);
}

/**
 * Advances the cursor onto the engine's already-recorded reply to `node`
 * (its children[0]), animating the move. Used when the user revisits a line.
 */
function followKnownReply(node) {
  if (!boardCtx || !session || session.currentNode !== node) return;
  const reply = node.children[0];
  if (!reply) return;
  playOpponentMove(boardCtx, reply.uci);
  session.currentNode = reply;
  session.fen = reply.fenAfter;
  updateHistory();
  highlightCheck(boardCtx.chess);
  updateHintButton();
  updateVariationButtons();
  if (handleGameOver()) return;
  setStatus(`Engine: ${reply.san}. Your move.`, { tone: "info" });
  refreshEval();
}

async function maybeEngineToMove() {
  if (!boardCtx) return;
  const turn = boardCtx.chess.turn() === "w" ? "white" : "black";
  if (turn !== session.userColor) {
    setStatus("Engine to move from the selected position…", { tone: "info" });
    await delay(500);
    await engineMove(session.currentNode);
  } else {
    setStatus("Your move.", { tone: "info" });
  }
}

/**
 * Plays the engine's reply from `fromNode` and records it as a child.
 * Aborts (without touching the board) if the user has meanwhile navigated
 * away, so the tree and board never get out of sync.
 */
async function engineMove(fromNode) {
  if (!boardCtx || handleGameOver()) return;
  const ctx = boardCtx;

  try {
    const data = await fetchEngineMoves(
      ctx.chess.fen(),
      session.difficulty.depth,
      strengthParams(session.difficulty)
    );
    if (boardCtx !== ctx || !session || session.currentNode !== fromNode) return;
    setEvalBar(data.eval, data.eval_mate, session.userColor);
    const reply = pickEngineMove(data.top_moves || [], session.difficulty);
    if (!reply) {
      handleGameOver(true);
      return;
    }

    const move = playOpponentMove(ctx, reply);
    const san = move ? move.san : reply;
    etPushMove(san, reply, ctx.chess.fen());
    updateHistory();
    highlightCheck(boardCtx.chess);
    updateVariationButtons();

    if (handleGameOver()) return;
    setStatus(`Engine: ${san}. Your move.`, { tone: "info" });
    updateHintButton();
    refreshEval();
  } catch (e) {
    console.error(e);
    setStatus("Engine move failed.", { tone: "error" });
  }
}

function pickEngineMove(topMoves, difficulty) {
  if (!topMoves.length) return null;
  const max = Math.min(topMoves.length, difficulty.weights.length);
  const roll = Math.random();
  let acc = 0;
  for (let i = 0; i < max; i++) {
    acc += difficulty.weights[i] || 0;
    if (roll <= acc) return topMoves[i].uci;
  }
  return pickOpponentReply(topMoves, { deepMode: false, cpTolerance: 0 });
}

function strengthParams(difficulty) {
  return {
    engineElo: difficulty.engineElo ?? null,
    skillLevel: difficulty.skillLevel ?? null,
  };
}

async function refreshEval() {
  if (!boardCtx) return;
  const ctx = boardCtx;
  try {
    const data = await fetchEngineMoves(
      ctx.chess.fen(),
      session.difficulty.depth,
      strengthParams(session.difficulty)
    );
    if (boardCtx !== ctx || !session) return;
    setEvalBar(data.eval, data.eval_mate, session.userColor);
  } catch {
    // Non-fatal.
  }
}

function handleGameOver(force = false) {
  if (!boardCtx) return true;
  if (!force && !boardCtx.chess.game_over()) return false;

  const chess = boardCtx.chess;
  let msg = "Game over.";
  let result = "½-½";
  if (chess.in_checkmate()) {
    const winner = chess.turn() === "w" ? "black" : "white";
    result = winner === "white" ? "1-0" : "0-1";
    msg = `Checkmate — ${result}. ${winner === "white" ? "White" : "Black"} wins.`;
  } else if (chess.in_stalemate()) {
    msg = "Stalemate — ½-½.";
  } else if (chess.in_draw()) {
    msg = "Draw — ½-½.";
  }

  // Mirror the review: winner fills the eval bar and the score is shown there.
  setEvalResult(result, session.userColor);
  setStatus(msg, { tone: "success" });
  return true;
}

/**
 * Resets the session to a fresh tree at the selected start position,
 * discarding every played move and variation.
 */
function restartFromInitialPosition() {
  if (!session) return;
  const root = etMakeRoot(session.startFen);
  session.root = root;
  session.currentNode = root;
  session.nodeIndex = new Map([[root.id, root]]);
  session.fen = session.startFen;
  renderPlayScreen();
}

function updateHistory() {
  renderEngineTrainingHistory(session, jumpToTrainingNode);
}

/**
 * Moves the cursor to `node` (browsing history). Reloads the board to that
 * position so the user can continue — or branch — from there. Never triggers
 * an engine move; that only happens in response to an actual user move.
 */
function jumpToTrainingNode(node) {
  if (!boardCtx || !session) return;
  hideHint();
  session.currentNode = node;
  session.fen = node.fenAfter;
  resetBoardTo(boardCtx, node.fenAfter);
  clearCheckHighlight();
  highlightCheck(boardCtx.chess);
  updateHistory();
  updateHintButton();
  updateVariationButtons();

  const turn = boardCtx.chess.turn() === "w" ? "white" : "black";
  if (boardCtx.chess.game_over()) {
    handleGameOver(); // sets the result eval bar; skip the live eval fetch
  } else {
    refreshEval();
    if (turn === session.userColor) {
      setStatus("Your move — play here to open a variation.", { tone: "info" });
    } else {
      setStatus("Engine to move from this position.", { tone: "info" });
    }
  }
}

/** Enables promote/delete only when the cursor sits on a variation node. */
function updateVariationButtons() {
  const cur = session.currentNode;
  const isVar = !!cur.parent && !isOnMainLine(cur);
  const promote = document.getElementById("etPromoteBtn");
  const del = document.getElementById("etDeleteVarBtn");
  if (promote) promote.disabled = !isVar;
  if (del) del.disabled = !isVar;
}

/** Promotes the current variation so it becomes the session's main line. */
function promoteVariation() {
  const cur = session.currentNode;
  if (!cur.parent || isOnMainLine(cur)) return;
  etPromote();
  updateHistory();
  updateVariationButtons();
  setStatus("Variation promoted to the main line.", { tone: "success" });
}

/** Deletes the current variation branch and steps the cursor to its parent. */
function deleteVariation() {
  const cur = session.currentNode;
  if (!cur.parent || isOnMainLine(cur)) return;

  const branchRoot = etBranchRoot(cur);
  const parent = branchRoot.parent;
  if (!parent) return;

  parent.children = parent.children.filter((c) => c !== branchRoot);
  etPurgeIndex(branchRoot);

  session.currentNode = parent;
  session.fen = parent.fenAfter;
  resetBoardTo(boardCtx, parent.fenAfter);
  clearCheckHighlight();
  highlightCheck(boardCtx.chess);
  hideHint();
  updateHistory();
  updateHintButton();
  updateVariationButtons();
  refreshEval();
  setStatus("Variation deleted.", { tone: "info" });
}

function cleanupBoard() {
  if (boardCtx) {
    boardCtx.destroy();
    boardCtx = null;
  }
}

function close() {
  cleanupBoard();
  session = null;
  const modal = document.getElementById("trainingModal");
  if (modal) modal.classList.add("hidden");
  onClose?.();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

