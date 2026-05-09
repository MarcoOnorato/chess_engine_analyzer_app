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
   Active training (board view)
   ========================================================================== */

/**
 * Renders the playing-screen skeleton: a board container on the left, a
 * status panel on the right. Caller is responsible for mounting the
 * chessboard.js instance into `#trainingBoard` and updating `#trainingStatus`.
 *
 * @param {{ session: import("./training-session.js").Session,
 *           skipScenario:()=>void }} controls
 */
export function renderPlayingScreen({ session, skipScenario, onNavigate }) {
  const body = document.getElementById(BODY_ID);
  body.innerHTML = `
    <div class="training-playing-layout">
      <div class="training-board-col">
        <div id="trainingBoard" style="width: 100%"></div>
        <div id="trainingStatus" class="training-status-box"></div>
      </div>
      <div class="training-history-col">
        <div class="history-header">History</div>
        <div id="trainingHistoryPanel" class="training-history-panel"></div>
        
        <div class="training-nav-steps">
          <button id="navFirst" class="nav-btn">«</button>
          <button id="navPrev" class="nav-btn">‹</button>
          <button id="navNext" class="nav-btn">›</button>
          <button id="navLast" class="nav-btn">»</button>
        </div>

        <button id="skipBtn" class="training-skip-btn">Skip Scenario</button>
      </div>
    </div>
  `;

  // Keybinding
  document.getElementById("navFirst").onclick = () => onNavigate('first');
  document.getElementById("navPrev").onclick  = () => onNavigate('prev');
  document.getElementById("navNext").onclick  = () => onNavigate('next');
  document.getElementById("navLast").onclick  = () => onNavigate('last');
  document.getElementById("skipBtn").onclick  = skipScenario;
}

/**
 * Updates the in-scenario status text + move counter. Called whenever a
 * move is played or an attempt fails.
 *
 * @param {string|HTMLElement} msg
 * @param {{ tone?: "info"|"success"|"warning"|"error" }} [opts]
 */
export function setStatus(msg, opts = {}) {
  const el = document.getElementById("trainingStatus");
  if (!el) return;
  el.classList.remove(
    "tone-info",
    "tone-success",
    "tone-warning",
    "tone-error"
  );
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
 * Updates the small training eval-bar to the given engine score.
 * @param {number|null} score
 * @param {number|null} mate
 */
export function setEvalBar(score, mate = null) {
  const fill = document.getElementById("trainingEvalFill");
  const txt = document.getElementById("trainingEvalText");
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
 * Renders the history panel
 * @param {string[]} precedingMoves - SAN array of the moves from the start
 * @param {string[]} sessionMoves - SAN array of additional moves played in the training
 */
export function renderTrainingHistory(precedingMoves = [], sessionMoves = [], currentViewIdx, onJump) {
  const container = document.getElementById("trainingHistoryPanel");
  if (!container) return;

  const allMoves = [...precedingMoves, ...sessionMoves];
  let html = "";

  for (let i = 0; i < allMoves.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const wIdx = i;
    const bIdx = i + 1;

    html += `
      <div class="history-move-row">
        <div class="history-move-num">${moveNum}.</div>
        <div class="history-move-san ${wIdx === currentViewIdx ? 'active-view' : ''}" data-idx="${wIdx}">${allMoves[wIdx]}</div>
        <div class="history-move-san ${allMoves[bIdx] ? (bIdx === currentViewIdx ? 'active-view' : '') : ''}" data-idx="${bIdx}">
          ${allMoves[bIdx] || ""}
        </div>
      </div>`;
  }
  container.innerHTML = html;

  // Click on the move
  container.querySelectorAll('.history-move-san').forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.getAttribute('data-idx'));
      if (!isNaN(idx)) onJump(idx);
    };
  });
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
  const root = body();
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
