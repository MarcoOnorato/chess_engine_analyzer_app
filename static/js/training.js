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
  setMateMovesLeft,
  setEvalBar,
  setHintPanel,
  renderTrainingHistory,
} from "./training-ui.js";
import {
  mountTrainingBoard,
  fetchEngineMoves,
  isAcceptableMove,
  pickOpponentReply,
  playOpponentMove,
  resetBoardTo,
  highlightCheck,
  clearCheckHighlight,
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
let positionListBackDest = "config";

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

/**
 * Opens the training modal pre-loaded with an externally assembled set of
 * scenarios. Used by the "Train as a Player" pipeline which does its own
 * game import and error classification before reaching the playing phase.
 *
 * @param {{ scenarios: ScenarioSpec[], userColor: "white"|"black", label: string }} opts
 */
export function openTrainingModalWithScenarios({ scenarios, userColor, label, onBack }) {
  const modal = document.getElementById("trainingModal");
  if (!modal) return;
 
  session = createSession();
  outcomes = [];
 
  // Skip MODE_SELECT / CONFIG / POSITION_LIST:
  // inject positions directly and jump to playing.
  session.mode       = "error"; // closest semantic match; mode handler is barely used
  session.userColor  = userColor;
  session.positions  = scenarios;
  session.currentPositionIdx = 0;
 
  modal.classList.remove("hidden");
 
  // Show a position list so the user can see what's coming.
  setHeader(`${label} — ${scenarios.length} scenario(s)`, exitTraining);
 
  // Re-use renderPositionList from training-ui.js with our injected scenarios.
  // Import is already available in training.js via the existing import block.
  renderPositionList({
    session,
    startScenario,
    goBackConfig: () => {
      if (typeof onBack === "function") {
        onBack();
      } else {
        exitTraining();
      }
    },
  });
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
        goToModeSelect: () => goToPhase(PHASES.MODE_SELECT),
      });
      break;
    case PHASES.POSITION_LIST:
      renderPositionList({
        session,
        startScenario,
        goBackConfig: positionListBackDest === "exit"
          ? exitTrainingNoConfirm  // came from playing screen
          : () => goToPhase(PHASES.CONFIG),

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
  let positions = handler.pickPositions({
    userColor: session.userColor,
    max: session.config.maxPositions,
  });

  // Filter out mate scenarios whose forced depth exceeds the configured depthK.
  // A Mate-in-N requires mateForcedDepth = N*2-1 half-moves; playing it with
  // fewer moves available would cut off the mating line mid-sequence.
  positions = positions.filter((p) => {
    if (!p.isMateScenario || p.mateForcedDepth == null) return true;
    return p.mateForcedDepth <= session.config.depthK;
  });

  session.positions = positions;
  session.currentPositionIdx = 0;
  positionListBackDest = "config";
  goToPhase(PHASES.POSITION_LIST);
}

/* ==========================================================================
   Scenario lifecycle
   ========================================================================== */

async function startScenario(idx) {
  session.currentPositionIdx = idx;
  resetPositionState(session);
  session.mateDelivered = false;
  viewIndex = -1;
  
  goToPhase(PHASES.PLAYING);
  renderPlayingScreen({
    session,
    skipScenario,
    onNavigate: (type) => handleNavigation(type),
    onReplay: () => startScenario(session.currentPositionIdx),
    onBackToList: goToScenarioList,
    onRequestHint: handleHintRequest,
  });
  
  const spec = session.positions[idx];
  
  // ── FIX ──────────────────────────────────────────────────────────────
  // Per-scenario color override: "Train as a Player" scenarios carry the
  // side the player had in that specific game. Without this, a scenario
  // from a game where the player was Black would mount the board oriented
  // toward White and block all piece dragging (wrong-turn guard fires).
  if (spec.userColor) session.userColor = spec.userColor;
  // ─────────────────────────────────────────────────────────────────────
  
  session.fen = spec.fen;
  
  if (boardCtx) boardCtx.destroy();
  
  await new Promise((r) => requestAnimationFrame(r));
  
  boardCtx = mountTrainingBoard({
    fen: session.fen,
    orientation: session.userColor,   // now always correct for this scenario
    onUserMove: handleUserMove,
    isLive: () => viewIndex === -1,
  });

  clearCheckHighlight();
  updateHistoryUI();
  setStatus("Fetching engine analysis…", { tone: "info" });
  
  await getModeHandler(session.mode).onScenarioStart(session, { boardCtx });
  // Highlight check after onScenarioStart (which may play an opponent move),
  // so a king already in check at the scenario start gets the red ring.
  highlightCheck(boardCtx.chess);
  await primeBaselineAndExpected();
  promptUserToMove();
}

/**
 * Filters the engine's top-moves list down to moves that are genuinely
 * acceptable at this position — used for both move validation and hints.
 *
 * For mate scenarios, only moves that continue the *shortest* forced mate
 * line are accepted (i.e. winning mates with the minimum mate distance).
 * This prevents the user from playing any mating move and then drifting
 * into a longer mating line instead of the intended one.
 *
 * @param {Array<{uci:string, san:string, score:number|null, mate:number|null}>} moves
 * @param {{ cpTolerance: number }} config
 * @param {"white"|"black"} userColor
 * @param {boolean} [isMateScenario=false]
 * @returns {Array}
 */
function filterAcceptableMoves(moves, config, userColor, isMateScenario = false) {
  if (!moves?.length) return [];

  const isWhite = userColor === "white";

  const isWinningMate = (m) =>
    m.mate != null && (isWhite ? m.mate > 0 : m.mate < 0);

  const isLosingMate = (m) =>
    m.mate != null && (isWhite ? m.mate < 0 : m.mate > 0);

  const winningMates = moves.filter(isWinningMate);
  const losingMates  = moves.filter(isLosingMate);
  const normalMoves  = moves.filter((m) => m.mate == null);

  if (winningMates.length > 0) {
    // Shortest winning mate for the side to move.
    const best = isWhite
      ? Math.min(...winningMates.map((m) => m.mate))
      : Math.max(...winningMates.map((m) => m.mate));

    if (isMateScenario) {
      // Strict: only the exact shortest mate distance is accepted.
      // This ensures the user stays on the intended mating line and
      // cannot "solve" a Mate-in-2 by stumbling into a Mate-in-5.
      return winningMates.filter((m) => m.mate === best);
    }

    // Normal (non-mate) scenario: accept shortest mate only.
    return winningMates.filter((m) => m.mate === best);
  }

  // All moves walk into a losing mate — keep the one that delays it longest.
  if (normalMoves.length === 0 && losingMates.length > 0) {
    const longest = isWhite
      ? Math.max(...losingMates.map((m) => m.mate))
      : Math.min(...losingMates.map((m) => m.mate));
    return losingMates.filter((m) => m.mate === longest);
  }

  const candidates = normalMoves.length > 0 ? normalMoves : moves.slice(0, 1);

  // For mate scenarios with no winning-mate moves available (shouldn't normally
  // happen if the position was correctly identified), fall back to strict top-1.
  if (isMateScenario) {
    return [candidates[0]];
  }

  const best = candidates[0];
  if (best.score == null) return candidates;

  const HARD_DELTA_PAWNS = 1.0;
  const SIGN_FLIP_BUFFER = 0.3;

  const filtered = candidates.filter((m, idx) => {
    if (idx === 0) return true;
    if (m.score == null) return false;

    const delta = Math.abs(best.score - m.score);

    if (delta > HARD_DELTA_PAWNS) return false;

    if (best.score > SIGN_FLIP_BUFFER && m.score < 0) return false;
    if (best.score < -SIGN_FLIP_BUFFER && m.score > 0) return false;

    if (delta * 100 > (config?.cpTolerance ?? 30) * 3) return false;

    return true;
  });

  return filtered.length > 0 ? filtered : [candidates[0]];
}

async function primeBaselineAndExpected() {
  try {
    const data = await fetchEngineMoves(session.fen);
    const spec = session.positions[session.currentPositionIdx];
    session.expectedTopMoves = filterAcceptableMoves(
      data.top_moves || [],
      session.config,
      session.userColor,
      spec?.isMateScenario ?? false
    );
    setEvalBar(data.eval, data.eval_mate, session.userColor);
    if (session.baselineEval == null) {
      session.baselineEval = signedForUser(data.eval);
    }
    // Reset hint panel to idle whenever a new expected-moves set is loaded.
    setHintPanel("idle", [], session.userColor);
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

  const spec = session.positions[session.currentPositionIdx];

  if (spec.isMateScenario) {
    // Count how many user moves remain in the mating line.
    // mateForcedDepth = total half-moves; user moves = ceil(mateForcedDepth/2).
    // Each accepted user move increments session.movesPlayed.
    const totalUserMoves = Math.ceil(spec.mateForcedDepth / 2);
    const userMovesPlayed = Math.floor(session.movesPlayed / 2); // only user half-moves
    const mateMovesLeft = totalUserMoves - userMovesPlayed;
    setStatus(
      `Your move. ${mateMovesLeft} move${mateMovesLeft === 1 ? "" : "s"} to forced checkmate.`,
      { tone: "info" }
    );
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
  setHintPanel("idle", [], session.userColor);
  clearHints(document.getElementById("trainingBoard"));

  session.fen = fenAfter;
  session.movesPlayed++;
  highlightCheck(boardCtx.chess);

  const spec = session.positions[session.currentPositionIdx];
  if (spec.isMateScenario) {
    const totalUserMoves = Math.ceil((spec.mateForcedDepth || 1) / 2);
    const userMovesPlayed = Math.ceil(session.movesPlayed / 2);
    const mateMovesLeft = Math.max(0, totalUserMoves - userMovesPlayed);
    setMateMovesLeft(mateMovesLeft);
  } else {
    setMovesPlayed(session.movesPlayed);
  }

  updateHistoryUI();
  setStatus(`Good — ${san}. Opponent thinking…`, { tone: "success" });

  // Depth check: for mate scenarios use mateForcedDepth; for normal scenarios use depthK.
  const depthLimit = spec.isMateScenario
    ? (spec.mateForcedDepth ?? session.config.depthK)
    : session.config.depthK;

  if (session.movesPlayed >= depthLimit) {
    await afterFinalUserMove();
    return;
  }

  await playOpponentTurn();
}

/**
 * After the user's last counted move (#K), refresh eval and finalize
 * scenario. We don't make the opponent reply — the K-th move is the
 * user's contribution and the eval after it is the outcome.
 *
 * For mate scenarios we skip the eval-delta calculation entirely and
 * instead flag whether checkmate was actually delivered.
 */
async function afterFinalUserMove() {
  const spec = session.positions[session.currentPositionIdx];

  if (spec.isMateScenario) {
    // Check whether the current position is checkmate (game over).
    const isCheckmate = boardCtx?.chess?.in_checkmate?.() ?? false;
    // Store a sentinel so evaluateOutcome can detect the mate case.
    session.finalEval = null;
    session.mateDelivered = isCheckmate;
    finishScenario();
    return;
  }

  const data = await fetchEngineMoves(session.fen);
  setEvalBar(data.eval, data.eval_mate, session.userColor);
  // BUG FIX: finalEval must use eval (user-POV), not eval_mate.
  // eval_mate is a separate field (mate-in-N integer) and must never be
  // mixed into the pawn-unit delta calculation.
  session.finalEval = signedForUser(data.eval ?? null);
  finishScenario();
}

async function playOpponentTurn() {
  try {
    const data = await fetchEngineMoves(session.fen);
    setEvalBar(data.eval, data.eval_mate, session.userColor);
    const reply = pickOpponentReply(data.top_moves || [], session.config);
    if (!reply) {
      // No legal moves → game over (mate or stalemate).
      const spec = session.positions[session.currentPositionIdx];
      if (spec.isMateScenario) {
        session.finalEval = null;
        session.mateDelivered = boardCtx?.chess?.in_checkmate?.() ?? false;
      } else {
        session.finalEval = signedForUser(data.eval ?? null);
      }
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
    highlightCheck(boardCtx.chess);

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

/**
 * Updates the always-visible hint panel in the playing screen.
 * @param {"idle"|"squares"|"arrows"} level
 */
function updateHintPanel(level) {
  setHintPanel(level, session.expectedTopMoves, session.userColor);
}

function handleWrongMove(uci) {
  session.attempts++;

  // Always rewind the board so the user faces the same position again.
  resetBoardTo(boardCtx, session.fen);
  clearHints(document.getElementById("trainingBoard"));
  highlightCheck(boardCtx.chess);

  const boardEl = document.getElementById("trainingBoard");

  if (session.attempts === 1) {
    // First wrong attempt: highlight source squares immediately.
    session.hintLevel = 1;
    session.score.hintsUsed++;
    setStatus("Not the engine's choice — pieces to consider are highlighted.", { tone: "warning" });
    highlightSourceSquares(boardEl, session.expectedTopMoves);
    updateHintPanel("squares");
    return;
  }

  if (session.attempts === 2) {
    // Second wrong attempt: escalate to full arrows.
    session.hintLevel = 2;
    session.score.hintsUsed++;
    setStatus("Still not it — arrows show the best moves.", { tone: "warning" });
    drawHintArrows(boardEl, session.expectedTopMoves, session.userColor);
    updateHintPanel("arrows");
    return;
  }

  // attempts ≥ 3 — arrows already drawn, just keep them and update status.
  drawHintArrows(boardEl, session.expectedTopMoves, session.userColor);
  setStatus("Keep trying — use the arrows as guidance.", { tone: "warning" });
  updateHintPanel("arrows");
}

/**
 * Manually escalates the hint level when the user clicks the Hint button.
 * Level 0 → 1: highlight source squares.
 * Level 1 → 2: draw full arrows.
 * Level 2+: already at maximum, just re-show arrows.
 */
function handleHintRequest() {
  const boardEl = document.getElementById("trainingBoard");
  clearHints(boardEl);
  session.score.hintsUsed++;

  if (session.hintLevel === 0) {
    session.hintLevel = 1;
    highlightSourceSquares(boardEl, session.expectedTopMoves);
    setStatus("Pieces to consider are highlighted.", { tone: "warning" });
    updateHintPanel("squares");
  } else {
    session.hintLevel = 2;
    drawHintArrows(boardEl, session.expectedTopMoves, session.userColor);
    setStatus("Arrows show the best moves.", { tone: "warning" });
    updateHintPanel("arrows");
  }
}

/* ==========================================================================
   Scenario completion
   ========================================================================== */

function finishScenario() {
  const handler = getModeHandler(session.mode);
  const spec = session.positions[session.currentPositionIdx];
  let outcome = handler.evaluateOutcome(session);

  // For mate scenarios, replace the eval-delta outcome with a checkmate verdict.
  // evaluateOutcome may try to compute a finalEval-baselineEval delta, which is
  // meaningless (and potentially buggy) when both are null for mate lines.
  if (spec.isMateScenario) {
    if (session.mateDelivered) {
      outcome = {
        headline: "✅ Checkmate delivered!",
        detail: `Forced mate found — all ${Math.ceil((spec.mateForcedDepth || 1) / 2)} moves correct.`,
      };
      session.score.correctFirstTry += (session.attempts === 0 && session.hintLevel === 0) ? 1 : 0;
    } else {
      outcome = {
        headline: "❌ Mate not delivered",
        detail: "The mating line was not completed. Review the position.",
      };
    }
  }

  outcomes.push({
    spec,
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

/**
 * Returns to the position list without discarding the already-computed
 * scenario list or the current session score.
 *
 * Safe to call from PLAYING at any point — even mid-move, because the
 * engine calls are async and the boardCtx.destroy() tears down the board
 * before any further callbacks can fire.
 */
function goToScenarioList() {
  // Clean up the keyboard listener that renderPlayingScreen attached.
  const modalBody = document.getElementById("trainingModalBody");
  if (modalBody?._keyHandler) {
    document.removeEventListener("keydown", modalBody._keyHandler);
    modalBody._keyHandler = null;
  }
 
  // Tear down the training board.
  if (boardCtx) {
    boardCtx.destroy();
    boardCtx = null;
  }
 
  // Reset the history cursor (it's per-scenario, meaningless in list view).
  viewIndex = -1;
 
  // Go back to the list — positions and score are untouched.
  positionListBackDest = "exit";
  goToPhase(PHASES.POSITION_LIST);
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

/**
 * Exits the training modal without the "are you sure?" confirmation.
 * Used when the user is already on the position list (not mid-scenario)
 * and clicks "← Back" to return to the main review.
 */
function exitTrainingNoConfirm() {
  const modalBody = document.getElementById("trainingModalBody");
  if (modalBody?._keyHandler) {
    document.removeEventListener("keydown", modalBody._keyHandler);
    modalBody._keyHandler = null;
  }
  if (boardCtx) {
    boardCtx.destroy();
    boardCtx = null;
  }
  outcomes = [];
  session  = null;
  positionListBackDest = "config"; // reset for next time
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
  // Clear hint arrows/highlights whenever the user browses history.
  clearHints(document.getElementById("trainingBoard"));
  updateHistoryUI();
  highlightCheck(tempChess);
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
