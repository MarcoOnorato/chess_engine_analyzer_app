/**
 * @fileoverview Training modal UI — render functions, one per phase.
 *
 * Each `render*Screen` function:
 *   1. Empties the modal body.
 *   2. Builds DOM for the screen.
 *   3. Wires events that may transition the session to the next phase
 *      (calling back into the orchestrator passed as `controls`).
 *
 * The functions never read or mutate phase themselves — that's the
 * orchestrator's job. They just render and call back.
 *
 * `controls` is the small command surface offered by the orchestrator:
 *   {
 *     selectMode(modeId),
 *     applyConfig(config),
 *     startScenario(idx),
 *     skipScenario(),
 *     finishSession(),
 *     exitTraining(),
 *     requestArrowsHint(),
 *     declineArrowsHint(),
 *   }
 */

import { PHASES } from "./training-session.js";
import { MODE_HANDLERS } from "./training-modes.js";

/** Root element of the modal body where screens are rendered. */
const BODY_ID = "trainingModalBody";

/* ==========================================================================
   Header / shell
   ========================================================================== */

/**
 * Updates the static "Return to main game" button + phase label in the
 * modal header. Called every render.
 *
 * @param {string} phaseLabel
 * @param {() => void} onExit
 */
export function setHeader(phaseLabel, onExit) {
  const exitBtn = document.getElementById("trainingExitBtn");
  const phaseEl = document.getElementById("trainingPhaseLabel");
  if (phaseEl) phaseEl.textContent = phaseLabel;
  if (exitBtn) exitBtn.onclick = onExit;
}

/** @returns {HTMLElement} */
function body() {
  return document.getElementById(BODY_ID);
}

/* ==========================================================================
   Mode select
   ========================================================================== */

/**
 * @param {{ selectMode:(id:string)=>void }} controls
 */
export function renderModeSelect(controls) {
  const root = body();
  root.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "training-mode-grid";

  Object.values(MODE_HANDLERS).forEach((mode) => {
    const card = document.createElement("button");
    card.className = "training-mode-card";
    card.innerHTML = `
      <div class="training-mode-title">${escapeHtml(mode.label)}</div>
      <div class="training-mode-desc">${escapeHtml(mode.description)}</div>
    `;
    card.onclick = () => controls.selectMode(mode.id);
    grid.appendChild(card);
  });

  root.appendChild(grid);
}

/* ==========================================================================
   Config screen (color + parameters)
   ========================================================================== */

/**
 * @param {{ session: import("./training-session.js").Session,
 *           applyConfig:(patch:object)=>void,
 *           goToPositionList:()=>void }} controls
 */
export function renderConfigScreen(controls) {
  const { session } = controls;
  const root = body();
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "training-config";

  wrap.appendChild(
    fieldset(
      "Side",
      buttonGroup(
        [
          { label: "♔ White", value: "white" },
          { label: "♚ Black", value: "black" },
        ],
        session.userColor,
        (val) => controls.applyConfig({ userColor: val })
      )
    )
  );

  wrap.appendChild(
    fieldset(
      "Depth K (half-moves to play)",
      sliderRow(2, 16, session.config.depthK, (v) =>
        controls.applyConfig({ config: { ...session.config, depthK: v } })
      )
    )
  );

  wrap.appendChild(
    fieldset(
      "Number of scenarios",
      sliderRow(1, 12, session.config.maxPositions, (v) =>
        controls.applyConfig({ config: { ...session.config, maxPositions: v } })
      )
    )
  );

  wrap.appendChild(
    fieldset(
      "Acceptable top-N moves",
      sliderRow(1, 3, session.config.acceptTopN, (v) =>
        controls.applyConfig({ config: { ...session.config, acceptTopN: v } })
      )
    )
  );

  wrap.appendChild(
    fieldset(
      "Deep mode",
      toggleRow(
        "Vary opponent replies among engine top moves",
        session.config.deepMode,
        (v) =>
          controls.applyConfig({
            config: { ...session.config, deepMode: v },
          })
      )
    )
  );

  // Footer buttons
  const footer = document.createElement("div");
  footer.className = "training-config-footer";
  const back = document.createElement("button");
  back.textContent = "← Back";
  back.onclick = () => controls.applyConfig({ phase: PHASES.MODE_SELECT });
  const next = document.createElement("button");
  next.className = "training-cta";
  next.textContent = "Prepare scenarios →";
  next.onclick = () => controls.goToPositionList();
  footer.appendChild(back);
  footer.appendChild(next);

  wrap.appendChild(footer);
  root.appendChild(wrap);
}

/* ==========================================================================
   Position list
   ========================================================================== */

/**
 * @param {{ session: import("./training-session.js").Session,
 *           startScenario:(idx:number)=>void,
 *           goBackConfig:()=>void }} controls
 */
export function renderPositionList(controls) {
  const { session } = controls;
  const root = body();
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "training-position-list-wrap";

  if (session.positions.length === 0) {
    wrap.innerHTML = `
      <div class="training-empty">
        <p>No positions match this mode for the chosen side.</p>
        <p class="dim">Try a different mode or color.</p>
      </div>
    `;
    const back = document.createElement("button");
    back.textContent = "← Back";
    back.onclick = controls.goBackConfig;
    wrap.appendChild(back);
    root.appendChild(wrap);
    return;
  }

  const head = document.createElement("div");
  head.className = "training-list-head";
  head.innerHTML = `
    <h3>${session.positions.length} scenario(s) ready</h3>
    <p class="dim">Click any scenario to start, or hit "Start all" to play through them in order.</p>
  `;
  wrap.appendChild(head);

  const list = document.createElement("ol");
  list.className = "training-position-list";

  session.positions.forEach((p, idx) => {
    const li = document.createElement("li");
    li.className = "training-position-item";

    const moveLabel = p.contextSan
      ? ` ${moveNumberLabel(p.ply)}${p.contextSan}`
      : "";
    li.innerHTML = `
      <div class="training-pos-header">
        <span class="training-pos-idx">#${idx + 1}</span>
        <span class="training-pos-reason">${escapeHtml(p.reason)}</span>
      </div>
      <div class="training-pos-context">
        After move${moveLabel}
      </div>
      ${p.note ? `<div class="training-pos-note">${escapeHtml(p.note)}</div>` : ""}
    `;
    li.onclick = () => controls.startScenario(idx);
    list.appendChild(li);
  });

  wrap.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "training-config-footer";
  const back = document.createElement("button");
  back.textContent = "← Back";
  back.onclick = controls.goBackConfig;
  const startAll = document.createElement("button");
  startAll.className = "training-cta";
  startAll.textContent = `▶ Start scenario #1`;
  startAll.onclick = () => controls.startScenario(0);
  footer.appendChild(back);
  footer.appendChild(startAll);
  wrap.appendChild(footer);

  root.appendChild(wrap);
}

/* ==========================================================================
   Active training — playing screen (split layout matching main review UI)
   ========================================================================== */

/**
 * Renders the playing-screen with the same two-column layout as the main
 * analysis view: eval-bar + board on the left, move history + status on
 * the right. Caller mounts the chessboard.js instance into #trainingBoard
 * and drives the right-column widgets through the exported helpers below.
 *
 * @param {{ session: import("./training-session.js").Session,
 *           skipScenario:()=>void,
 *           onNavigate:(type:string)=>void }} controls
 */
export function renderPlayingScreen({ session, skipScenario, onNavigate, onReplay }) {
  const root = body();
  const spec  = session.positions[session.currentPositionIdx];

  root.innerHTML = `
    <div class="tplay-layout">

      <!-- ===== LEFT: eval-bar + board ===== -->
      <div class="tplay-board-col">

        <!-- Scenario badge just above the board -->
        <div class="tplay-scenario-badge">
          <span class="tplay-badge-num">Scenario ${session.currentPositionIdx + 1} / ${session.positions.length}</span>
          <span class="tplay-badge-reason">${escapeHtml(spec.reason)}</span>
        </div>

        <div class="tplay-board-wrap">
          <!-- Eval bar (mirrors main .evalbar) -->
          <div class="evalbar" id="trainingEvalBar">
            <div class="evalfill" id="trainingEvalFill" style="height:50%"></div>
            <span class="evaltext" id="trainingEvalText">0.0</span>
          </div>

          <!-- The actual chessboard host -->
          <div id="trainingBoard" class="tplay-board"></div>
        </div>

        <!-- Nav buttons below board (mirrors main Prev/Next row) -->
        <div class="tplay-nav-row">
          <button id="navFirst" class="tplay-nav-btn" title="First">«</button>
          <button id="navPrev"  class="tplay-nav-btn" title="Previous">‹</button>
          <button id="navNext"  class="tplay-nav-btn" title="Next">›</button>
          <button id="navLast"  class="tplay-nav-btn" title="Last">»</button>
        </div>
      </div>

      <!-- ===== RIGHT: move list + status ===== -->
      <div class="tplay-side-col">

        <!-- Move history panel (mirrors main .history-panel) -->
        <div class="card tplay-history-card">
          <div class="tplay-history-label">📜 Move History</div>
          <div id="trainingHistoryPanel" class="tplay-history-scroll"></div>
        </div>

        <!-- Status / feedback card -->
        <div class="card tplay-status-card">
          <div class="tplay-status-label">Status</div>
          <div id="trainingStatus" class="training-status-box tone-info">
            Loading…
          </div>

          <!-- "Want a hint?" prompt (hidden by default) -->
          <div id="trainingHintBox" class="training-hint-box hidden" style="margin-top:12px">
            <div style="font-size:0.9em; color:#f0c15c;">💡 Want a hint? Arrows will be drawn for the best moves.</div>
            <div class="training-hint-actions">
              <button id="trainingHintNo"  style="border-color:#555; color:#aaa;">No thanks</button>
              <button id="trainingHintYes" class="training-cta">Show hint</button>
            </div>
          </div>
        </div>

        <!-- Scenario note (optional) -->
        ${spec.note ? `
        <div class="card tplay-note-card">
          <span class="tplay-note-icon">ℹ️</span>
          <span class="tplay-note-text">${escapeHtml(spec.note)}</span>
        </div>` : ""}

        <!-- Skip button -->
        <div class="tplay-actions-row">
          <span class="tplay-moves-counter">
            ${spec.isMateScenario
              ? `Mate in <b id="trainingMovesPlayed">${Math.ceil((spec.mateForcedDepth || 1) / 2)}</b> — find every move`
              : `Moves played: <b id="trainingMovesPlayed">0</b> / ${session.config.depthK}`
            }
          </span>
          <div class="tplay-action-btns">
            <button id="replayBtn" class="tplay-replay-btn" title="Restart this scenario from scratch">↺ Replay</button>
            <button id="skipBtn" class="tplay-skip-btn">Skip →</button>
          </div>

        </div>

      </div>
    </div>
  `;

  // Wire navigation buttons
  document.getElementById("navFirst").onclick = () => onNavigate("first");
  document.getElementById("navPrev").onclick  = () => onNavigate("prev");
  document.getElementById("navNext").onclick  = () => onNavigate("next");
  document.getElementById("navLast").onclick  = () => onNavigate("last");
  document.getElementById("skipBtn").onclick  = skipScenario;
  document.getElementById("replayBtn").onclick = () => onReplay?.();

  // Keyboard shortcuts (arrow keys) — attach once, removed when modal closes
  const _keyHandler = (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowLeft")  { e.preventDefault(); onNavigate("prev"); }
    if (e.key === "ArrowRight") { e.preventDefault(); onNavigate("next"); }
    if (e.key === "Home")       { e.preventDefault(); onNavigate("first"); }
    if (e.key === "End")        { e.preventDefault(); onNavigate("last"); }
  };
  document.addEventListener("keydown", _keyHandler);
  // Store for cleanup
  root._keyHandler = _keyHandler;
}

/* ==========================================================================
   Playing-screen widget updaters (called by orchestrator after each event)
   ========================================================================== */

/**
 * Updates the in-scenario status text.
 * @param {string|HTMLElement} msg
 * @param {{ tone?: "info"|"success"|"warning"|"error" }} [opts]
 */
export function setStatus(msg, opts = {}) {
  const el = document.getElementById("trainingStatus");
  if (!el) return;
  el.classList.remove("tone-info", "tone-success", "tone-warning", "tone-error");
  el.classList.add(`tone-${opts.tone || "info"}`);
  if (typeof msg === "string") el.textContent = msg;
  else {
    el.innerHTML = "";
    el.appendChild(msg);
  }
}

/** @param {number} n */
export function setMovesPlayed(n) {
  const el = document.getElementById("trainingMovesPlayed");
  if (el) el.textContent = String(n);
}

/**
 * Updates the "N moves to forced checkmate" counter during a mate scenario.
 * @param {number} n - Remaining user moves to deliver checkmate.
 */
export function setMateMovesLeft(n) {
  const el = document.getElementById("trainingMovesPlayed");
  if (el) el.textContent = String(n);
}

/**
 * Updates the training eval bar.
 * @param {number|null} score  Engine eval in pawns (white POV).
 * @param {number|null} mate   Mate-in-N (positive = white winning).
 */
export function setEvalBar(score, mate = null) {
  const fill = document.getElementById("trainingEvalFill");
  const txt  = document.getElementById("trainingEvalText");
  if (!fill || !txt) return;

  if (mate != null) {
    txt.textContent = mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
    fill.style.height = mate > 0 ? "100%" : "0%";
    return;
  }
  if (score == null) {
    txt.textContent = "–";
    fill.style.height = "50%";
    return;
  }
  const clamped = Math.max(-10, Math.min(10, score));
  fill.style.height = `${((clamped + 10) / 20) * 100}%`;
  txt.textContent = (score >= 0 ? "+" : "") + score.toFixed(1);
}

/**
 * Reveals the "want a hint?" prompt; wires its two buttons.
 * @param {() => void} onYes
 * @param {() => void} onNo
 */
export function showHintPrompt(onYes, onNo) {
  const box = document.getElementById("trainingHintBox");
  if (!box) return;
  box.classList.remove("hidden");
  document.getElementById("trainingHintYes").onclick = () => {
    box.classList.add("hidden");
    onYes();
  };
  document.getElementById("trainingHintNo").onclick = () => {
    box.classList.add("hidden");
    onNo();
  };
}

export function hideHintPrompt() {
  const box = document.getElementById("trainingHintBox");
  if (box) box.classList.add("hidden");
}

/**
 * Renders the history panel as a two-column move table (matching the main
 * game tree style): move number | white SAN | black SAN.
 *
 * Preceding moves (context) are shown in a muted style; session moves are
 * shown in the normal active style. The active move is highlighted.
 *
 * @param {string[]} precedingMoves  SANs replayed before the scenario started.
 * @param {string[]} sessionMoves    SANs played during the training session.
 * @param {number}   currentViewIdx  Flat index of the currently displayed position.
 * @param {(idx:number)=>void} onJump  Called when user clicks a move.
 */
export function renderTrainingHistory(precedingMoves = [], sessionMoves = [], currentViewIdx, onJump) {
  const container = document.getElementById("trainingHistoryPanel");
  if (!container) return;

  const allMoves   = [...precedingMoves, ...sessionMoves];
  const splitAt    = precedingMoves.length; // first session-move index
  let html = "";

  for (let i = 0; i < allMoves.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const wIdx    = i;
    const bIdx    = i + 1;

    const wSan = allMoves[wIdx] ?? "";
    const bSan = allMoves[bIdx] ?? "";

    // "preceding" vs "session" styling
    const wContext = wIdx < splitAt;
    const bContext = bIdx < splitAt;

    const wActive = wIdx === currentViewIdx ? "active-main" : "";
    const bActive = bIdx === currentViewIdx ? "active-main" : "";

    const wClass = `tplay-move-cell ${wContext ? "tplay-move-context" : ""} ${wActive}`;
    const bClass = `tplay-move-cell ${bContext ? "tplay-move-context" : ""} ${bActive}`;

    html += `
      <div class="history-row">
        <span class="move-number">${moveNum}.</span>
        <span class="${wClass.trim()}" data-idx="${wIdx}">${escapeHtml(wSan)}</span>
        <span class="${bClass.trim()}" data-idx="${bIdx}">${escapeHtml(bSan)}</span>
      </div>`;
  }

  container.innerHTML = html || `<div class="tplay-no-moves">No moves yet</div>`;

  // Click handlers
  container.querySelectorAll(".tplay-move-cell").forEach((el) => {
    const san = el.textContent.trim();
    if (!san) return; // empty black cell on last row
    el.onclick = () => {
      const idx = parseInt(el.getAttribute("data-idx"), 10);
      if (!isNaN(idx)) onJump(idx);
    };
  });

  // Auto-scroll so the active move stays visible
  const activeEl = container.querySelector(".active-main");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

/* ==========================================================================
   Results screen
   ========================================================================== */

/**
 * @param {{ session: import("./training-session.js").Session,
 *           outcomes: Array<{spec:any, headline:string, detail:string}>,
 *           exitTraining:()=>void,
 *           restart:()=>void }} controls
 */
export function renderResults(controls) {
  const { session, outcomes } = controls;

  // Clean up keyboard listener attached during playing screen
  const root = body();
  if (root._keyHandler) {
    document.removeEventListener("keydown", root._keyHandler);
    root._keyHandler = null;
  }

  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "training-results";

  const summary = document.createElement("div");
  summary.className = "training-results-summary";
  summary.innerHTML = `
    <h3>Session complete</h3>
    <div class="training-stats-grid">
      <div><div class="stat-num">${session.score.scenariosCompleted}</div><div class="stat-label">Scenarios</div></div>
      <div><div class="stat-num">${session.score.correctFirstTry}</div><div class="stat-label">Solved first try</div></div>
      <div><div class="stat-num">${session.score.correctWithHints}</div><div class="stat-label">Solved with hints</div></div>
      <div><div class="stat-num">${session.score.failed}</div><div class="stat-label">Failed</div></div>
    </div>
  `;
  wrap.appendChild(summary);

  const list = document.createElement("ul");
  list.className = "training-results-list";
  outcomes.forEach((o, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="training-result-headline">#${idx + 1}: ${escapeHtml(o.headline)}</div>
      <div class="training-result-detail">${escapeHtml(o.detail || "")}</div>
      <div class="training-result-source dim">${escapeHtml(o.spec.reason)}</div>
    `;
    list.appendChild(li);
  });
  wrap.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "training-config-footer";
  const restart = document.createElement("button");
  restart.textContent = "↺ New session";
  restart.onclick = controls.restart;
  const close = document.createElement("button");
  close.className = "training-cta";
  close.textContent = "← Return to main game";
  close.onclick = controls.exitTraining;
  footer.appendChild(restart);
  footer.appendChild(close);
  wrap.appendChild(footer);

  root.appendChild(wrap);
}

/* ==========================================================================
   Tiny DOM helpers
   ========================================================================== */

function fieldset(legend, contentEl) {
  const fs = document.createElement("div");
  fs.className = "training-fieldset";
  const lg = document.createElement("div");
  lg.className = "training-fieldset-legend";
  lg.textContent = legend;
  fs.appendChild(lg);
  fs.appendChild(contentEl);
  return fs;
}

function buttonGroup(items, current, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "training-btn-group";
  items.forEach((item) => {
    const b = document.createElement("button");
    b.textContent = item.label;
    b.className =
      "training-btn-group-item" + (current === item.value ? " active" : "");
    b.onclick = () => {
      wrap
        .querySelectorAll(".training-btn-group-item")
        .forEach((el) => el.classList.remove("active"));
      b.classList.add("active");
      onChange(item.value);
    };
    wrap.appendChild(b);
  });
  return wrap;
}

function sliderRow(min, max, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "training-slider-row";
  const r = document.createElement("input");
  r.type = "range";
  r.min = String(min);
  r.max = String(max);
  r.value = String(value);
  const v = document.createElement("span");
  v.className = "training-slider-value";
  v.textContent = String(value);
  r.oninput = () => {
    v.textContent = r.value;
    onChange(parseInt(r.value, 10));
  };
  wrap.appendChild(r);
  wrap.appendChild(v);
  return wrap;
}

function toggleRow(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "training-toggle-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!value;
  cb.onchange = () => onChange(cb.checked);
  const span = document.createElement("span");
  span.textContent = label;
  wrap.appendChild(cb);
  wrap.appendChild(span);
  return wrap;
}

function moveNumberLabel(ply) {
  const moveNo = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${moveNo}. ` : `${moveNo}... `;
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
