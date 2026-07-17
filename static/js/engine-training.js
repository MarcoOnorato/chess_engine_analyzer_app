/**
 * @fileoverview Free-play training against the engine.
 *
 * Sources: new game, current loaded main line, opening, pasted PGN, Lichess,
 * and Chess.com. The selected ply becomes the starting position.
 */

import { STARTING_FEN, mainLineNodes, state } from "./state.js";
import { api } from "./api.js";
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

export function openEngineTrainingModal() {
  const modal = document.getElementById("trainingModal");
  if (!modal) return;

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

  const sourceRow = el("div", "tap-platform-row");
  sourceRow.style.flexWrap = "wrap";
  const sources = [
    { id: "new", label: "New game" },
    { id: "current", label: "Loaded game" },
    { id: "opening", label: "Opening" },
    { id: "pgn", label: "Paste PGN" },
    { id: "lichess", label: "Lichess" },
    { id: "chesscom", label: "Chess.com" },
  ];
  const sourceBtns = {};
  let source = "new";

  sources.forEach(({ id, label }) => {
    const b = el("button", "tap-platform-btn" + (id === source ? " active" : ""));
    b.textContent = label;
    b.style.setProperty("--platform-color", "#26bbff");
    b.onclick = () => {
      source = id;
      Object.values(sourceBtns).forEach((btn) => btn.classList.remove("active"));
      b.classList.add("active");
      clearSelectedPgn();
      renderSourceFields(sourceFields, source);
    };
    sourceBtns[id] = b;
    sourceRow.appendChild(b);
  });
  wrap.appendChild(sourceRow);

  const sourceFields = el("div", "tap-import-wrap");
  sourceFields.style.maxWidth = "100%";
  sourceFields.style.padding = "0";
  renderSourceFields(sourceFields, source);
  wrap.appendChild(sourceFields);

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
      const sourceData = await resolveSource(source);
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

  root.appendChild(wrap);
}

function renderSourceFields(root, source) {
  root.innerHTML = "";

  if (source === "new") {
    root.appendChild(infoBox("Start from the normal initial position. Ply 0 is a new game."));
    return;
  }

  if (source === "current") {
    const count = mainLineNodes().length;
    root.appendChild(infoBox(
      count > 0
        ? `Use the currently loaded main line. Available ply range: 0-${count}.`
        : "No PGN/opening is currently loaded. This will fall back to a new game."
    ));
    return;
  }

  if (source === "opening") {
    root.appendChild(labeledInput("Opening search", "et-opening-search", "text", "Type part of the opening name…"));
    const list = el("div", "engine-source-list");
    list.id = "et-opening-list";
    list.innerHTML = "<div class='dim'>Type to search openings.</div>";
    root.appendChild(list);
    document.getElementById("et-opening-search").addEventListener("input", renderOpeningChoices);
    loadOpeningCache().then(renderOpeningChoices).catch(() => {
      list.innerHTML = "<div class='tap-error'>Could not load openings.</div>";
    });
    return;
  }

  if (source === "pgn") {
    root.appendChild(labeledTextarea("PGN", "et-pgn", "Paste a PGN here…"));
    return;
  }

  if (source === "lichess") {
    root.appendChild(labeledInput("Lichess username", "et-li-user", "text", "username"));
    const count = labeledInput("Games to show", "et-li-count", "number", "10");
    count.querySelector("input").value = "10";
    root.appendChild(count);
    root.appendChild(fetchListButton("Fetch Lichess games", fetchLichessChoices));
    root.appendChild(gameList("et-remote-games"));
    return;
  }

  if (source === "chesscom") {
    root.appendChild(labeledInput("Chess.com username", "et-cc-user", "text", "username"));
    const extras = el("div", "tap-extra-fields");
    const now = new Date();
    const year = labeledInput("Year", "et-cc-year", "number", String(now.getFullYear()));
    const month = labeledInput("Month", "et-cc-month", "number", String(now.getMonth() + 1));
    year.querySelector("input").value = String(now.getFullYear());
    month.querySelector("input").value = String(now.getMonth() + 1);
    extras.appendChild(year);
    extras.appendChild(month);
    root.appendChild(extras);
    root.appendChild(fetchListButton("Fetch Chess.com games", fetchChessComChoices));
    root.appendChild(gameList("et-remote-games"));
  }
}

async function resolveSource(source) {
  if (source === "new") {
    return { label: "New game", startFen: STARTING_FEN, fens: [STARTING_FEN], moves: [] };
  }

  if (source === "current") {
    const nodes = mainLineNodes();
    if (!nodes.length) return resolveSource("new");
    return {
      label: "Loaded game",
      startFen: state.root.fenAfter,
      fens: [state.root.fenAfter, ...nodes.map((n) => n.fenAfter)],
      moves: nodes.map((n) => ({ san: n.san, uci: n.uci })),
    };
  }

  if (source === "opening") {
    const pgn = document.getElementById("et-selected-pgn")?.value || "";
    if (!pgn) throw new Error("Select an opening first.");
    return parsePgnSource(pgn, "Opening");
  }

  if (source === "pgn") {
    const pgn = document.getElementById("et-pgn")?.value?.trim();
    if (!pgn) throw new Error("Paste a PGN first.");
    return parsePgnSource(pgn, "PGN");
  }

  const selected = document.getElementById("et-selected-pgn")?.value || "";
  if (!selected) throw new Error("Fetch and select a game first.");
  return parsePgnSource(selected, source === "lichess" ? "Lichess game" : "Chess.com game");
}

async function parsePgnSource(pgn, label) {
  const data = await api("/api/load_pgn", { pgn });
  const startFen = data.start_fen || data.fens?.[0] || STARTING_FEN;
  return {
    label,
    startFen,
    fens: data.fens?.length ? data.fens : [startFen],
    moves: data.moves || [],
  };
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
}

async function loadOpeningCache() {
  if (state.cachedOpenings && Object.keys(state.cachedOpenings).length) return state.cachedOpenings;
  const res = await fetch("/api/list_openings");
  if (!res.ok) throw new Error("Opening list failed");
  state.cachedOpenings = await res.json();
  return state.cachedOpenings;
}

function renderOpeningChoices() {
  const list = document.getElementById("et-opening-list");
  const query = (document.getElementById("et-opening-search")?.value || "").toLowerCase();
  if (!list) return;
  list.innerHTML = "";

  const entries = Object.entries(state.cachedOpenings || {})
    .filter(([name]) => name.toLowerCase().includes(query))
    .slice(0, 30);

  if (!entries.length) {
    list.innerHTML = "<div class='dim'>No openings found.</div>";
    return;
  }

  ensureSelectedPgnInput();
  entries.forEach(([name, pgn]) => {
    const pgnString = Array.isArray(pgn) ? pgn[0] : pgn;
    const item = el("button", "engine-source-item");
    item.type = "button";
    item.innerHTML = `<span>${escapeHtml(name)}</span><small>${escapeHtml(String(pgnString).slice(0, 80))}…</small>`;
    item.onclick = () => {
      document.getElementById("et-selected-pgn").value = pgnString;
      list.querySelectorAll(".engine-source-item").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
    };
    list.appendChild(item);
  });
}

async function fetchLichessChoices() {
  const username = document.getElementById("et-li-user")?.value?.trim();
  const count = document.getElementById("et-li-count")?.value || "10";
  if (!username) return;
  const list = document.getElementById("et-remote-games");
  list.innerHTML = "<div class='dim'>Fetching…</div>";
  const res = await fetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${encodeURIComponent(count)}&pgnInJson=true`,
    { headers: { Accept: "application/x-ndjson" } }
  );
  if (!res.ok) throw new Error("Lichess fetch failed");
  const text = await res.text();
  const games = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((g) => g.pgn);
  renderRemoteGames(games.map((g) => ({
    pgn: g.pgn,
    label: `${g.players.white.user?.name || "Anonymous"} vs ${g.players.black.user?.name || "Anonymous"}`,
    meta: `${new Date(g.createdAt).toLocaleDateString()} • ${g.speed} • ${g.variant}`,
  })));
}

async function fetchChessComChoices() {
  const username = document.getElementById("et-cc-user")?.value?.trim();
  const year = document.getElementById("et-cc-year")?.value;
  const month = String(document.getElementById("et-cc-month")?.value || "").padStart(2, "0");
  if (!username || !year || !month) return;
  const list = document.getElementById("et-remote-games");
  list.innerHTML = "<div class='dim'>Fetching…</div>";
  const res = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${year}/${month}`
  );
  if (!res.ok) throw new Error("Chess.com fetch failed");
  const data = await res.json();
  const games = (data.games || []).reverse().filter((g) => g.pgn);
  renderRemoteGames(games.map((g) => ({
    pgn: g.pgn,
    label: `${g.white.username} vs ${g.black.username}`,
    meta: `${new Date(g.end_time * 1000).toLocaleDateString()} • ${g.time_class}`,
  })));
}

function renderRemoteGames(games) {
  const list = document.getElementById("et-remote-games");
  list.innerHTML = "";
  ensureSelectedPgnInput();
  if (!games.length) {
    list.innerHTML = "<div class='dim'>No games found.</div>";
    return;
  }
  games.forEach((g) => {
    const item = el("button", "engine-source-item");
    item.type = "button";
    item.innerHTML = `<span>${escapeHtml(g.label)}</span><small>${escapeHtml(g.meta)}</small>`;
    item.onclick = () => {
      document.getElementById("et-selected-pgn").value = g.pgn;
      list.querySelectorAll(".engine-source-item").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
    };
    list.appendChild(item);
  });
}

function ensureSelectedPgnInput() {
  if (document.getElementById("et-selected-pgn")) return;
  const input = el("input", "");
  input.type = "hidden";
  input.id = "et-selected-pgn";
  body().appendChild(input);
}

function clearSelectedPgn() {
  const existing = document.getElementById("et-selected-pgn");
  if (existing) existing.remove();
}

function fetchListButton(label, fn) {
  const btn = el("button", "training-cta tap-fetch-btn");
  btn.type = "button";
  btn.textContent = label;
  btn.onclick = async () => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "Fetching…";
    try {
      await fn();
    } catch (e) {
      const list = document.getElementById("et-remote-games");
      if (list) list.innerHTML = `<div class="tap-error">Error: ${escapeHtml(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  return btn;
}

function gameList(id) {
  const list = el("div", "engine-source-list");
  list.id = id;
  list.innerHTML = "<div class='dim'>Fetch games, then select one.</div>";
  return list;
}

function infoBox(text) {
  const div = el("div", "training-fieldset");
  div.textContent = text;
  return div;
}

function selectField(label, id, options, value) {
  const wrap = el("div", "tap-field");
  const lbl = el("label", "tap-label");
  lbl.textContent = label;
  lbl.htmlFor = id;
  const sel = el("select", "tap-input");
  sel.id = id;
  options.forEach(([val, text]) => {
    const opt = el("option", "");
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    sel.appendChild(opt);
  });
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

function labeledInput(labelText, id, type, placeholder) {
  const wrap = el("div", "tap-field");
  const lbl = el("label", "tap-label");
  lbl.textContent = labelText;
  lbl.htmlFor = id;
  const inp = el("input", "tap-input");
  inp.id = id;
  inp.type = type;
  inp.placeholder = placeholder;
  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  return wrap;
}

function labeledTextarea(labelText, id, placeholder) {
  const wrap = el("div", "tap-field");
  const lbl = el("label", "tap-label");
  lbl.textContent = labelText;
  lbl.htmlFor = id;
  const txt = el("textarea", "tap-input");
  txt.id = id;
  txt.rows = 8;
  txt.placeholder = placeholder;
  wrap.appendChild(lbl);
  wrap.appendChild(txt);
  return wrap;
}

function showErr(box, msg) {
  box.textContent = msg;
  box.classList.remove("hidden");
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
