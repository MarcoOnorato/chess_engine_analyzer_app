/**
 * @fileoverview Chart.js builders for the player dashboard. Each builder owns
 * its canvas and destroys the previous chart instance before redrawing.
 *
 * Move-quality colors mirror game-review.js::LABEL_ORDER so the dashboard reads
 * consistently with the single-game Review panel.
 */

const TEXT = "#9fb3c8";
const GRID = "rgba(255,255,255,0.06)";
const ACCENT = "#26bbff";

const QUALITY_META = [
  { label: "Brilliant", color: "#15a2b8" },
  { label: "Best", color: "#26bbff" },
  { label: "Excellent", color: "#96bc4b" },
  { label: "Good", color: "#96bc4b" },
  { label: "Inaccuracy", color: "#f0c15c" },
  { label: "Mistake", color: "#e6912c" },
  { label: "Miss", color: "#ff7769" },
  { label: "Blunder", color: "#b33430" },
];

const _instances = {};

function mount(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_instances[canvasId]) _instances[canvasId].destroy();
  _instances[canvasId] = new Chart(canvas.getContext("2d"), config);
}

const baseScales = {
  x: { ticks: { color: TEXT }, grid: { color: GRID } },
  y: { ticks: { color: TEXT }, grid: { color: GRID }, beginAtZero: true },
};

export function renderWinrate(canvasId, winrate) {
  const o = winrate.overall || { win: 0, draw: 0, loss: 0 };
  mount(canvasId, {
    type: "doughnut",
    data: {
      labels: ["Wins", "Draws", "Losses"],
      datasets: [{
        data: [o.win, o.draw, o.loss],
        backgroundColor: ["#96bc4b", "#7c8b99", "#b33430"],
        borderColor: "#0b1a2e",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: TEXT } } },
    },
  });
}

export function renderPhase(canvasId, phases) {
  const labels = phases.map((p) => p.phase[0].toUpperCase() + p.phase.slice(1));
  mount(canvasId, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Accuracy %",
        data: phases.map((p) => p.accuracy),
        backgroundColor: ACCENT,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { ...baseScales, y: { ...baseScales.y, max: 100 } },
    },
  });
}

export function renderQuality(canvasId, moveQuality) {
  mount(canvasId, {
    type: "bar",
    data: {
      labels: QUALITY_META.map((q) => q.label),
      datasets: [{
        label: "Moves",
        data: QUALITY_META.map((q) => moveQuality[q.label] || 0),
        backgroundColor: QUALITY_META.map((q) => q.color),
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: baseScales,
    },
  });
}

export function renderTrend(canvasId, trend) {
  const labels = trend.map((t, i) => {
    if (t.played_at) return t.played_at.slice(0, 10);
    return `#${i + 1}`;
  });
  mount(canvasId, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Accuracy %",
        data: trend.map((t) => t.accuracy),
        borderColor: ACCENT,
        backgroundColor: "rgba(38,187,255,0.12)",
        fill: true,
        tension: 0.25,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { ...baseScales, y: { ...baseScales.y, max: 100 } },
    },
  });
}

export function destroyAll() {
  Object.values(_instances).forEach((c) => c.destroy());
  Object.keys(_instances).forEach((k) => delete _instances[k]);
}
