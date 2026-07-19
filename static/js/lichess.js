/**
 * @fileoverview Lichess import modal.
 *
 * Renders the games returned by `archives.fetchLichessGames`. Selecting a game
 * hands its PGN to the standard PGN-loading flow.
 */

import { fetchLichessGames, gameDate } from "./archives.js";
import { submitOnEnter } from "./form-enter.js";

/**
 * Wires up the Lichess modal: open, close, fetch, and game selection.
 */
export function bindLichess() {
    const modal = document.getElementById("lichessModal");
    const usernameInput = document.getElementById("liUsername");
    const fetchBtn = document.getElementById("liFetchBtn");
  
    document.getElementById("openLichessBtn").onclick = () => {
      modal.classList.remove("hidden");
      usernameInput.focus();
      usernameInput.click();
      usernameInput.setSelectionRange(0, usernameInput.value.length);
    };

    document.getElementById("closeLichess").onclick = () =>
      modal.classList.add("hidden");

    submitOnEnter([usernameInput, "liCount"], fetchBtn);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.classList.add("hidden");
      }
    });
  
    document.getElementById("liFetchBtn").onclick = async () => {
      const username = document.getElementById("liUsername").value.trim();
      const count = document.getElementById("liCount").value || 10;
      const listEl = document.getElementById("liGamesList");
  
      if (!username) return;
  
      listEl.innerHTML =
        "<div style='color: #888; text-align:center;'>Fetching Lichess games... ⏳</div>";
  
      try {
        const games = await fetchLichessGames(username, count);

        if (games.length === 0) {
          listEl.innerHTML =
            "<div style='color: #888; text-align:center;'>No games found.</div>";
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
