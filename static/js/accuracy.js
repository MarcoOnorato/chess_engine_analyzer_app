/**
 * @fileoverview Post-game accuracy panel: per-side accuracy and evaluation chart.
 *
 * Accuracy uses the standard exponential decay model on centipawn loss:
 *   accuracy(cpLoss) = 100 * exp(-0.0055 * cpLoss),  clamped to [0, 100]
 *
 * Both the accuracy values and the eval chart are computed from the *main
 * line* of the tree (the children[0] path from root). Variations the user
 * adds interactively are intentionally ignored here — accuracy is a property
 * of the played game, not of the analysis side-quests.
 *
 * The eval chart is a Chart.js line chart whose points are clickable: clicking
 * a point jumps the board to that ply on the main line via the callback the
 * caller provides.
 */

import { state, mainLineNodes } from "./state.js";

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
 * Plies at odd indices belong to White, even to Black (1-indexed ply).
 */
export function calculateGameAccuracy() {
  const ml = mainLineNodes();
  const whiteScores = [];
  const blackScores = [];

  ml.forEach((node) => {
    if (node.cpLoss == null) return;
    const acc = moveAccuracy(node.cpLoss);
    if (node.ply % 2 === 1) whiteScores.push(acc);
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
 * destroy the visual scale. The currently selected node is highlighted only
 * when it sits on the main line; if the cursor is in a variation the
 * highlight falls back to the nearest main-line ancestor.
 *
 * @param {(index: number) => void} onPointClick - Callback fired when the
 *   user clicks a point on the chart, receiving the 0-based main-line ply.
 */
export function renderEvalChart(onPointClick) {
  state.onEvalChartPointClick = onPointClick;
  const canvas = document.getElementById("evalChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const ml = mainLineNodes();
  const labels = ml.map((_, i) => Math.floor(i / 2) + 1);
  const data = ml.map((m) => {

    if (m.eval_mate != null) {
      return m.eval_mate > 0 ? 10 : -10;
    }
    if (m.eval != null) {
      return Math.max(-10, Math.min(10, m.eval));
    }
    return 0;
  });

  // Highlight: which 0-based index on the chart corresponds to currentNode?
  // -1 means no highlight (cursor at root).
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
          pointRadius: (context) => {
            const highlightIndex = mainLineHighlightIndex(ml);
            return context.dataIndex === highlightIndex ? 6 : 3;
          },
          
          pointBackgroundColor: (context) => {
            const highlightIndex = mainLineHighlightIndex(ml);
            return context.dataIndex === highlightIndex
              ? "#ffffff"
              : "#26bbff";
          },
          
          pointBorderColor: (context) => {
            const highlightIndex = mainLineHighlightIndex(ml);
            return context.dataIndex === highlightIndex
              ? "#ffffff"
              : "#26bbff";
          },
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
          titleColor: "#fff",
          titleFont: {
            size: 16,
            weight: "bold",
          },
          callbacks: {
            // Move SAN
            title: (items) => {
              const node = ml[items[0].dataIndex];
              return node ? node.san : "";
            },
        
            label: (context) => {
              const node = ml[context.dataIndex];
              if (!node) return "";
        
              const parts = [];
        
              // Eval
              if (node.eval_mate != null) {
                const mateStr =
                  node.eval_mate > 0
                    ? `M${node.eval_mate}`
                    : `M${Math.abs(node.eval_mate)}`;
        
                parts.push(`Eval: ${mateStr}`);
              } else if (node.eval != null) {
                const evalStr =
                  node.eval > 0
                    ? `+${node.eval.toFixed(1)}`
                    : node.eval.toFixed(1);
        
                parts.push(`Eval: ${evalStr}`);
              }
        
              // Classification
              if (node.evalData?.label) {
                parts.push(`Classification: ${node.evalData.label}`);
              }
        
              return parts;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#fff",
            callback: function (value, index) {
              if (index % 2 === 0) return Math.floor(index / 2) + 1;
              return "";
            },
          },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          min: -10,
          max: 10,
          ticks: {
            color: "#fff",
            callback: (value) => (value > 0 ? `+${value}` : value),
          },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    },
  });
}

/**
 * Returns the 0-based index into `ml` of the main-line node corresponding
 * to (or last main-line ancestor of) the current cursor. -1 if the cursor
 * is at the root or otherwise outside the line.
 *
 * @param {import("./state.js").Node[]} ml
 * @returns {number}
 */
function mainLineHighlightIndex(ml) {
  let n = state.currentNode;
  // Walk up to first main-line node.
  while (n && n.parent && !ml.includes(n)) n = n.parent;
  if (!n || n === state.root) return -1;
  return ml.indexOf(n);
}

/**
 * Helper to refresh eval chart in other modules
 */
export function refreshEvalChartHighlight() {
  if (!state.evalChart) return;
  state.evalChart.update();
}
