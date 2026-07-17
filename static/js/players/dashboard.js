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
  el.innerHTML = [
    kpiCard(k.games, "Games"),
    kpiCard(wr, `Win rate (${k.wins}-${k.draws}-${k.losses})`),
    kpiCard(fmt(k.avg_accuracy, "%"), "Avg accuracy"),
    kpiCard(k.est_elo == null ? "--" : `~${k.est_elo}`, "Est. Elo"),
    kpiCard(k.brilliant, "Brilliant moves"),
  ].join("");
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

function renderGames(games) {
  const el = document.getElementById("gamesTable");
  if (!games.length) {
    el.innerHTML = `<div class="pdb-empty">No games for this filter.</div>`;
    return;
  }
  const rows = games.slice(0, 60).map((g) => {
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
        <td><a class="pdb-btn pdb-btn-ghost pdb-btn-sm" href="/?pgn_game=${g.id}">Open in Review</a></td>
      </tr>`;
  }).join("");
  el.innerHTML = `
    <table class="pdb-table">
      <thead><tr>
        <th>Date</th><th>Type</th><th>Opponent</th><th>Result</th><th>Opening</th>
        <th class="num">Acc.</th><th class="num">Elo</th><th class="num">Depth</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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
  renderGames(games);
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

  renderFilter(stats.time_controls);
  renderTimeControls(stats.time_controls);
  paintScoped(stats);
}
