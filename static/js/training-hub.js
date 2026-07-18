/**
 * @fileoverview Training page entry point.
 *
 * The three flows used to be buttons on the Review page, which tied them to
 * whatever game happened to be loaded there. They now live here and each one
 * starts by choosing what to train on:
 *
 *   Train on a game    → shared source picker, then the game is analyzed
 *                        (or its stored analysis reused) and drilled.
 *   Train as a player  → a tracked Player DB profile, drilled by error type.
 *   Train vs engine    → shared source picker, then free play from a ply.
 *
 * All three render into the same #trainingModal overlay; closing it returns
 * to the cards on this page.
 */

import { openTrainOnGameModal } from "./training-game.js";
import { openTrainAsPlayerModal } from "./training-player.js";
import { openEngineTrainingModal } from "./engine-training.js";
import { api } from "./api.js";

function showHub() {
  const modal = document.getElementById("trainingModal");
  if (modal) modal.classList.add("hidden");
}

window.addEventListener("load", () => {
  document.getElementById("thubGameBtn").onclick = () =>
    openTrainOnGameModal({ onExit: showHub });

  document.getElementById("thubPlayerBtn").onclick = () =>
    openTrainAsPlayerModal({ onExit: showHub });

  document.getElementById("thubEngineBtn").onclick = () =>
    openEngineTrainingModal({ onExit: showHub });

  // "Train as a player" is only useful with tracked profiles behind it; say so
  // up front instead of letting the user discover an empty list.
  api.get("/api/players").then((profiles) => {
    const note = document.getElementById("thubPlayerNote");
    if (!note) return;
    note.textContent = profiles.length
      ? `${profiles.length} tracked profile(s) available for "Train as a player".`
      : `No tracked profiles yet — create one in the Players tab to unlock "Train as a player".`;
  }).catch(() => {});
});
