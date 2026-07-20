/**
 * @fileoverview Post-game "Game Review" panel: chess.com-style estimated
 * Elo (overall and per game phase), phase accuracy, and a move-quality
 * breakdown (Brilliant → Blunder counts) per side.
 *
 * Everything here is derived from data already attached to main-line nodes
 * by the PGN analysis pipeline (`node.cpLoss`, `node.eval`, `node.evalData`,
 * `node.opening`) — no extra backend calls. The Elo estimate is a rough,
 * clearly-labeled heuristic (piecewise-linear over win%-based accuracy), not a
 * rating computation — chess.com's own algorithm is not public.
 */

import { mainLineNodes, state } from "./state.js";
import { moveWinLoss, accuracyFromWinLoss } from "./accuracy.js";

const PANEL_ID = "gameReviewPanel";
const BODY_ID = "gameReviewBody";

/**
 * Opening-phase ply bounds. `get_best_opening_name` matching is flaky move
 * to move (it can report "Custom Position" for a ply sandwiched between two
 * recognized book plies), so a single miss must not end the opening early.
 * Instead the opening always covers at least MIN_OPENING_PLY, and is
 * extended up to OPENING_PLY_CAP if book names keep being recognized past
 * that point.
 */
const MIN_OPENING_PLY = 20;
const OPENING_PLY_CAP = 40;

/** Non-pawn material (both sides) at/below this score counts as an endgame. */
const ENDGAME_MATERIAL_THRESHOLD = 20;

/** Non-pawn piece weights used for the material-based phase heuristic. */
const MATERIAL_WEIGHTS = { q: 9, r: 5, b: 3, n: 3 };

/** Move-quality categories, best → worst, mirroring app.py's classify_move(). */
const LABEL_ORDER = [
  { label: "Brilliant", symbol: "!!", color: "#15a2b8" },
  { label: "Best", symbol: "★", color: "#26bbff" },
  { label: "Excellent", symbol: "++", color: "#96bc4b" },
  { label: "Good", symbol: "+", color: "#96bc4b" },
  { label: "Inaccuracy", symbol: "?!", color: "#f0c15c" },
  { label: "Mistake", symbol: "?", color: "#e6912c" },
  { label: "Miss", symbol: "Ø", color: "#ff7769" },
  { label: "Blunder", symbol: "??", color: "#b33430" },
];

/**
 * Symbol + colour for a classification label. Used to rebuild `evalData` for
 * games replayed from a stored Player DB analysis, which only persists labels.
 * @param {string} label
 * @returns {{symbol: string, color: string}}
 */
export function labelStyle(label) {
  const hit = LABEL_ORDER.find((l) => l.label === label);
  return hit ? { symbol: hit.symbol, color: hit.color } : { symbol: "", color: "" };
}

/**
 * Accuracy% → estimated Elo. Strongly non-linear: win%-based accuracy compresses
 * near 100%, so Elo rises with the reciprocal of the "imperfection" (100 − acc):
 *   elo = ELO_A + ELO_B / (100 − accuracy),  clamped to [ELO_MIN, ELO_MAX].
 * A two-parameter fit to real Lichess ratings (blitz ~85% ↔ ~1250, rapid ~88% ↔
 * ~1540) and Carlsen/DrNykterstein (~93.2% ↔ ~2800). Kept in sync with
 * player_db/stats.py.
 */
const ELO_A = -90;
const ELO_B = 19800;
const ELO_MIN = 250;
const ELO_MAX = 3200;

const PHASES = ["opening", "middlegame", "endgame"];
const PHASE_LABELS = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };

/**
 * Per-move cp-loss cap for the ACPL / est-Elo averages. A single catastrophic
 * move (missed mate, hung queen) can lose thousands of centipawns, which would
 * dominate a raw mean and crater the estimate. Cap at ~10 pawns, as Lichess
 * does. Mirrors player_db/db.py::CP_LOSS_CAP.
 */
const CP_LOSS_CAP = 1000;

/**
 * Maps win%-based game accuracy to a rough estimated Elo via
 * elo = ELO_A + ELO_B / (100 − accuracy), clamped to [ELO_MIN, ELO_MAX].
 *
 * @param {number|null} accuracy
 * @returns {number|null}
 */
export function estimateElo(accuracy) {
  if (accuracy == null || Number.isNaN(accuracy)) return null;
  const gap = 100 - accuracy;
  if (gap <= 0) return ELO_MAX;
  return Math.round(Math.max(ELO_MIN, Math.min(ELO_MAX, ELO_A + ELO_B / gap)));
}

/**
 * Sums non-pawn, non-king piece weights from a FEN's piece-placement field
 * (both colors) as a rough "how much material is left" phase signal.
 *
 * @param {string} fen
 * @returns {number}
 */
function materialPhaseScore(fen) {
  const placement = fen.split(" ")[0];
  let score = 0;
  for (const ch of placement) {
    const weight = MATERIAL_WEIGHTS[ch.toLowerCase()];
    if (weight) score += weight;
  }
  return score;
}

function emptyBucket() {
  return { cpLossSum: 0, accSum: 0, count: 0 };
}

function addToBucket(bucket, cpLoss, acc) {
  bucket.cpLossSum += cpLoss;
  bucket.accSum += acc;
  bucket.count += 1;
}

function bucketStats(bucket) {
  if (!bucket.count) return { accuracy: null, acpl: null, elo: null };
  const acpl = bucket.cpLossSum / bucket.count;
  const accuracy = bucket.accSum / bucket.count;
  return { accuracy, acpl, elo: estimateElo(accuracy) };
}

/**
 * Walks the main line and buckets each move's accuracy/cpLoss by side and by
 * game phase (opening/middlegame/endgame), plus per-side move-quality counts.
 *
 * The opening/middlegame boundary is the furthest ply (up to OPENING_PLY_CAP)
 * with a recognized book name, or MIN_OPENING_PLY if that's further. Past
 * that, phase is monotonic (opening → middlegame → endgame never regresses):
 * once material drops at/below ENDGAME_MATERIAL_THRESHOLD the rest of the
 * game is "endgame".
 *
 * @returns {{white: Object, black: Object}|null} null if no game is loaded.
 */
export function computeGameReview() {
  const ml = mainLineNodes();
  if (!ml.length) return null;

  const sides = {
    white: { total: emptyBucket(), byPhase: { opening: emptyBucket(), middlegame: emptyBucket(), endgame: emptyBucket() }, labelCounts: {} },
    black: { total: emptyBucket(), byPhase: { opening: emptyBucket(), middlegame: emptyBucket(), endgame: emptyBucket() }, labelCounts: {} },
  };

  // Pass 1: find how far genuine book recognition extends (within the cap),
  // so a single flaky "Custom Position" miss mid-book doesn't end the
  // opening early. The opening always covers at least MIN_OPENING_PLY.
  let openingEndPly = MIN_OPENING_PLY;
  ml.forEach((node) => {
    if (node.ply > OPENING_PLY_CAP) return;
    const isBook = node.opening && node.opening !== "Custom Position" && node.opening !== "Starting Position";
    if (isBook) openingEndPly = Math.max(openingEndPly, node.ply);
  });

  // Pass 2: bucket each move by side and phase. Phase is monotonic — once
  // material drops into endgame territory it never reverts to opening/middlegame.
  let inEndgame = false;

  ml.forEach((node) => {
    if (node.cpLoss == null) return;
    const side = node.ply % 2 === 1 ? "white" : "black";

    if (materialPhaseScore(node.fenAfter) <= ENDGAME_MATERIAL_THRESHOLD) inEndgame = true;

    const phase = inEndgame ? "endgame" : (node.ply <= openingEndPly ? "opening" : "middlegame");
    // Accuracy uses full cp loss (win% saturates on its own); ACPL caps
    // outliers so one disaster move doesn't dominate the mean.
    const acc = accuracyFromWinLoss(moveWinLoss(node.eval, side, node.cpLoss));
    const cpLoss = Math.min(node.cpLoss, CP_LOSS_CAP);

    addToBucket(sides[side].total, cpLoss, acc);
    addToBucket(sides[side].byPhase[phase], cpLoss, acc);

    const label = node.evalData?.label;
    if (label) {
      sides[side].labelCounts[label] = (sides[side].labelCounts[label] || 0) + 1;
    }
  });

  return sides;
}

/**
 * (Re)builds the "Game Review" panel from the current main line. Hides the
 * panel (and no-ops otherwise) when no game is loaded yet. Content is written
 * into `#gameReviewBody`; the collapsible header lives in the static markup.
 */
export function renderGameReview() {
  const panel = document.getElementById(PANEL_ID);
  const body = document.getElementById(BODY_ID);
  if (!panel || !body) return;

  const data = computeGameReview();
  if (!data) {
    panel.classList.add("hidden");
    body.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  body.innerHTML = buildPanelHtml(data);
}

function buildPanelHtml(data) {
  const whiteName = state.whitePlayer || "White";
  const blackName = state.blackPlayer || "Black";
  const whiteTotal = bucketStats(data.white.total);
  const blackTotal = bucketStats(data.black.total);

  const phaseRows = PHASES.map((phase) => {
    const w = bucketStats(data.white.byPhase[phase]);
    const b = bucketStats(data.black.byPhase[phase]);
    return `
      <div class="gr-phase-label">${PHASE_LABELS[phase]}</div>
      ${phaseCellHtml(w, "#26bbff")}
      ${phaseCellHtml(b, "#f0c15c")}
    `;
  }).join("");

  // A single grid (label | white | black) keeps the player tiles, the phase
  // accuracy bars, and the move-quality columns all aligned to the same axes.
  return `
    <div class="gr-grid">
      <div class="gr-corner"></div>
      ${playerTileHtml(whiteName, whiteTotal, "gr-white")}
      ${playerTileHtml(blackName, blackTotal, "gr-black")}
      ${phaseRows}
    </div>
    <div class="gr-grid gr-breakdown">
      <div class="gr-corner"></div>
      ${breakdownColumnHtml(data.white.labelCounts)}
      ${breakdownColumnHtml(data.black.labelCounts)}
    </div>
  `;
}

function playerTileHtml(name, stats, sideClass) {
  const eloText = stats.elo != null ? `~${stats.elo}` : "--";
  const accText = stats.accuracy != null ? `${stats.accuracy.toFixed(1)}% accuracy` : "No moves yet";
  return `
    <div class="gr-player ${sideClass}">
      <div class="gr-player-name">${escapeHtml(name)}</div>
      <div class="gr-elo">${eloText}<span class="gr-elo-tag">est. Elo</span></div>
      <div class="gr-acc">${accText}</div>
    </div>
  `;
}

function phaseCellHtml(stats, barColor) {
  if (stats.accuracy == null) {
    return `<div class="gr-cell gr-cell-empty">—</div>`;
  }
  const pct = stats.accuracy.toFixed(1);
  const eloText = stats.elo != null ? `~${stats.elo}` : "--";
  return `
    <div class="gr-cell">
      <div class="gr-cell-acc">${pct}%</div>
      <div class="gr-bar"><div class="gr-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      <div class="gr-cell-elo">${eloText} Elo</div>
    </div>
  `;
}

function breakdownColumnHtml(labelCounts) {
  const rows = LABEL_ORDER.map(({ label, symbol, color }) => {
    const count = labelCounts[label] || 0;
    return `
      <div class="gr-row">
        <span class="gr-chip" style="color:${color}">${symbol}</span>
        <span class="gr-row-label">${label}</span>
        <span class="gr-row-count">${count}</span>
      </div>
    `;
  }).join("");
  return `<div class="gr-breakdown-col">${rows}</div>`;
}

/**
 * Wires the collapsible header so the review panel expands/collapses on click.
 * Called once at startup; the panel starts collapsed (see index.html).
 */
export function bindGameReviewToggle() {
  const panel = document.getElementById(PANEL_ID);
  const toggle = document.getElementById("gameReviewToggle");
  if (!panel || !toggle) return;

  toggle.onclick = () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
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
