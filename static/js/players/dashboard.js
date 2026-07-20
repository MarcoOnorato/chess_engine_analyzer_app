/**
 * @fileoverview Player dashboard rendering: KPIs, charts (via charts.js),
 * openings breakdown, per-time-control grouping and recent-games table.
 *
 * A time-control filter (All / bullet / blitz / rapid / ...) re-scopes the
 * KPIs, charts, openings, phases and the games list. The "By time control"
 * table always shows every bucket (the grouping overview), independent of the
 * active filter.
 */

import { api } from "./api.js";
import { renderWinrate, renderPhase, renderQuality, renderTrend } from "./charts.js";

let _profileId = null;
let _selectedTc = null; // null = all

// Recent-games pagination state. The page itself is fetched from the server
// (only one page of rows crosses the wire); `_lastPageGames` keeps the rows on
// screen so a review-depth tweak can relabel links without a round-trip.
let _gamesPage = 1;
let _gamesPageSize = 20;
let _gamesTotal = 0;
let _lastPageGames = [];

const TC_LABELS = {
  ultraBullet: "UltraBullet", bullet: "Bullet", blitz: "Blitz", rapid: "Rapid",
  classical: "Classical", daily: "Daily", correspondence: "Correspondence", unknown: "Unknown",
};

function tcLabel(tc) {
  return TC_LABELS[tc] || (tc ? tc[0].toUpperCase() + tc.slice(1) : "Unknown");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmt(v, suffix = "") {
  return v == null ? "--" : `${v}${suffix}`;
}

function kpiCard(value, label) {
  return `<div class="pdb-kpi"><div class="pdb-kpi-value">${value}</div><div class="pdb-kpi-label">${label}</div></div>`;
}

function wdlCell(o) {
  return `<span class="pdb-wdl"><span class="w">${o.win}W</span><span class="d">${o.draw}D</span><span class="l">${o.loss}L</span></span>`;
}

function resultLabel(res) {
  if (res === "win") return `<span class="pdb-res-win">Win</span>`;
  if (res === "loss") return `<span class="pdb-res-loss">Loss</span>`;
  if (res === "draw") return `<span class="pdb-res-draw">Draw</span>`;
  return "--";
}

function renderKpis(k, moveQuality = {}) {
  const el = document.getElementById("kpis");
  const wr = k.winrate == null ? "--" : `${k.winrate}%`;
  const clickable = k.brilliant > 0 ? " pdb-kpi-clickable" : "";
  const errors = (moveQuality.Blunder || 0) + (moveQuality.Miss || 0) + (moveQuality.Mistake || 0);
  const errClickable = errors > 0 ? " pdb-kpi-clickable" : "";
  el.innerHTML = [
    kpiCard(k.games, "Games"),
    kpiCard(wr, `Win rate (${k.wins}-${k.draws}-${k.losses})`),
    kpiCard(fmt(k.avg_accuracy, "%"), "Avg accuracy"),
    kpiCard(k.est_elo == null ? "--" : `~${k.est_elo}`, "Est. Elo"),
    `<div id="kpiBrilliant" class="pdb-kpi${clickable}" title="${k.brilliant > 0 ? "Explore the brilliant moves" : ""}">` +
      `<div class="pdb-kpi-value">${k.brilliant}</div>` +
      `<div class="pdb-kpi-label">Brilliant moves</div></div>`,
    `<div id="kpiErrors" class="pdb-kpi${errClickable}" title="${errors > 0 ? "Explore blunders & mistakes" : ""}">` +
      `<div class="pdb-kpi-value">${errors}</div>` +
      `<div class="pdb-kpi-label">Blunders &amp; mistakes</div></div>`,
  ].join("");

  const brilBtn = document.getElementById("kpiBrilliant");
  if (brilBtn && k.brilliant > 0) brilBtn.onclick = openBrilliants;
  const errBtn = document.getElementById("kpiErrors");
  if (errBtn && errors > 0) errBtn.onclick = openErrors;
}

/* -------------------------------------------------------------------------
   Brilliant-move explorer: a modal grid of the tracked player's brilliancies,
   each with a Unicode mini-board and a deep link into the Review page (jumping
   straight to that ply). Scoped to the active time-control filter.
   ------------------------------------------------------------------------- */

const PIECE_GLYPH = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};

/** FEN placement field -> 8x8 array; row 0 = rank 8, col 0 = file a. */
function fenToGrid(fen) {
  const ranks = String(fen || "").split(" ")[0].split("/");
  const grid = [];
  for (let r = 0; r < 8; r++) {
    const cells = [];
    for (const ch of ranks[r] || "8") {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < Number(ch); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    while (cells.length < 8) cells.push(null);
    grid.push(cells);
  }
  return grid;
}

/** Square name ("e4") -> [row, col] in the rank-8-first grid. */
function sqToRc(sq) {
  return [8 - Number(sq[1]), sq.charCodeAt(0) - 97];
}

/** Renders a static board from `fen`, oriented for `color`, with the from/to
 *  squares of `uci` highlighted. */
function miniBoard(fen, color, uci) {
  const grid = fenToGrid(fen);
  const hl = new Set();
  if (uci && uci.length >= 4) {
    for (const sq of [uci.slice(0, 2), uci.slice(2, 4)]) {
      const [r, c] = sqToRc(sq);
      hl.add(`${r},${c}`);
    }
  }
  const seq = [0, 1, 2, 3, 4, 5, 6, 7];
  const rows = color === "black" ? [...seq].reverse() : seq;
  const cols = color === "black" ? [...seq].reverse() : seq;
  let cells = "";
  for (const r of rows) {
    for (const c of cols) {
      const rankFromBottom = 8 - r;
      const light = (c + rankFromBottom - 1) % 2 === 1;
      const p = grid[r][c];
      const glyph = p ? `<span class="${p === p.toUpperCase() ? "wp" : "bp"}">${PIECE_GLYPH[p] || ""}</span>` : "";
      cells += `<div class="pdb-mini-sq ${light ? "light" : "dark"}${hl.has(`${r},${c}`) ? " hl" : ""}">${glyph}</div>`;
    }
  }
  return `<div class="pdb-mini">${cells}</div>`;
}

/** "⏱ 4.2s" think-time tag, or "" when the game carried no clocks. */
function thinkTag(b) {
  if (b.think_time == null) return "";
  const t = b.think_time >= 10 ? Math.round(b.think_time) : b.think_time.toFixed(1);
  return ` · ⏱ ${t}s`;
}

/** Position evaluation from the tracked player's perspective, as a short tag. */
function evalLabel(b) {
  const sign = b.player_color === "black" ? -1 : 1;
  if (b.eval_mate != null) {
    const m = b.eval_mate * sign;
    return `#${m < 0 ? "-" : ""}${Math.abs(m)}`;
  }
  if (b.eval == null) return "";
  const v = b.eval * sign;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function brilliantCard(b) {
  const color = b.player_color === "black" ? "black" : "white";
  const opp = b.player_color === "white" ? b.black : b.white;
  const date = b.played_at ? b.played_at.slice(0, 10) : "";
  const moveNo = Math.ceil(b.ply / 2);
  const dots = b.ply % 2 === 1 ? "." : "...";
  const ev = evalLabel(b);
  const d = reviewDepth();
  const href = `/?pgn_game=${b.game_id}&ply=${b.ply}${d ? `&depth=${d}` : ""}`;
  return `
    <div class="pdb-bril-card">
      ${miniBoard(b.fen_before, color, b.uci)}
      <div class="pdb-bril-move">${moveNo}${dots} ${esc(b.san)}!!</div>
      <div class="pdb-bril-meta">
        <div><span class="opp">${tcLabel(b.time_class)} vs ${esc(opp || "?")}</span></div>
        <div>${date}${b.opening ? " · " + esc(b.opening) : ""}${ev ? " · " + ev : ""}${thinkTag(b)}</div>
      </div>
      <a class="pdb-btn pdb-btn-ghost pdb-btn-sm" href="${href}">Open in Review</a>
    </div>`;
}

function closeBrilliants() {
  document.getElementById("brilliantsModal").classList.add("hidden");
  document.removeEventListener("keydown", onBrilliantsKey);
}

function onBrilliantsKey(e) {
  if (e.key === "Escape") closeBrilliants();
}

async function openBrilliants() {
  const modal = document.getElementById("brilliantsModal");
  const body = document.getElementById("brilliantsBody");
  body.innerHTML = `<div class="pdb-empty">Loading…</div>`;
  modal.classList.remove("hidden");

  document.getElementById("brilliantsClose").onclick = closeBrilliants;
  modal.onclick = (e) => { if (e.target === modal) closeBrilliants(); };
  document.addEventListener("keydown", onBrilliantsKey);

  let moves;
  try {
    moves = await api.brilliants(_profileId, _selectedTc);
  } catch (_) {
    body.innerHTML = `<div class="pdb-empty">Could not load brilliant moves.</div>`;
    return;
  }
  body.innerHTML = moves.length
    ? moves.map(brilliantCard).join("")
    : `<div class="pdb-empty">No brilliant moves for this filter.</div>`;
}

/* -------------------------------------------------------------------------
   Blunder / mistake explorer: the same modal grid as the brilliancies, but for
   the tracked player's worst moves — each card shows what was played, what the
   engine preferred, and how much it cost. Scoped to the active time filter.
   ------------------------------------------------------------------------- */

const ERROR_BADGE = {
  Blunder: { sym: "??", cls: "blunder" },
  Miss: { sym: "Ø", cls: "miss" },
  Mistake: { sym: "?", cls: "mistake" },
};

function errorCard(b) {
  const color = b.player_color === "black" ? "black" : "white";
  const opp = b.player_color === "white" ? b.black : b.white;
  const date = b.played_at ? b.played_at.slice(0, 10) : "";
  const moveNo = Math.ceil(b.ply / 2);
  const dots = b.ply % 2 === 1 ? "." : "...";
  const ev = evalLabel(b);
  const badge = ERROR_BADGE[b.label] || { sym: "?", cls: "mistake" };
  const loss = b.cp_loss == null ? "" : `−${(b.cp_loss / 100).toFixed(1)}`;
  const d = reviewDepth();
  const href = `/?pgn_game=${b.game_id}&ply=${b.ply}${d ? `&depth=${d}` : ""}`;
  const best = b.best_san ? `<span class="pdb-err-best">best: ${esc(b.best_san)}</span>` : "";
  return `
    <div class="pdb-bril-card pdb-err-card pdb-err-${badge.cls}">
      ${miniBoard(b.fen_before, color, b.uci)}
      <div class="pdb-bril-move">${moveNo}${dots} ${esc(b.san)}<span class="pdb-err-sym">${badge.sym}</span></div>
      <div class="pdb-err-line">${best}${loss ? `<span class="pdb-err-loss">${loss}</span>` : ""}</div>
      <div class="pdb-bril-meta">
        <div><span class="opp">${tcLabel(b.time_class)} vs ${esc(opp || "?")}</span></div>
        <div>${date}${b.opening ? " · " + esc(b.opening) : ""}${ev ? " · " + ev : ""}${thinkTag(b)}</div>
      </div>
      <a class="pdb-btn pdb-btn-ghost pdb-btn-sm" href="${href}">Open in Review</a>
    </div>`;
}

function closeErrors() {
  document.getElementById("errorsModal").classList.add("hidden");
  document.removeEventListener("keydown", onErrorsKey);
}

function onErrorsKey(e) {
  if (e.key === "Escape") closeErrors();
}

async function openErrors() {
  const modal = document.getElementById("errorsModal");
  const body = document.getElementById("errorsBody");
  body.innerHTML = `<div class="pdb-empty">Loading…</div>`;
  modal.classList.remove("hidden");

  document.getElementById("errorsClose").onclick = closeErrors;
  modal.onclick = (e) => { if (e.target === modal) closeErrors(); };
  document.addEventListener("keydown", onErrorsKey);

  // "Train on these" bridges to the Train-as-a-player flow for this profile.
  const trainLink = document.getElementById("errorsTrain");
  if (trainLink) trainLink.href = `/training?tap=${_profileId}`;

  let moves;
  try {
    moves = await api.errors(_profileId, _selectedTc);
  } catch (_) {
    body.innerHTML = `<div class="pdb-empty">Could not load mistakes.</div>`;
    return;
  }
  body.innerHTML = moves.length
    ? moves.map(errorCard).join("")
    : `<div class="pdb-empty">No blunders or mistakes for this filter. Nicely done.</div>`;
}

/** Downloads the profile's games (scoped to the active filter) as CSV. The
 *  attachment header makes the browser save it without navigating away. */
function exportGamesCsv() {
  if (_profileId == null) return;
  const q = _selectedTc ? `?time_class=${encodeURIComponent(_selectedTc)}` : "";
  window.location.href = `/api/players/${_profileId}/games.csv${q}`;
}

function renderFilter(timeControls) {
  const el = document.getElementById("tcFilter");
  const totalGames = timeControls.reduce((s, t) => s + t.games, 0);
  const btn = (tc, label, count, active) =>
    `<button class="pdb-tc-btn ${active ? "active" : ""}" data-tc="${tc == null ? "" : esc(tc)}">${label}<span class="pdb-tc-count">${count}</span></button>`;

  const buttons = [btn(null, "All", totalGames, _selectedTc == null)];
  timeControls.forEach((t) => {
    buttons.push(btn(t.time_class, tcLabel(t.time_class), t.games, _selectedTc === t.time_class));
  });
  el.innerHTML = buttons.join("");

  el.querySelectorAll(".pdb-tc-btn").forEach((b) => {
    b.onclick = () => {
      const tc = b.dataset.tc || null;
      if (tc === _selectedTc) return;
      selectTimeClass(tc);
    };
  });
}

function renderTimeControls(timeControls) {
  const el = document.getElementById("timeControlsTable");
  if (!timeControls.length) {
    el.innerHTML = `<div class="pdb-empty">No games yet.</div>`;
    return;
  }
  const rows = timeControls.map((t) => `
    <tr>
      <td>${tcLabel(t.time_class)}</td>
      <td class="num">${t.games}</td>
      <td>${wdlCell(t)}</td>
      <td class="num">${fmt(t.winrate, "%")}</td>
      <td class="num">${fmt(t.avg_accuracy, "%")}</td>
      <td class="num">${t.est_elo == null ? "--" : "~" + t.est_elo}</td>
    </tr>`).join("");
  el.innerHTML = `
    <table class="pdb-table">
      <thead><tr>
        <th>Time control</th><th class="num">Games</th><th>W/D/L</th>
        <th class="num">Win%</th><th class="num">Acc.</th><th class="num">Elo</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

const PHASE_LABEL = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };

/** Renders the time-management card: seconds/move overall and per phase, plus
 *  how many mistakes were made in time trouble. */
function renderTimeManagement(tm) {
  const el = document.getElementById("timeMgmt");
  if (!el) return;
  if (!tm || !tm.has_clocks) {
    el.innerHTML = `<div class="pdb-empty">No clock data in these games (the source PGNs carried no move times).</div>`;
    return;
  }
  const secs = (v) => (v == null ? "--" : `${v}s`);
  const maxPhase = Math.max(1, ...tm.by_phase.map((p) => p.avg_think || 0));
  const phaseRows = tm.by_phase.map((p) => {
    const w = p.avg_think ? Math.round((p.avg_think / maxPhase) * 100) : 0;
    return `
      <div class="pdb-time-row">
        <span class="pdb-time-phase">${PHASE_LABEL[p.phase] || p.phase}</span>
        <span class="pdb-time-bar-wrap"><span class="pdb-time-bar" style="width:${w}%"></span></span>
        <span class="pdb-time-val">${secs(p.avg_think)}<small>/move · ${p.moves} moves</small></span>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div class="pdb-time-top">
      <div class="pdb-time-kpi"><b>${secs(tm.avg_think)}</b><span>avg / move</span></div>
      <div class="pdb-time-kpi"><b>${tm.time_trouble_errors}</b><span>mistakes under ${tm.time_trouble_seconds}s</span></div>
    </div>
    <div class="pdb-time-phases">${phaseRows}</div>`;
}

function renderOpenings(openings) {
  const el = document.getElementById("openingsTable");
  if (!openings.length) {
    el.innerHTML = `<div class="pdb-empty">No games yet.</div>`;
    return;
  }
  const rows = openings.slice(0, 12).map((o) => `
    <tr>
      <td>${esc(o.opening)}</td>
      <td class="num">${o.games}</td>
      <td>${wdlCell(o)}</td>
    </tr>`).join("");
  el.innerHTML = `
    <table class="pdb-table">
      <thead><tr><th>Opening</th><th class="num">Games</th><th>W/D/L</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Depth requested for "Open in Review", or null to reuse each game's stored
 * analysis. A depth equal to the game's own ingestion depth also reuses it —
 * that decision lives in the Review page (see main.js).
 */
function reviewDepth() {
  const v = parseInt(document.getElementById("reviewDepth")?.value, 10);
  return Number.isFinite(v) ? v : null;
}

function reviewHref(game) {
  const d = reviewDepth();
  return `/?pgn_game=${game.id}${d ? `&depth=${d}` : ""}`;
}

function gamesRowsHtml(games) {
  return games.map((g) => {
    const date = g.played_at ? g.played_at.slice(0, 10) : "--";
    const opp = g.player_color === "white" ? g.black : g.white;
    const colorDot = g.player_color === "white" ? "⚪" : "⚫";
    return `
      <tr>
        <td>${date}</td>
        <td>${tcLabel(g.time_class)}</td>
        <td>${colorDot} vs ${esc(opp || "?")}</td>
        <td>${resultLabel(g.player_result)}</td>
        <td>${esc(g.opening || "--")}</td>
        <td class="num">${fmt(g.accuracy, "%")}</td>
        <td class="num">${g.est_elo == null ? "--" : "~" + g.est_elo}</td>
        <td class="num">d${g.analysis_depth ?? "?"}</td>
        <td><a class="pdb-btn pdb-btn-ghost pdb-btn-sm" href="${reviewHref(g)}">${
          reviewDepth() && reviewDepth() !== g.analysis_depth ? "Re-analyze in Review" : "Open in Review"
        }</a></td>
      </tr>`;
  }).join("");
}

function paginationHtml(page, totalPages, total, start, end) {
  const disFirst = page <= 1 ? "disabled" : "";
  const disLast = page >= totalPages ? "disabled" : "";
  return `
    <div class="pdb-pagination">
      <div class="pdb-pag-info">Showing ${start + 1}–${end} of ${total}</div>
      <div class="pdb-pag-controls">
        <button class="pdb-pag-btn" data-pg="first" ${disFirst} title="First page">«</button>
        <button class="pdb-pag-btn" data-pg="prev" ${disFirst} title="Previous page">‹</button>
        <span class="pdb-pag-page">Page ${page} / ${totalPages}</span>
        <button class="pdb-pag-btn" data-pg="next" ${disLast} title="Next page">›</button>
        <button class="pdb-pag-btn" data-pg="last" ${disLast} title="Last page">»</button>
        <label class="pdb-pag-size">Per page
          <input type="number" class="pdb-pag-size-input" min="1" value="${_gamesPageSize}">
        </label>
      </div>
    </div>`;
}

/** Fetches the current page of games (scoped to the active filter) and renders it. */
async function fetchGamesPage() {
  const size = Math.max(1, _gamesPageSize);
  let resp;
  try {
    resp = await api.games(_profileId, {
      timeClass: _selectedTc,
      limit: size,
      offset: (_gamesPage - 1) * size,
    });
  } catch (_) {
    return;
  }
  _gamesTotal = resp.total || 0;

  // The list may have shrunk (e.g. filter change): clamp and refetch once.
  const totalPages = Math.max(1, Math.ceil(_gamesTotal / size));
  if (_gamesPage > totalPages) {
    _gamesPage = totalPages;
    return fetchGamesPage();
  }
  _lastPageGames = resp.games || [];
  renderGamesPage();
}

/** Renders the last-fetched page of the recent-games table plus its controls. */
function renderGamesPage() {
  const el = document.getElementById("gamesTable");
  if (!_gamesTotal) {
    el.innerHTML = `<div class="pdb-empty">No games for this filter.</div>`;
    return;
  }

  const size = Math.max(1, _gamesPageSize);
  const totalPages = Math.max(1, Math.ceil(_gamesTotal / size));
  const start = (_gamesPage - 1) * size;
  const end = Math.min(start + _lastPageGames.length, _gamesTotal);

  el.innerHTML = `
    <table class="pdb-table">
      <thead><tr>
        <th>Date</th><th>Type</th><th>Opponent</th><th>Result</th><th>Opening</th>
        <th class="num">Acc.</th><th class="num">Elo</th><th class="num">Depth</th><th></th>
      </tr></thead>
      <tbody>${gamesRowsHtml(_lastPageGames)}</tbody>
    </table>
    ${paginationHtml(_gamesPage, totalPages, _gamesTotal, start, end)}`;

  el.querySelectorAll(".pdb-pag-btn").forEach((b) => {
    if (b.disabled) return;
    b.onclick = () => {
      const action = b.dataset.pg;
      if (action === "first") _gamesPage = 1;
      else if (action === "prev") _gamesPage -= 1;
      else if (action === "next") _gamesPage += 1;
      else if (action === "last") _gamesPage = totalPages;
      fetchGamesPage();
    };
  });

  const sizeInput = el.querySelector(".pdb-pag-size-input");
  if (sizeInput) {
    sizeInput.onchange = () => {
      const v = parseInt(sizeInput.value, 10);
      _gamesPageSize = Number.isFinite(v) && v > 0 ? v : _gamesPageSize;
      _gamesPage = 1;
      fetchGamesPage();
    };
  }
}

/** Renders the filter-dependent parts (KPIs, charts, openings, phases, games). */
function paintScoped(stats) {
  renderKpis(stats.kpis, stats.move_quality);
  renderWinrate("chartWinrate", stats.winrate);
  renderPhase("chartPhase", stats.phases);
  renderQuality("chartQuality", stats.move_quality);
  renderTrend("chartTrend", stats.trend);
  renderOpenings(stats.openings);
  renderTimeManagement(stats.time_management);

  _gamesPage = 1;
  fetchGamesPage();
}

async function selectTimeClass(tc) {
  _selectedTc = tc;
  let stats;
  try {
    stats = await api.stats(_profileId, tc);
  } catch (_) {
    return;
  }
  renderFilter(stats.time_controls);
  paintScoped(stats);
}

/**
 * Fetches and renders the whole dashboard for a profile (resets to "All").
 * @param {number} profileId
 */
export async function renderDashboard(profileId) {
  _profileId = profileId;
  _selectedTc = null;

  const stats = await api.stats(profileId);

  const p = stats.profile || {};
  const titleEl = document.getElementById("dashTitle");
  const meta = [p.platform, p.username].filter(Boolean).join(" · ");
  titleEl.innerHTML = `${esc(p.label || "Player")}<small>${esc(meta)}</small>`;

  // Changing the review depth only rewrites the row links/labels of the page
  // already on screen — no refetch needed.
  const depthEl = document.getElementById("reviewDepth");
  if (depthEl) depthEl.oninput = () => renderGamesPage();

  // Bridge to the "Train as a player" flow for this profile.
  const trainBtn = document.getElementById("dashTrainBtn");
  if (trainBtn) trainBtn.href = `/training?tap=${profileId}`;

  // CSV export follows the active time-control filter.
  const exportBtn = document.getElementById("dashExportBtn");
  if (exportBtn) exportBtn.onclick = () => exportGamesCsv();

  renderFilter(stats.time_controls);
  renderTimeControls(stats.time_controls);
  paintScoped(stats);
}

/**
 * Re-fetches and repaints the dashboard already on screen, keeping the active
 * time-control filter and (as far as it still exists) the current games page.
 * Used to follow an ingest job live, so the dashboard stays consultable and
 * shows the games analyzed so far.
 */
export async function refreshDashboard() {
  if (_profileId == null) return;
  const page = _gamesPage;

  const stats = await api.stats(_profileId, _selectedTc);

  renderFilter(stats.time_controls);
  renderTimeControls(stats.time_controls);
  paintScoped(stats); // resets to page 1
  _gamesPage = page;
  fetchGamesPage(); // refetches and clamps the page if the list shrank
}
