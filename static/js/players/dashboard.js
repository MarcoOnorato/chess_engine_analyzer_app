/**
 * @fileoverview Player dashboard rendering: KPIs, charts (via charts.js),
 * openings breakdown and recent-games table. Data comes from
 * GET /api/players/<id>/stats and /games.
 */

import { api } from "./api.js";
import { renderWinrate, renderPhase, renderQuality, renderTrend } from "./charts.js";

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
    el.innerHTML = `<div class="pdb-empty">No games imported yet.</div>`;
    return;
  }
  const rows = games.slice(0, 50).map((g) => {
    const date = g.played_at ? g.played_at.slice(0, 10) : "--";
    const opp = g.player_color === "white" ? g.black : g.white;
    const colorDot = g.player_color === "white" ? "⚪" : "⚫";
    return `
      <tr>
        <td>${date}</td>
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
        <th>Date</th><th>Opponent</th><th>Result</th><th>Opening</th>
        <th class="num">Acc.</th><th class="num">Elo</th><th class="num">Depth</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Fetches and renders the whole dashboard for a profile.
 * @param {number} profileId
 */
export async function renderDashboard(profileId) {
  const [stats, games] = await Promise.all([api.stats(profileId), api.games(profileId)]);

  const p = stats.profile || {};
  const titleEl = document.getElementById("dashTitle");
  const meta = [p.platform, p.username].filter(Boolean).join(" · ");
  titleEl.innerHTML = `${esc(p.label || "Player")}<small>${esc(meta)}</small>`;

  renderKpis(stats.kpis);
  renderWinrate("chartWinrate", stats.winrate);
  renderPhase("chartPhase", stats.phases);
  renderQuality("chartQuality", stats.move_quality);
  renderTrend("chartTrend", stats.trend);
  renderOpenings(stats.openings);
  renderGames(games);
}
