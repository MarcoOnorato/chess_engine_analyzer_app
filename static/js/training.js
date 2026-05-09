/**
 * @fileoverview Training feature — public entry point and orchestrator.
 *
 * Public API:
 *   openTrainingModal()    — open the training overlay (called from "Start
 *                             Training" button after a PGN is loaded).
 *   renderTrainingModal()  — alias, kept for backwards compatibility.
 *
 * Orchestration responsibilities:
 *   - Build a fresh `Session` object.
 *   - Show the right screen for each phase (delegating to training-ui.js).
 *   - When entering PLAYING phase, mount a chessboard.js instance, fetch
 *     the initial engine top moves, and wait for user moves.
 *   - On each user move, validate it against the cached engine top moves
 *     (locally — no extra round trip). On accept, simulate opponent reply
 *     and advance until depth K is reached. On reject, escalate hints.
 *   - On scenario end, store the outcome and offer the next.
 *
 * The orchestrator never imports state from the main app for *writing* —
 * only `mainLineNodes()` is read by `training-selectors` to discover
 * candidate positions. The user's main game tree is therefore preserved
 * 1:1 through the entire training session.
 */

import {
  PHASES,
  createSession,
  resetPositionState,
  hasMoreScenarios,
} from "./training-session.js";
import { getModeHandler } from "./training-modes.js";
import {
  setHeader,
  renderModeSelect,
  renderConfigScreen,
  renderPositionList,
  renderPlayingScreen,
  renderResults,
  setStatus,
  setMovesPlayed,
  setEvalBar,
  showHintPrompt,
  hideHintPrompt,
  renderTrainingHistory,
} from "./training-ui.js";
import {
  mountTrainingBoard,
  fetchEngineMoves,
  isAcceptableMove,
  pickOpponentReply,
  playOpponentMove,
  resetBoardTo,
  showHistoryToast,
} from "./training-board.js";
import {
  clearHints,
  highlightSourceSquares,
  drawHintArrows,
} from "./training-hints.js";

/** @type {import("./training-session.js").Session | null} */
let session = null;

/** @type {{ board:any, chess:any, destroy:()=>void } | null} */
let boardCtx = null;

/** Outcomes accumulated as scenarios are completed. */
let outcomes = [];

/**
 * Navigable history cursor.
 *
 * -1  → "live" position (always follows the latest board state).
 * ≥ 0 → index into the flat allMoves array (preceding + session moves).
 *
 * BUG FIX: previously `jumpToHistoryIndex` replayed from `new Chess()`
 * (starting position), which ignored the scenario FEN. Now we always
 * replay from `spec.fen` using only the *session* moves, and map the
 * flat allMoves index back to a session-move count correctly.
 */
let viewIndex = -1;

/* ==========================================================================
   Public entry
   ========================================================================== */

/** Backwards-compatible alias used by pgn.js. */
export function renderTrainingModal() {
  openTrainingModal();
}

export function openTrainingModal() {
  const modal = document.getElementById("trainingModal");
  if (!modal) {
    console.error("trainingModal element missing from DOM");
    return;
  }
  session = createSession();
  outcomes = [];
  modal.classList.remove("hidden");
  goToPhase(PHASES.MODE_SELECT);
}

/* ==========================================================================
   Phase router
   ========================================================================== */

function goToPhase(phase) {
  session.phase = phase;
  setHeader(headerLabelFor(phase), exitTraining);

  switch (phase) {
    case PHASES.MODE_SELECT:
      renderModeSelect({ selectMode });
      break;
    case PHASES.CONFIG:
      renderConfigScreen({
        session,
        applyConfig,
        goToPositionList: prepareScenarios,
      });
      break;
    case PHASES.POSITION_LIST:
      renderPositionList({
        session,
        startScenario,
        goBackConfig: () => goToPhase(PHASES.CONFIG),
      });
      break;
    case PHASES.PLAYING:
      // Render is handled inside `startScenario`.
      break;
    case PHASES.RESULTS:
      renderResults({
        session,
        outcomes,
        exitTraining,
        restart: () => {
          session = createSession();
          outcomes = [];
          goToPhase(PHASES.MODE_SELECT);
        },
      });
      break;
  }
}

function headerLabelFor(phase) {
  switch (phase) {
    case PHASES.MODE_SELECT:    return "Choose a training mode";
    case PHASES.CONFIG:         return "Session settings";
    case PHASES.POSITION_LIST:  return "Scenarios";
    case PHASES.PLAYING:
      return `Scenario ${session.currentPositionIdx + 1} / ${session.positions.length}`;
    case PHASES.RESULTS:        return "Session complete";
  }
}

/* ==========================================================================
   Phase transitions (called from UI)
   ========================================================================== */

function selectMode(modeId) {
  session.mode = modeId;
  goToPhase(PHASES.CONFIG);
}

function applyConfig(patch) {
  if (patch.userColor) session.userColor = patch.userColor;
  if (patch.config)    session.config    = patch.config;
  if (patch.phase)     goToPhase(patch.phase);
}

function prepareScenarios() {
  const handler = getModeHandler(session.mode);
  session.positions = handler.pickPositions({
    userColor: session.userColor,
    max: session.config.maxPositions,
  });
  session.currentPositionIdx = 0;
  goToPhase(PHASES.POSITION_LIST);
}

/* ==========================================================================
   Scenario lifecycle
   ========================================================================== */

async function startScenario(idx) {
  session.currentPositionIdx = idx;
  resetPositionState(session);
  viewIndex = -1;

  goToPhase(PHASES.PLAYING);
  // The playing phase is rendered here (not inside goToPhase) so we can
  // pass the live `session` reference that already has the correct idx.
  renderPlayingScreen({
    session,
    skipScenario,
    onNavigate: (type) => handleNavigation(type),
  });

  const spec = session.positions[idx];
  session.fen = spec.fen;

  // Tear down previous training board if any.
  if (boardCtx) boardCtx.destroy();

  // Wait one frame so the browser finishes laying out the freshly inserted
  // DOM (the board host needs a real width before chessboard.js measures it).
  await new Promise((r) => requestAnimationFrame(r));

  boardCtx = mountTrainingBoard({
    fen: session.fen,
    orientation: session.userColor,
    onUserMove: handleUserMove,
    isLive: () => viewIndex === -1,
  });

  updateHistoryUI();
  setStatus("Fetching engine analysis…", { tone: "info" });

  // Mode hook: WHAT-IF auto-plays opponent's "what if I'd been correct" move.
  await getModeHandler(session.mode).onScenarioStart(session, { boardCtx });

  // Resilience baseline = pre-move eval at this FEN.
  await primeBaselineAndExpected();

  promptUserToMove();
}

function filterMatePreservingMoves(moves) {
  if (!moves?.length) return [];

  // mate lines
  const mateMoves = moves.filter(m => m.mate != null);

  if (mateMoves.length === 0) {
    return moves;
  }

  /*
    Stockfish:
    +N -> mate for the side to move
    -N -> mate if the side to move is gonna be mated

    POSITIVE = shorter mate
    NEGATIVE = delay mate for the most possible amount of moves
  */

  const bestMate = mateMoves.reduce((best, move) => {
    if (best == null) return move.mate;

    // Winning mate
    if (move.mate > 0 && best > 0) {
      return Math.min(best, move.mate);
    }

    // Losing Mate
    if (move.mate < 0 && best < 0) {
      return Math.max(best, move.mate);
    }

    // Edge cases
    return best;
  }, null);

  return mateMoves.filter(m => m.mate === bestMate);
}

/**
 * Loads engine analysis for the current FEN, stashes the engine top moves
 * for legality-checking, and updates the eval bar.
 */
async function primeBaselineAndExpected() {
  try {
    const data = await fetchEngineMoves(session.fen);
    session.expectedTopMoves = filterMatePreservingMoves(data.top_moves || []);
    setEvalBar(data.eval, data.eval_mate);
    if (session.baselineEval == null) {
      session.baselineEval = signedForUser(data.eval);
    }
  } catch (e) {
    console.error("Engine analysis failed", e);
    setStatus("Engine analysis failed. Skip scenario.", { tone: "error" });
  }
}

function promptUserToMove() {
  if (!session.expectedTopMoves.length) {
    setStatus("Position has no legal moves — scenario complete.", { tone: "info" });
    finishScenario();
    return;
  }
  const remaining = session.config.depthK - session.movesPlayed;
  setStatus(
    `Your move. ${remaining} move${remaining === 1 ? "" : "s"} left in this scenario.`,
    { tone: "info" }
  );
}

/* ==========================================================================
   User move handling
   ========================================================================== */

async function handleUserMove(uci, san, fenAfter) {
  const ok = isAcceptableMove(uci, session.expectedTopMoves, session.config);

  if (!ok) {
    handleWrongMove(uci);
    return;
  }

  // Accepted — update counters and continue.
  if (session.attempts === 0 && session.hintLevel === 0) {
    session.score.correctFirstTry++;
  } else {
    session.score.correctWithHints++;
  }

  session.attempts = 0;
  session.hintLevel = 0;
  hideHintPrompt();
  clearHints(document.getElementById("trainingBoard"));

  session.fen = fenAfter;
  session.movesPlayed++;
  setMovesPlayed(session.movesPlayed);
  updateHistoryUI();
  setStatus(`Good — ${san}. Opponent thinking…`, { tone: "success" });

  if (session.movesPlayed >= session.config.depthK) {
    await afterFinalUserMove();
    return;
  }

  await playOpponentTurn();
}

/**
 * After the user's last counted move (#K), refresh eval and finalize
 * scenario. We don't make the opponent reply — the K-th move is the
 * user's contribution and the eval after it is the outcome.
 */
async function afterFinalUserMove() {
  const data = await fetchEngineMoves(session.fen);
  setEvalBar(data.eval, data.eval_mate);
  session.finalEval = signedForUser(data.eval);
  finishScenario();
}

async function playOpponentTurn() {
  try {
    const data = await fetchEngineMoves(session.fen);
    setEvalBar(data.eval, data.eval_mate);
    const reply = pickOpponentReply(data.top_moves || [], session.config);
    if (!reply) {
      // No legal moves → game over (mate or stalemate).
      session.finalEval = signedForUser(data.eval);
      finishScenario();
      return;
    }
    // Short delay so the move feels played, not teleported.
    await delay(900);
    const move = playOpponentMove(boardCtx, reply);
    const san  = move ? move.san : reply;
    session.fen = boardCtx.chess.fen();
    updateHistoryUI();
    setStatus(`Opponent: ${san}`, { tone: "info" });

    await delay(600);
    await primeBaselineAndExpected();
    promptUserToMove();
  } catch (e) {
    console.error("Opponent turn failed", e);
    setStatus("Engine error during opponent reply.", { tone: "error" });
  }
}

/* ==========================================================================
   Wrong-move handling + hint escalation
   ========================================================================== */

function handleWrongMove(uci) {
  session.attempts++;

  // Always rewind the board so the user faces the same position again.
  resetBoardTo(boardCtx, session.fen);
  clearHints(document.getElementById("trainingBoard"));

  if (session.attempts === 1) {
    setStatus("Not the engine's choice. Try again.", { tone: "warning" });
    return;
  }

  if (session.attempts === 2) {
    session.hintLevel = 1;
    session.score.hintsUsed++;
    setStatus(
      "Still not it — I've highlighted the squares you should consider moving from.",
      { tone: "warning" }
    );
    highlightSourceSquares(
      document.getElementById("trainingBoard"),
      session.expectedTopMoves
    );
    return;
  }

  // attempts ≥ 3 → ask before drawing arrows.
  setStatus("Three tries used. Take a hint?", { tone: "warning" });
  showHintPrompt(
    () => {
      session.hintLevel = 2;
      session.score.hintsUsed++;
      drawHintArrows(
        document.getElementById("trainingBoard"),
        session.expectedTopMoves,
        session.userColor
      );
      setStatus("Hint shown. Play one of the highlighted moves.", { tone: "info" });
    },
    () => {
      setStatus("Keep trying — no arrows shown.", { tone: "info" });
    }
  );
}

/* ==========================================================================
   Scenario completion
   ========================================================================== */

function finishScenario() {
  const handler = getModeHandler(session.mode);
  const outcome = handler.evaluateOutcome(session);
  outcomes.push({
    spec: session.positions[session.currentPositionIdx],
    headline: outcome.headline,
    detail: outcome.detail,
  });
  session.score.scenariosCompleted++;

  if (!hasMoreScenarios(session)) {
    showInlineScenarioOutcome(outcome);
    setTimeout(() => goToPhase(PHASES.RESULTS), 1500);
    return;
  }

  // Give a "Next" button embedded in the status area.
  const status = document.getElementById("trainingStatus");
  if (!status) return;
  status.className = "training-status-box tone-success";
  status.innerHTML = "";
  const head = document.createElement("div");
  head.innerHTML = `<b>${escapeHtml(outcome.headline)}</b><br>${escapeHtml(outcome.detail || "")}`;
  status.appendChild(head);
  const nextBtn = document.createElement("button");
  nextBtn.className = "training-cta";
  nextBtn.style.marginTop = "12px";
  nextBtn.textContent = "Next scenario →";
  nextBtn.onclick = () => startScenario(session.currentPositionIdx + 1);
  status.appendChild(nextBtn);
}

function showInlineScenarioOutcome(outcome) {
  setStatus(`${outcome.headline} — ${outcome.detail || ""}`, { tone: "success" });
}

function skipScenario() {
  session.score.failed++;
  outcomes.push({
    spec: session.positions[session.currentPositionIdx],
    headline: "Skipped",
    detail: "",
  });
  if (hasMoreScenarios(session)) {
    startScenario(session.currentPositionIdx + 1);
  } else {
    goToPhase(PHASES.RESULTS);
  }
}

/* ==========================================================================
   Exit
   ========================================================================== */

function exitTraining() {
  if (
    session &&
    session.phase === PHASES.PLAYING &&
    !confirm("Return to main game? Your training session will be discarded.")
  ) {
    return;
  }

  // Clean up keyboard listener attached by renderPlayingScreen
  const modalBody = document.getElementById("trainingModalBody");
  if (modalBody && modalBody._keyHandler) {
    document.removeEventListener("keydown", modalBody._keyHandler);
    modalBody._keyHandler = null;
  }

  if (boardCtx) {
    boardCtx.destroy();
    boardCtx = null;
  }
  outcomes = [];
  session = null;

  const modal = document.getElementById("trainingModal");
  if (modal) modal.classList.add("hidden");
}

/* ==========================================================================
   History navigation
   ========================================================================== */

/**
 * Rebuilds the history panel and syncs the board to `currentViewIdx`.
 */
function updateHistoryUI() {
  const spec        = session.positions[session.currentPositionIdx];
  const past        = spec.precedingMoves || [];
  const sessionMvs  = boardCtx ? boardCtx.chess.history() : [];
  const all         = [...past, ...sessionMvs];
  const activeIdx   = viewIndex === -1 ? all.length - 1 : viewIndex;

  renderTrainingHistory(past, sessionMvs, activeIdx, (targetIdx) => {
    jumpToHistoryIndex(targetIdx);
  });
}

/**
 * Navigates the board display to the position after `idx`-th move in the
 * flat allMoves array (preceding + session moves).
 *
 * FIX: We always reconstruct the position by starting from `spec.fen`
 * (the scenario starting FEN) and replaying only the *session* moves up to
 * the requested point. The preceding moves are already baked into spec.fen,
 * so we must NOT replay them again.
 *
 * Special case: if `idx` points into the "preceding" portion (i.e. the user
 * clicked on a context move before the scenario started), we replay
 * backwards from spec.fen using a temporary chess.js instance seeded from
 * spec.fen, then step *back* by playing the missing session moves from the
 * scenario-start FEN. Actually it is simpler: preceding moves lived before
 * spec.fen, so we build a full replay from the game start FEN using all
 * allMoves[:idx+1]. We obtain the "game start FEN" from the furthest
 * ancestor of the first preceding move: standard starting FEN for now
 * (training-selectors always starts from the main-line root which is
 * standard start or a loaded PGN starting FEN). We store it on the spec
 * in training-selectors.js as `startFen` when available; fall back to
 * standard start.
 *
 * @param {number} idx  Flat index into allMoves (0-based). -1 = live end.
 */
function jumpToHistoryIndex(idx) {
  const spec        = session.positions[session.currentPositionIdx];
  const past        = spec.precedingMoves || [];
  const sessionMvs  = boardCtx ? boardCtx.chess.history() : [];
  const allMoves    = [...past, ...sessionMvs];
  const total       = allMoves.length;

  // Clamp
  if (idx < 0)      idx = -1;
  if (idx >= total) idx = -1;

  viewIndex = idx;

  const targetCount = idx === -1 ? total : idx + 1;

  // ---- Determine what to replay and from which starting FEN ----
  //
  // The preceding moves in `past` are the moves that were played in the
  // original game *before* the scenario FEN. spec.fen already encodes the
  // position AFTER all those moves. So:
  //
  //   • If targetCount <= past.length  →  user clicked on a context move.
  //     We must start from a position before spec.fen. The only reliable
  //     way is to replay from the game's root FEN through all preceding
  //     moves. We use spec.rootFen if available, otherwise STARTING_FEN.
  //
  //   • If targetCount > past.length   →  user clicked on a session move
  //     (or wants the live end). Start from spec.fen and replay only the
  //     session moves up to (targetCount - past.length).

  let tempChess;

  if (targetCount <= past.length) {
    // Replay context moves from root
    const rootFen = spec.rootFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    tempChess = new Chess(rootFen);
    for (let i = 0; i < targetCount; i++) {
      const result = tempChess.move(allMoves[i]);
      if (!result) {
        console.warn("jumpToHistoryIndex: illegal preceding move", allMoves[i], tempChess.fen());
        break;
      }
    }
  } else {
    // Replay session moves from the scenario FEN
    const sessionMovesNeeded = targetCount - past.length;
    tempChess = new Chess(spec.fen);
    for (let i = 0; i < sessionMovesNeeded; i++) {
      const result = tempChess.move(sessionMvs[i]);
      if (!result) {
        console.warn("jumpToHistoryIndex: illegal session move", sessionMvs[i], tempChess.fen());
        break;
      }
    }
  }

  boardCtx.board.position(tempChess.fen());
  updateHistoryUI();
}

/**
 * Handles the four navigation button types (first / prev / next / last).
 */
function handleNavigation(type) {
  const spec  = session.positions[session.currentPositionIdx];
  const total = (spec.precedingMoves?.length || 0) + (boardCtx?.chess.history().length || 0);
  const current = viewIndex === -1 ? total - 1 : viewIndex;

  switch (type) {
    case "first": jumpToHistoryIndex(0);         break;
    case "last":  jumpToHistoryIndex(-1);        break;
    case "prev":  jumpToHistoryIndex(current - 1); break;
    case "next": {
      if (current < total - 1) {
        jumpToHistoryIndex(current + 1);
      } else {
        jumpToHistoryIndex(-1); // already at end → stay live
      }
      break;
    }
  }
}

/* ==========================================================================
   Tiny helpers
   ========================================================================== */

function signedForUser(evalWhitePOV) {
  if (evalWhitePOV == null) return null;
  return session.userColor === "white" ? evalWhitePOV : -evalWhitePOV;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
