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
let _allGames = [];

// Recent-games pagination state (page size persists across filter changes).
let _filteredGames = [];
let _gamesPage = 1;
let _gamesPageSize = 20;

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

function renderKpis(k) {
  const el = document.getElementById("kpis");
  const wr = k.winrate == null ? "--" : `${k.winrate}%`;
  const clickable = k.brilliant > 0 ? " pdb-kpi-clickable" : "";
  el.innerHTML = [
    kpiCard(k.games, "Games"),
    kpiCard(wr, `Win rate (${k.wins}-${k.draws}-${k.losses})`),
    kpiCard(fmt(k.avg_accuracy, "%"), "Avg accuracy"),
    kpiCard(k.est_elo == null ? "--" : `~${k.est_elo}`, "Est. Elo"),
    `<div id="kpiBrilliant" class="pdb-kpi${clickable}" title="${k.brilliant > 0 ? "Explore the brilliant moves" : ""}">` +
      `<div class="pdb-kpi-value">${k.brilliant}</div>` +
      `<div class="pdb-kpi-label">Brilliant moves</div></div>`,
  ].join("");

  const brilBtn = document.getElementById("kpiBrilliant");
  if (brilBtn && k.brilliant > 0) brilBtn.onclick = openBrilliants;
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
        <div>${date}${b.opening ? " · " + esc(b.opening) : ""}${ev ? " · " + ev : ""}</div>
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

/** Sets the games list to paginate and renders page 1. */
function setGames(list) {
  _filteredGames = list;
  _gamesPage = 1;
  renderGamesPage();
}

/** Renders the current page of the recent-games table plus its controls. */
function renderGamesPage() {
  const el = document.getElementById("gamesTable");
  const list = _filteredGames;
  if (!list.length) {
    el.innerHTML = `<div class="pdb-empty">No games for this filter.</div>`;
    return;
  }

  const size = Math.max(1, _gamesPageSize);
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  _gamesPage = Math.min(Math.max(1, _gamesPage), totalPages);

  const start = (_gamesPage - 1) * size;
  const end = Math.min(start + size, list.length);
  const pageItems = list.slice(start, end);

  el.innerHTML = `
    <table class="pdb-table">
      <thead><tr>
        <th>Date</th><th>Type</th><th>Opponent</th><th>Result</th><th>Opening</th>
        <th class="num">Acc.</th><th class="num">Elo</th><th class="num">Depth</th><th></th>
      </tr></thead>
      <tbody>${gamesRowsHtml(pageItems)}</tbody>
    </table>
    ${paginationHtml(_gamesPage, totalPages, list.length, start, end)}`;

  el.querySelectorAll(".pdb-pag-btn").forEach((b) => {
    if (b.disabled) return;
    b.onclick = () => {
      const action = b.dataset.pg;
      if (action === "first") _gamesPage = 1;
      else if (action === "prev") _gamesPage -= 1;
      else if (action === "next") _gamesPage += 1;
      else if (action === "last") _gamesPage = totalPages;
      renderGamesPage();
    };
  });

  const sizeInput = el.querySelector(".pdb-pag-size-input");
  if (sizeInput) {
    sizeInput.onchange = () => {
      const v = parseInt(sizeInput.value, 10);
      _gamesPageSize = Number.isFinite(v) && v > 0 ? v : _gamesPageSize;
      _gamesPage = 1;
      renderGamesPage();
    };
  }
}

/** Renders the filter-dependent parts (KPIs, charts, openings, phases, games). */
function paintScoped(stats) {
  renderKpis(stats.kpis);
  renderWinrate("chartWinrate", stats.winrate);
  renderPhase("chartPhase", stats.phases);
  renderQuality("chartQuality", stats.move_quality);
  renderTrend("chartTrend", stats.trend);
  renderOpenings(stats.openings);

  const games = _selectedTc
    ? _allGames.filter((g) => (g.time_class || "unknown") === _selectedTc)
    : _allGames;
  setGames(games);
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

  const [stats, games] = await Promise.all([api.stats(profileId), api.games(profileId)]);
  _allGames = games;

  const p = stats.profile || {};
  const titleEl = document.getElementById("dashTitle");
  const meta = [p.platform, p.username].filter(Boolean).join(" · ");
  titleEl.innerHTML = `${esc(p.label || "Player")}<small>${esc(meta)}</small>`;

  // Changing the review depth only rewrites the row links/labels.
  const depthEl = document.getElementById("reviewDepth");
  if (depthEl) depthEl.oninput = () => renderGamesPage();

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

  const [stats, games] = await Promise.all([
    api.stats(_profileId, _selectedTc),
    api.games(_profileId),
  ]);
  _allGames = games;

  renderFilter(stats.time_controls);
  renderTimeControls(stats.time_controls);
  paintScoped(stats); // resets to page 1
  _gamesPage = page;
  renderGamesPage(); // clamps the page if the list shrank
}
