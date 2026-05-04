/**
 * @fileoverview Chess.com import modal.
 *
 * Calls the public Chess.com archive endpoint:
 *   https://api.chess.com/pub/player/{user}/games/{YYYY}/{MM}
 * and renders the games (most recent first). Selecting a game writes its
 * PGN into `#pgnInput` and triggers the standard PGN-loading flow.
 *
 * Note: this hits Chess.com directly from the browser; CORS is allowed by
 * their public API so no backend proxy is needed.
 */

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
  };

  document.getElementById("closeChessCom").onclick = () =>
    modal.classList.add("hidden");

  usernameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      fetchBtn.click();
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
      const res = await fetch(
        `https://api.chess.com/pub/player/${username}/games/${year}/${month}`
      );
      if (!res.ok)
        throw new Error("User not found or no data for this month.");

      const data = await res.json();

      if (!data.games || data.games.length === 0) {
        listEl.innerHTML =
          "<div style='color: #888; text-align:center;'>No games found for this month.</div>";
        return;
      }

      listEl.innerHTML = "";
      const games = data.games.reverse(); // newest first

      games.forEach((game) => {
        if (!game.pgn) return;

        const item = document.createElement("div");
        item.className = "opening-item";

        const white = game.white.username;
        const black = game.black.username;
        const dateStr = new Date(game.end_time * 1000).toLocaleDateString();
        const result =
          game.white.result === "win"
            ? "1-0"
            : game.black.result === "win"
            ? "0-1"
            : "½-½";

          item.innerHTML = `
            <span class="opening-name">${white} vs ${black} <span style="color:#aaa; font-size:0.8em; margin-left:5px;">(${result})</span></span>
            <span class="opening-moves">${dateStr} • ${game.time_class}</span>
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
