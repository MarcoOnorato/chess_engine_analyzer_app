/**
 * @fileoverview "Train as a Player" flow.
 *
 * Entry point: `openTrainAsPlayerModal()`
 *
 * Phases (rendered inside #trainingModal, same overlay as the regular flow):
 *
 *   IMPORT   → user picks a platform (Lichess / Chess.com), enters username
 *              + game count. Fetches raw PGNs.
 *   ANALYSING→ progress bar while the engine runs over all games.
 *   CATEGORY → shows error-type frequencies + lets the user pick which
 *              weakness to drill. "All" = mix of all categories.
 *   LAUNCH   → hands off to the existing training orchestrator with the
 *              assembled ScenarioSpec[].
 *
 * This module only manages the pre-training setup. The actual playing phase
 * reuses the existing `training.js` infrastructure via `launchPlayerSession`.
 */

import { analysePlayerGames, PLAYER_ERROR_TYPES } from "./training-player-analysis.js";
import { openTrainingModalWithScenarios } from "./training.js";

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

/** @type {string[]} Fetched PGN strings. */
let fetchedPgns = [];

/** @type {string} Resolved player username. */
let resolvedPlayer = "";

/** @type {import("./training-player-analysis.js").PlayerAnalysisResult|null} */
let analysisResult = null;

/* ─── Public entry ───────────────────────────────────────────────────────── */

export function openTrainAsPlayerModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  fetchedPgns = [];
  resolvedPlayer = "";
  analysisResult = null;

  modal.classList.remove("hidden");
  setHeader("Train as a Player", closeModal);
  renderImportScreen();
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
}

/* ═══════════════════════════════════════════════════════════════════════════
   Phase 1 — IMPORT
   ═══════════════════════════════════════════════════════════════════════════ */

function renderImportScreen() {
  setHeader("Import your games", closeModal);
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-import-wrap");

  // ── Platform selector ──────────────────────────────────────────────────
  const platformRow = el("div", "tap-platform-row");
  let chosenPlatform = "chesscom";

  const platforms = [
    { id: "chesscom", label: "Chess.com", color: "#69923e" },
    { id: "lichess",  label: "Lichess",   color: "#aaa" },
  ];

  const platformBtns = {};
  platforms.forEach(({ id, label, color }) => {
    const b = el("button", "tap-platform-btn" + (id === chosenPlatform ? " active" : ""));
    b.textContent = label;
    b.style.setProperty("--platform-color", color);
    b.onclick = () => {
      chosenPlatform = id;
      Object.values(platformBtns).forEach((pb) => pb.classList.remove("active"));
      b.classList.add("active");
      updateExtraFields();
      const userInput = qs("#tap-username");
      userInput?.focus();
      userInput?.select();
    };
    platformBtns[id] = b;
    platformRow.appendChild(b);
  });
  wrap.appendChild(platformRow);

  // ── Username ───────────────────────────────────────────────────────────
  wrap.appendChild(labeledInput("Username", "tap-username", "text", "Your username…", true));

  // ── Count ─────────────────────────────────────────────────────────────
  const countField = labeledInput("Number of games to fetch", "tap-count", "number", "5");
  countField.querySelector("input").min = "1";
  countField.querySelector("input").max = "50";
  countField.querySelector("input").value = "5";
  wrap.appendChild(countField);

  // ── Chess.com extras (year + month) ────────────────────────────────────
  const extraWrap = el("div", "tap-extra-fields");
  const now = new Date();

  const yearField = labeledInput("Year",  "tap-cc-year",  "number", String(now.getFullYear()));
  const monthField = labeledInput("Month", "tap-cc-month", "number", String(now.getMonth() + 1));
  yearField.querySelector("input").min = "1900";
  yearField.querySelector("input").max = String(now.getFullYear());
  monthField.querySelector("input").min = "1";
  monthField.querySelector("input").max = "12";
  extraWrap.appendChild(yearField);
  extraWrap.appendChild(monthField);

  wrap.appendChild(extraWrap);

  function updateExtraFields() {
    extraWrap.style.display = chosenPlatform === "chesscom" ? "flex" : "none";
  }
  updateExtraFields();

  // ── Depth ─────────────────────────────────────────────────────────────
  const depthField = labeledInput("Engine depth", "tap-depth", "number", "12");
  depthField.querySelector("input").min = "8";
  depthField.querySelector("input").max = "30";
  wrap.appendChild(depthField);

  // ── Error message slot ────────────────────────────────────────────────
  const errBox = el("div", "tap-error hidden");
  wrap.appendChild(errBox);

  // ── Fetch button ──────────────────────────────────────────────────────
  const fetchBtn = el("button", "training-cta tap-fetch-btn");
  fetchBtn.textContent = "Fetch games →";
  fetchBtn.onclick = async () => {
    errBox.classList.add("hidden");
    const username = qs("#tap-username")?.value?.trim();
    const count = parseInt(qs("#tap-count")?.value, 10) || 5;
    const depth = parseInt(qs("#tap-depth")?.value, 10) || 12;

    if (!username) { showErr(errBox, "Please enter a username."); return; }

    fetchBtn.disabled = true;
    fetchBtn.textContent = "Fetching…";

    try {
      let pgns;
      if (chosenPlatform === "lichess") {
        pgns = await fetchLichessPgns(username, count);
      } else {
        const year  = qs("#tap-cc-year")?.value  || String(now.getFullYear());
        const month = (qs("#tap-cc-month")?.value || String(now.getMonth() + 1)).padStart(2, "0");
        pgns = await fetchChessComPgns(username, count, year, month);
      }

      if (!pgns.length) {
        showErr(errBox, "No games found. Check the username and date.");
        fetchBtn.disabled = false;
        fetchBtn.textContent = "Fetch games →";
        return;
      }

      fetchedPgns     = pgns;
      resolvedPlayer  = username;
      renderAnalysingScreen(depth);

    } catch (e) {
      showErr(errBox, e.message || "Network error.");
      fetchBtn.disabled = false;
      fetchBtn.textContent = "Fetch games →";
    }
  };

  wrap.appendChild(fetchBtn);
  root.appendChild(wrap);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Phase 2 — ANALYSING
   ═══════════════════════════════════════════════════════════════════════════ */

function renderAnalysingScreen(depth) {
  setHeader("Analysing your games…", null /* no exit during analysis */);
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-analysing-wrap");

  const label = el("p", "tap-analysing-label");
  label.textContent = "Starting analysis…";
  wrap.appendChild(label);

  const barOuter = el("div", "tap-progress-bar-outer");
  const barInner = el("div", "tap-progress-bar-inner");
  barInner.style.width = "0%";
  barOuter.appendChild(barInner);
  wrap.appendChild(barOuter);

  const sub = el("p", "tap-analysing-sub");
  sub.textContent = `0 / ${fetchedPgns.length} games`;
  wrap.appendChild(sub);

  root.appendChild(wrap);

  // Kick off analysis asynchronously.
  analysePlayerGames(
    fetchedPgns,
    resolvedPlayer,
    depth,
    (done, total, msg) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      barInner.style.width = pct + "%";
      label.textContent = msg;
      sub.textContent = `${done} / ${total} games`;
    }
  ).then((result) => {
    analysisResult = result;
    renderCategoryScreen();
  }).catch((e) => {
    root.innerHTML = `<div class="tap-error-full">Analysis failed: ${escHtml(e.message)}</div>`;
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
        <p>No significant errors found in the analysed games.</p>
        <p class="dim">Try fetching more games or lowering the engine depth.</p>
      </div>`;
    const back = el("button", "");
    back.textContent = "← Back";
    back.onclick = renderImportScreen;
    wrap.appendChild(back);
    root.appendChild(wrap);
    return;
  }

  // ── Summary banner ───────────────────────────────────────────────────
  const banner = el("div", "tap-summary-banner");
  banner.innerHTML = `
    <span class="tap-summary-player">📊 ${escHtml(resolvedPlayer)}</span>
    <span class="tap-summary-games">${fetchedPgns.length} games • ${totalErrors} errors found</span>
  `;
  wrap.appendChild(banner);

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
  back.textContent = "← Fetch different games";
  back.onclick = renderImportScreen;
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

  // Determine the user's dominant color across fetched games.
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

/* ─── Platform fetchers ──────────────────────────────────────────────────── */

/**
 * Fetches PGN strings from the Lichess API (NDJSON games endpoint).
 * @param {string} username
 * @param {number} count
 * @returns {Promise<string[]>}
 */
async function fetchLichessPgns(username, count) {
  const res = await fetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${count}&pgnInJson=true`,
    { headers: { Accept: "application/x-ndjson" } }
  );
  if (!res.ok) throw new Error("Lichess: user not found or API error.");

  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim());
  return lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .map((g) => g.pgn)
    .filter(Boolean);
}

/**
 * Fetches PGN strings from the Chess.com API.
 * Chess.com returns games only for a specific YYYY/MM archive; if we need
 * more than the archive contains we walk back month by month.
 *
 * @param {string} username
 * @param {number} count
 * @param {string} year
 * @param {string} month  zero-padded
 * @returns {Promise<string[]>}
 */
async function fetchChessComPgns(username, count, year, month) {
  const pgns = [];
  let yyyy = parseInt(year, 10);
  let mm   = parseInt(month, 10);

  // Walk back up to 6 months to collect enough games.
  for (let attempt = 0; attempt < 6 && pgns.length < count; attempt++) {
    const mm2 = String(mm).padStart(2, "0");
    const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${yyyy}/${mm2}`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      const batch = (data.games || [])
        .reverse()                     // newest first
        .filter((g) => g.pgn)
        .map((g) => g.pgn);
      pgns.push(...batch);
    } catch {
      break;
    }
    // Previous month.
    mm--;
    if (mm < 1) { mm = 12; yyyy--; }
  }

  return pgns.slice(0, count);
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
