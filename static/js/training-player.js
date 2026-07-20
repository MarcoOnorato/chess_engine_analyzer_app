/**
 * @fileoverview "Train as a Player" flow.
 *
 * Entry point: `openTrainAsPlayerModal()`
 *
 * Phases (rendered inside #trainingModal, same overlay as the regular flow):
 *
 *   PROFILE  → user picks one of the tracked Player DB profiles.
 *   READING  → progress bar while the stored games are read back. This used to
 *              fetch the last N games from Lichess / Chess.com and run the
 *              engine over every one of them; now the analysis already exists
 *              in the database, so nothing is recomputed.
 *   CATEGORY → shows error-type frequencies + lets the user pick which
 *              weakness to drill. "All" = mix of all categories.
 *   LAUNCH   → hands off to the existing training orchestrator with the
 *              assembled ScenarioSpec[].
 *
 * This module only manages the pre-training setup. The actual playing phase
 * reuses the existing `training.js` infrastructure.
 */

import { analyseProfileGames, PLAYER_ERROR_TYPES } from "./training-player-analysis.js";
import { openTrainingModalWithScenarios } from "./training.js";
import { api } from "./api.js";

/* ─── Constants ──────────────────────────────────────────────────────────── */

const MODAL_ID  = "trainingModal";
const BODY_ID   = "trainingModalBody";
const HEADER_ID = "trainingPhaseLabel";
const EXIT_ID   = "trainingExitBtn";

const CATEGORY_META = {
  [PLAYER_ERROR_TYPES.MISSED_MATE]: {
    icon: "♟",
    label: "Missed Mates",
    color: "#e05a5a",
    desc: "Forced checkmates that were available but not played.",
  },
  [PLAYER_ERROR_TYPES.HANGING_PIECE]: {
    icon: "⚠",
    label: "Hanging Pieces",
    color: "#e6912c",
    desc: "Free material left en prise that the opponent could capture.",
  },
  [PLAYER_ERROR_TYPES.MISSED_CAPTURE]: {
    icon: "✂",
    label: "Missed Captures",
    color: "#f0c040",
    desc: "Opportunities to win material that were overlooked.",
  },
  [PLAYER_ERROR_TYPES.MISSED_TACTIC]: {
    icon: "🔍",
    label: "Missed Tactics",
    color: "#26bbff",
    desc: "Combinations and forcing sequences that went unplayed.",
  },
};

/* ─── State ─────────────────────────────────────────────────────────────── */

/** @type {{id:number,label:string,games_count:number}|null} Chosen profile. */
let selectedProfile = null;

/** How many stored games were read for the current result. */
let gamesRead = 0;

/** @type {import("./training-player-analysis.js").PlayerAnalysisResult|null} */
let analysisResult = null;

/** Where to return when the flow is closed (set by the Training hub). */
let onClose = null;

/* ─── Public entry ───────────────────────────────────────────────────────── */

/**
 * @param {Object} [opts]
 * @param {() => void} [opts.onExit] - Called when the user leaves the flow.
 * @param {number|string} [opts.profileId] - Skip the picker and drill this
 *        profile straight away (used by the "Train on mistakes" bridge from the
 *        Players dashboard, /training?tap=<id>).
 */
export function openTrainAsPlayerModal(opts = {}) {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  selectedProfile = null;
  gamesRead = 0;
  analysisResult = null;
  onClose = typeof opts.onExit === "function" ? opts.onExit : null;

  modal.classList.remove("hidden");
  setHeader("Train as a Player", closeModal);
  if (opts.profileId != null) {
    autoSelectProfile(opts.profileId);
  } else {
    renderProfileScreen();
  }
}

/** Jumps past the picker to a specific profile; falls back to the picker if it
 *  has no analyzed games (or can't be found). */
function autoSelectProfile(profileId) {
  const root = body();
  root.innerHTML = "<div class='dim' style='padding:24px'>Loading profile…</div>";
  api.get("/api/players").then((profiles) => {
    const p = profiles.find((x) => String(x.id) === String(profileId));
    if (!p || !p.games_count) { renderProfileScreen(); return; }
    selectedProfile = p;
    renderAnalysingScreen(p);
  }).catch(() => renderProfileScreen());
}

/* ─── Modal shell helpers ────────────────────────────────────────────────── */

function body() {
  return document.getElementById(BODY_ID);
}

function setHeader(label, onExit) {
  const h = document.getElementById(HEADER_ID);
  const b = document.getElementById(EXIT_ID);
  if (h) h.textContent = label;
  if (b) b.onclick = onExit;
}

function closeModal() {
  const modal = document.getElementById(MODAL_ID);
  if (modal) modal.classList.add("hidden");
  onClose?.();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Phase 1 — IMPORT
   ═══════════════════════════════════════════════════════════════════════════ */

function renderProfileScreen() {
  setHeader("Pick a tracked player", closeModal);
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-import-wrap");
  const errBox = el("div", "tap-error hidden");
  wrap.appendChild(errBox);

  const list = el("div", "engine-source-list");
  list.innerHTML = "<div class='dim'>Loading profiles…</div>";
  wrap.appendChild(list);
  root.appendChild(wrap);

  api.get("/api/players").then((profiles) => {
    list.innerHTML = "";
    if (!profiles.some((p) => p.games_count)) {
      list.innerHTML =
        "<div class='dim'>" +
        (profiles.length
          ? "No analyzed games yet. Import some in the Players tab — "
          : "No tracked profiles yet. Create one in the Players tab and import some games — ") +
        "this flow trains on what is already analyzed there.</div>";
      const go = el("button", "training-cta");
      go.type = "button";
      go.textContent = "Go to Players";
      go.onclick = () => { window.location.href = "/players"; };
      wrap.appendChild(go);
      return;
    }
    profiles.forEach((p) => {
      const item = el("button", "engine-source-item");
      item.type = "button";
      item.disabled = !p.games_count;
      item.innerHTML =
        `<span>${escHtml(p.label)}</span>` +
        `<small>${escHtml([p.platform, p.username].filter(Boolean).join(" · ") || "—")}` +
        ` • ${p.games_count || 0} games</small>`;
      item.onclick = () => {
        selectedProfile = p;
        renderAnalysingScreen(p);
      };
      list.appendChild(item);
    });
  }).catch((e) => {
    showErr(errBox, e.message || "Could not load profiles.");
    list.innerHTML = "";
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Phase 2 — ANALYSING
   ═══════════════════════════════════════════════════════════════════════════ */

function renderAnalysingScreen(profile) {
  setHeader("Reading stored games…", null /* no exit while it runs */);
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-analysing-wrap");

  const label = el("p", "tap-analysing-label");
  label.textContent = "Loading…";
  wrap.appendChild(label);

  const barOuter = el("div", "tap-progress-bar-outer");
  const barInner = el("div", "tap-progress-bar-inner");
  barInner.style.width = "0%";
  barOuter.appendChild(barInner);
  wrap.appendChild(barOuter);

  const sub = el("p", "tap-analysing-sub");
  sub.textContent = `0 / ${profile.games_count || 0} games`;
  wrap.appendChild(sub);

  root.appendChild(wrap);

  // No engine pass: the analysis was done once, when the games were ingested.
  analyseProfileGames(profile.id, (done, total, msg) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    barInner.style.width = pct + "%";
    label.textContent = msg;
    sub.textContent = `${done} / ${total} games`;
  }).then((result) => {
    analysisResult = result;
    gamesRead = result.totalGames ?? (profile.games_count || 0);
    renderCategoryScreen();
  }).catch((e) => {
    root.innerHTML = `<div class="tap-error-full">Could not read the stored games: ${escHtml(e.message)}</div>`;
    setHeader("Error", closeModal);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Phase 3 — CATEGORY SELECTOR
   ═══════════════════════════════════════════════════════════════════════════ */

export function renderCategoryScreen() {
  setHeader("Choose your training focus", closeModal);
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-category-wrap");

  const totalErrors = Object.values(analysisResult.counts).reduce((a, b) => a + b, 0);

  if (totalErrors === 0) {
    wrap.innerHTML = `
      <div class="training-empty">
        <p>No significant errors found in this profile's stored games.</p>
        <p class="dim">Import more games for it in the Players tab, or pick another profile.</p>
      </div>`;
    const back = el("button", "");
    back.textContent = "← Back";
    back.onclick = renderProfileScreen;
    wrap.appendChild(back);
    root.appendChild(wrap);
    return;
  }

  // ── Summary banner ───────────────────────────────────────────────────
  const banner = el("div", "tap-summary-banner");
  const stale = analysisResult.staleGames || 0;
  banner.innerHTML = `
    <span class="tap-summary-player">📊 ${escHtml(selectedProfile?.label || "Player")}</span>
    <span class="tap-summary-games">${gamesRead} stored games • ${totalErrors} errors found</span>
  `;
  wrap.appendChild(banner);

  // Games ingested before the best-move columns existed can only reach the
  // categories that don't need the engine's preferred move — say so rather
  // than silently under-reporting.
  if (stale > 0) {
    const note = el("div", "tap-analysing-sub");
    note.textContent =
      `${stale} game(s) were ingested before best moves were stored: their errors can only ` +
      `be sorted as missed mates or missed tactics. Re-import them to classify them fully.`;
    wrap.appendChild(note);
  }

  // ── Category cards ───────────────────────────────────────────────────
  const grid = el("div", "tap-category-grid");

  // Sort by frequency descending.
  const sorted = Object.keys(PLAYER_ERROR_TYPES)
    .map((k) => PLAYER_ERROR_TYPES[k])
    .filter((id) => analysisResult.counts[id] > 0)
    .sort((a, b) => (analysisResult.counts[b] || 0) - (analysisResult.counts[a] || 0));

  sorted.forEach((catId) => {
    const meta  = CATEGORY_META[catId];
    const count = analysisResult.counts[catId] || 0;
    const pct   = analysisResult.frequencies[catId] || 0;

    const card = el("button", "tap-category-card");
    card.style.setProperty("--cat-color", meta.color);

    card.innerHTML = `
      <div class="tap-cat-icon">${meta.icon}</div>
      <div class="tap-cat-body">
        <div class="tap-cat-label">${escHtml(meta.label)}</div>
        <div class="tap-cat-desc">${escHtml(meta.desc)}</div>
      </div>
      <div class="tap-cat-stat">
        <div class="tap-cat-pct">${pct}%</div>
        <div class="tap-cat-count">${count} position${count !== 1 ? "s" : ""}</div>
        <div class="tap-cat-bar-wrap">
          <div class="tap-cat-bar-fill" style="width:${pct}%; background:${meta.color};"></div>
        </div>
      </div>
    `;

    card.onclick = () => launchCategory(catId);
    grid.appendChild(card);
  });

  // "All" card — mix everything.
  if (sorted.length > 1) {
    const allCard = el("button", "tap-category-card tap-cat-all");
    allCard.innerHTML = `
      <div class="tap-cat-icon">⚡</div>
      <div class="tap-cat-body">
        <div class="tap-cat-label">Mixed Training</div>
        <div class="tap-cat-desc">All error types combined — most varied workout.</div>
      </div>
      <div class="tap-cat-stat">
        <div class="tap-cat-pct">—</div>
        <div class="tap-cat-count">${totalErrors} total positions</div>
        <div class="tap-cat-bar-wrap">
          <div class="tap-cat-bar-fill" style="width:100%; background: linear-gradient(90deg,#e05a5a,#e6912c,#f0c040,#26bbff);"></div>
        </div>
      </div>
    `;
    allCard.onclick = () => launchCategory(null);
    grid.appendChild(allCard);
  }

  wrap.appendChild(grid);

  // ── Back button ──────────────────────────────────────────────────────
  const back = el("button", "tap-back-btn");
  back.textContent = "← Pick another player";
  back.onclick = renderProfileScreen;
  wrap.appendChild(back);

  root.appendChild(wrap);
}

/* ─── Launch ─────────────────────────────────────────────────────────────── */

/**
 * Assembles the scenario list and hands off to the existing training
 * orchestrator.
 *
 * @param {string|null} catId  null = all categories mixed.
 */
function launchCategory(catId) {
  if (!analysisResult) return;

  let scenarios;
  if (catId === null) {
    // Interleave categories for variety.
    scenarios = interleave(
      Object.values(analysisResult.byCategory).filter((arr) => arr.length > 0)
    );
  } else {
    scenarios = analysisResult.byCategory[catId] || [];
  }

  if (!scenarios.length) return;

  // Determine the profile's dominant colour across the stored games.
  // Each spec carries userColor — pick the majority.
  const colorCounts = { white: 0, black: 0 };
  scenarios.forEach((s) => { colorCounts[s.userColor]++; });
  const userColor = colorCounts.white >= colorCounts.black ? "white" : "black";

  openTrainingModalWithScenarios({
    scenarios,
    userColor,
    label: catId
      ? CATEGORY_META[catId]?.label ?? "Player Training"
      : "Mixed Training",
    onBack: renderCategoryScreen,
    onExit: () => { closeModal(); },
  });
}

/**
 * Interleaves multiple arrays in round-robin order.
 * e.g. [[a,b], [c,d,e], [f]] → [a, c, f, b, d, e]
 */
function interleave(arrays) {
  const result = [];
  const maxLen = Math.max(...arrays.map((a) => a.length));
  for (let i = 0; i < maxLen; i++) {
    arrays.forEach((arr) => {
      if (i < arr.length) result.push(arr[i]);
    });
  }
  return result;
}

/* ─── DOM helpers ────────────────────────────────────────────────────────── */

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function qs(selector) {
  return document.querySelector(selector);
}

function labeledInput(labelText, id, type, placeholder, autoFocus = false) {
  const wrap = el("div", "tap-field");
  const lbl  = el("label", "tap-label");
  lbl.textContent = labelText;
  lbl.htmlFor = id;
  const inp = el("input", "tap-input");
  inp.id = id;
  inp.type = type;
  inp.placeholder = placeholder;

  if (autoFocus) {
    requestAnimationFrame(() => {
      inp.focus();
      inp.select();
    });
  }

  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  return wrap;
}

function showErr(box, msg) {
  box.textContent = msg;
  box.classList.remove("hidden");
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
