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

/** Navigable history index */
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
    case PHASES.MODE_SELECT:
      return "Choose a training mode";
    case PHASES.CONFIG:
      return "Session settings";
    case PHASES.POSITION_LIST:
      return "Scenarios";
    case PHASES.PLAYING:
      return `Scenario ${session.currentPositionIdx + 1} / ${session.positions.length}`;
    case PHASES.RESULTS:
      return "Session complete";
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
  if (patch.config) session.config = patch.config;
  if (patch.phase) goToPhase(patch.phase);
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
  goToPhase(PHASES.PLAYING);
  // The render is in PHASES.PLAYING — call it explicitly because we route
  // there programmatically.
  renderPlayingScreen({ session, skipScenario, onNavigate: (type) => handleNavigation(type)});

  const spec = session.positions[idx];
  session.fen = spec.fen;

  // Tear down previous training board if any.
  if (boardCtx) boardCtx.destroy();

  // Wait one frame so the browser finishes laying out the freshly inserted
  // DOM (the board host needs a real width before chessboard.js measures
  // it — otherwise we'd get a tiny board).
  await new Promise((r) => requestAnimationFrame(r));

  boardCtx = mountTrainingBoard({
    fen: session.fen,
    orientation: session.userColor,
    onUserMove: handleUserMove,
  });

  updateHistoryUI();
  setStatus("Fetching engine analysis…", { tone: "info" });

  // Mode hook: WHAT-IF auto-plays opponent's "what if I'd been correct" move.
  await getModeHandler(session.mode).onScenarioStart(session, { boardCtx });

  // Resilience baseline = pre-move eval at this FEN.
  await primeBaselineAndExpected();

  promptUserToMove();
}

/**
 * Loads engine analysis for the current FEN, stashes the engine top moves
 * for legality-checking, and updates the eval bar.
 */
async function primeBaselineAndExpected() {
  try {
    const data = await fetchEngineMoves(session.fen);
    session.expectedTopMoves = data.top_moves || [];
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
    setStatus("Position has no legal moves — scenario complete.", {
      tone: "info",
    });
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

  if (viewIndex !== -1) {
    viewIndex = -1;
  }

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
  // Reset per-move hint state (carries across scenarios but not within).
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
 * scenario. We don't make the opponent reply at that point — the K-th
 * move is the user's contribution and the eval after it is the outcome.
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
      // No legal moves left → game over (mate or stalemate).
      session.finalEval = signedForUser(data.eval);
      finishScenario();
      return;
    }
    // Tiny delay so the move feels played, not pasted.
    await delay(900);
    const move = playOpponentMove(boardCtx, reply);
    const san  = move ? move.san : reply;
    session.fen = boardCtx.chess.fen();
    updateHistoryUI();
    setStatus(`Opponent: ${san}`, { tone: "info" });

    // Now refresh expected moves for the user's next attempt.
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

  // attempts >= 3 → ask before drawing arrows.
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
      setStatus("Hint shown. Play one of the highlighted moves.", {
        tone: "info",
      });
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

  showInlineScenarioOutcome(outcome);

  // Auto-advance after a beat, unless this was the last.
  if (!hasMoreScenarios(session)) {
    setTimeout(() => goToPhase(PHASES.RESULTS), 1500);
    return;
  }

  // Otherwise, give a "Next" button.
  const status = document.getElementById("trainingStatus");
  if (!status) return;
  status.innerHTML = "";
  const head = document.createElement("div");
  head.innerHTML = `<b>${escapeHtml(outcome.headline)}</b><br>${escapeHtml(outcome.detail || "")}`;
  status.appendChild(head);
  const nextBtn = document.createElement("button");
  nextBtn.className = "training-cta";
  nextBtn.style.marginTop = "12px";
  nextBtn.textContent = `Next scenario →`;
  nextBtn.onclick = () => startScenario(session.currentPositionIdx + 1);
  status.appendChild(nextBtn);
}

function showInlineScenarioOutcome(outcome) {
  setStatus(`${outcome.headline} — ${outcome.detail || ""}`, {
    tone: "success",
  });
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
  // If mid-scenario, ask before bailing — except on the results screen.
  if (
    session &&
    session.phase === PHASES.PLAYING &&
    !confirm("Return to main game? Your training session will be discarded.")
  ) {
    return;
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

function updateHistoryUI() {
  const spec = session.positions[session.currentPositionIdx];
  const past = spec.precedingMoves || [];
  const sessionMoves = boardCtx ? boardCtx.chess.history() : [];
  const all = [...past, ...sessionMoves];
  const activeIdx = viewIndex === -1 ? all.length - 1 : viewIndex;

  renderTrainingHistory(past, sessionMoves, activeIdx, (targetIdx) => {
    jumpToHistoryIndex(targetIdx);
  });
}

function jumpToHistoryIndex(idx) {
  const spec = session.positions[session.currentPositionIdx];
  const past = spec.precedingMoves || [];
  const sessionMoves = boardCtx ? boardCtx.chess.history() : [];
  const allMoves = [...past, ...sessionMoves];

  if (idx < -1) idx = -1;
  if (idx >= allMoves.length) idx = -1;

  viewIndex = idx;

  // History nav uses a temp chessboard
  const tempChess = new Chess();
  const targetMoveCount = (idx === -1) ? allMoves.length : idx + 1;
  
  // Reset and replay
  tempChess.reset();
  for (let i = 0; i < targetMoveCount; i++) {
    tempChess.move(allMoves[i]);
  }

  boardCtx.board.position(tempChess.fen());
  updateHistoryUI();
}

// Buttons handlers
function handleNavigation(type) {
  const spec = session.positions[session.currentPositionIdx];
  const total = (spec.precedingMoves?.length || 0) + boardCtx.chess.history().length;
  const current = viewIndex === -1 ? total - 1 : viewIndex;

  switch(type) {
    case 'first': jumpToHistoryIndex(0); break;
    case 'last':  jumpToHistoryIndex(-1); break;
    case 'prev':  jumpToHistoryIndex(current - 1); break;
    case 'next':  
        if (viewIndex !== -1 && viewIndex < total - 1) {
            jumpToHistoryIndex(viewIndex + 1);
        } else {
            jumpToHistoryIndex(-1);
        }
        break;
  }
}
