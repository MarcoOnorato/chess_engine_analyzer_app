/**
 * @fileoverview "Train on a game" — pick a game, then drill it.
 *
 * This used to be a button on the Review page that could only ever train the
 * game already on the board. It now starts the same way "Train vs engine"
 * does: with the shared source picker. The peculiarity of this flow is that
 * the game must be *analyzed* before the position pickers can find anything to
 * train — so a game taken from the Player DB starts instantly on its stored
 * analysis, while every other source runs an engine pass first, at the depth
 * chosen here.
 *
 * Once the game is in `state`, the rest is the pre-existing flow: mode select
 * (Error / What-If / Resilience) → config → scenarios.
 */

import { openTrainingModal } from "./training.js";
import { loadGameIntoState } from "./training-load.js";
import { setHeader } from "./training-ui.js";
import {
  SOURCES,
  renderSourcePicker,
  submitOnEnter,
  el,
  escapeHtml,
  labeledInput,
  showErr,
} from "./training-source.js";

const BODY_ID = "trainingModalBody";
const DEFAULT_DEPTH = 12;

/** Where to return when the user leaves the flow (set by the caller). */
let onClose = null;

/**
 * @param {Object} [opts]
 * @param {() => void} [opts.onExit] - Called when the user leaves training.
 */
export function openTrainOnGameModal(opts = {}) {
  const modal = document.getElementById("trainingModal");
  if (!modal) return;
  onClose = typeof opts.onExit === "function" ? opts.onExit : null;
  modal.classList.remove("hidden");
  renderPickScreen();
}

function body() {
  return document.getElementById(BODY_ID);
}

function close() {
  const modal = document.getElementById("trainingModal");
  if (modal) modal.classList.add("hidden");
  onClose?.();
}

function renderPickScreen() {
  setHeader("Choose a game to train on", close);
  const root = body();
  root.innerHTML = "";

  const wrap = el("div", "tap-import-wrap");
  wrap.style.maxWidth = "760px";

  const sourceRoot = el("div", "");
  wrap.appendChild(sourceRoot);
  // No "new game" and no bare opening: there are no mistakes to replay in a
  // position nobody has played yet.
  const picker = renderSourcePicker(sourceRoot, {
    sources: [
      SOURCES.PLAYER_DB, SOURCES.REVIEW, SOURCES.PGN,
      SOURCES.LICHESS, SOURCES.CHESSCOM,
    ],
    initial: SOURCES.PLAYER_DB,
  });

  const depthField = labeledInput("Analysis depth", "tg-depth", "number", "");
  const depthInput = depthField.querySelector("input");
  depthInput.min = "8";
  depthInput.max = "30";
  depthInput.value = String(DEFAULT_DEPTH);
  wrap.appendChild(depthField);
  wrap.appendChild(hint(
    "Games from the Player DB reuse their stored analysis and start straight away; " +
    "the depth above only applies to the other sources."
  ));

  const err = el("div", "tap-error hidden");
  wrap.appendChild(err);

  const actions = el("div", "training-config-footer");
  const cancel = el("button", "");
  cancel.type = "button";
  cancel.textContent = "← Close";
  cancel.onclick = close;

  const start = el("button", "training-cta");
  start.type = "button";
  start.textContent = "Analyze & train →";
  start.onclick = async () => {
    err.classList.add("hidden");
    start.disabled = true;
    try {
      const source = await picker.resolve();
      const depth = clampDepth(depthInput.value);
      await analyzeThenTrain(source, depth);
    } catch (e) {
      showErr(err, e.message || "Could not prepare that game.");
      start.disabled = false;
      start.textContent = "Analyze & train →";
    }
  };

  actions.appendChild(cancel);
  actions.appendChild(start);
  wrap.appendChild(actions);
  submitOnEnter([depthField], start);

  root.appendChild(wrap);
}

async function analyzeThenTrain(source, depth) {
  const root = body();
  root.innerHTML = "";
  setHeader(`Analyzing ${source.label}`, close);

  const wrap = el("div", "tap-import-wrap");
  const bar = el("div", "tap-progress-bar-outer");
  const fill = el("div", "tap-progress-bar-inner");
  fill.style.width = "0%";
  bar.appendChild(fill);
  const label = el("div", "tap-analysing-sub");
  label.textContent = "Preparing…";
  wrap.appendChild(bar);
  wrap.appendChild(label);
  root.appendChild(wrap);

  const result = await loadGameIntoState(source, {
    depth,
    onProgress: (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      label.textContent = `Analyzing move ${Math.min(done + 1, total)} of ${total}…`;
    },
  });

  if (result.fromStore) {
    label.textContent = "Stored analysis loaded.";
  }

  openTrainingModal({
    userColor: source.userColor || "white",
    onExit: () => {
      if (onClose) onClose();
      else {
        const modal = document.getElementById("trainingModal");
        if (modal) modal.classList.add("hidden");
      }
    },
  });
}

function clampDepth(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_DEPTH;
  return Math.max(8, Math.min(30, n));
}

function hint(text) {
  const div = el("div", "tap-analysing-sub");
  div.innerHTML = escapeHtml(text);
  return div;
}
