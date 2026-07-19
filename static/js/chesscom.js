/**
 * @fileoverview Chess.com import modal.
 *
 * Renders one month of the games returned by `archives.fetchChessComGames`
 * (most recent first). Selecting a game hands its PGN to the standard
 * PGN-loading flow.
 */

import { fetchChessComGames, gameDate } from "./archives.js";
import { submitOnEnter } from "./form-enter.js";

/**
 * Wires up the Chess.com modal: open, close, fetch, and game selection.
 */
export function bindChessCom() {
  const modal = document.getElementById("chessComModal");
  const usernameInput = document.getElementById("ccUsername");
  const fetchBtn = document.getElementById("ccFetchBtn");

  document.getElementById("openChessComBtn").onclick = () => {
    const now = new Date();
    if (!document.getElementById("ccYear").value) {
      document.getElementById("ccYear").value = now.getFullYear();
      document.getElementById("ccMonth").value = now.getMonth() + 1;
    }
    modal.classList.remove("hidden");
    usernameInput.focus();
    usernameInput.click();
    usernameInput.setSelectionRange(0, usernameInput.value.length);
  };

  document.getElementById("closeChessCom").onclick = () =>
    modal.classList.add("hidden");

  submitOnEnter([usernameInput, "ccYear", "ccMonth"], fetchBtn);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
    }
  });

  document.getElementById("ccFetchBtn").onclick = async () => {
    const username = document.getElementById("ccUsername").value.trim();
    const year = document.getElementById("ccYear").value;
    const month = document.getElementById("ccMonth").value.padStart(2, "0");
    const listEl = document.getElementById("ccGamesList");

    if (!username || !year || !month) return;

    listEl.innerHTML =
      "<div style='color: #888; text-align:center;'>Fetching games... ⏳</div>";

    try {
      const games = await fetchChessComGames(username, year, month);

      if (games.length === 0) {
        listEl.innerHTML =
          "<div style='color: #888; text-align:center;'>No games found for this month.</div>";
        return;
      }

      listEl.innerHTML = "";

      games.forEach((game) => {
        const item = document.createElement("div");
        item.className = "opening-item";

        item.innerHTML = `
          <span class="opening-name">${game.white} vs ${game.black} <span style="color:#aaa; font-size:0.8em; margin-left:5px;">(${game.result})</span></span>
          <span class="opening-moves">${gameDate(game)} • ${game.meta}</span>
        `;

        item.onclick = () => {
          modal.classList.add("hidden");

          if (window.loadAndAnalyze) {
            window.loadAndAnalyze(game.pgn);
          } else {
            console.error("loadAndAnalyze not found in window");
          }
        };

        listEl.appendChild(item);
      });
    } catch (e) {
      listEl.innerHTML = `<div style='color: #e6912c; text-align:center;'>Error: ${e.message}</div>`;
    }
  };
}
