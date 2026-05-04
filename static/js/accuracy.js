/**
 * @fileoverview Post-game accuracy panel: per-side accuracy and evaluation chart.
 *
 * Accuracy uses the standard exponential decay model on centipawn loss:
 *   accuracy(cpLoss) = 100 * exp(-0.0045 * cpLoss),  clamped to [0, 100]
 *
 * The eval chart is a Chart.js line chart whose points are clickable: clicking
 * a point jumps the board to that move via `jumpToMainLineFromChart` (provided
 * by the navigation module to avoid a circular import).
 */

import { state } from "./state.js";

/**
 * Maps a centipawn loss for a single move to an accuracy score in [0, 100].
 *
 * @param {number} cpLoss - Centipawn loss compared to the engine's best move.
 * @returns {number} Accuracy percentage (0–100).
 */
export function moveAccuracy(cpLoss) {
  return Math.max(0, Math.min(100, 100 * Math.exp(-0.0055 * cpLoss)));
}

/**
 * Computes per-side average accuracy across the main line and writes the
 * results into the DOM (`#whiteAccuracy`, `#blackAccuracy`).
 *
 * Plies at even indices belong to White, odd to Black.
 */
export function calculateGameAccuracy() {
  const whiteScores = [];
  const blackScores = [];

  state.historyMain.forEach((move, i) => {
    if (move.cpLoss == null) return;
    const acc = moveAccuracy(move.cpLoss);
    if (i % 2 === 0) whiteScores.push(acc);
    else blackScores.push(acc);
  });

  const avg = (arr) =>
    arr.length
      ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)
      : "--";

  document.getElementById("whiteAccuracy").textContent = `${avg(whiteScores)}%`;
  document.getElementById("blackAccuracy").textContent = `${avg(blackScores)}%`;
}

/**
 * (Re)builds the evaluation chart over the main line.
 *
 * Evaluation values are clamped to [-10, +10] so a single mate score doesn't
 * destroy the visual scale. The currently selected move is highlighted with
 * a larger, white-filled point.
 *
 * @param {(index: number) => void} onPointClick - Callback fired when the
 *   user clicks a point on the chart, receiving the 0-based move index.
 */
export function renderEvalChart(onPointClick) {
  const ctx = document.getElementById("evalChart").getContext("2d");

  const labels = state.historyMain.map((_, i) => i + 1);
  const data = state.historyMain.map((m) => {
    const val = m.eval ?? 0;
    return Math.max(-10, Math.min(10, val));
  });

  if (state.evalChart) state.evalChart.destroy();

  state.evalChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          tension: 0.25,
          fill: true,
          borderColor: "#26bbff",
          backgroundColor: "rgba(38, 187, 255, 0.1)",
          pointRadius: (context) =>
            context.dataIndex === state.currentMainlineIndex - 1 ? 6 : 3,
          pointBackgroundColor: (context) =>
            context.dataIndex === state.currentMainlineIndex - 1
              ? "#ffffff"
              : "#26bbff",
          pointBorderColor: (context) =>
            context.dataIndex === state.currentMainlineIndex - 1
              ? "#ffffff"
              : "#26bbff",
          pointHoverRadius: 7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        onPointClick(elements[0].index);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: () => null,
            label: (context) => {
              const move = state.historyMain[context.dataIndex];
              return move ? move.san : "";
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#888" },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          min: -10,
          max: 10,
          ticks: {
            color: "#888",
            callback: (value) => (value > 0 ? `+${value}` : value),
          },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    },
  });
}
