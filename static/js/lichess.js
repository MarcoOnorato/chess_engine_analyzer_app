/**
 * @fileoverview Lichess import modal.
 *
 * Calls the public Lichess API:
 *   https://lichess.org/api/games/user/{username}
 * and renders the games. Selecting a game writes its
 * PGN into `#pgnInput` and triggers the standard PGN-loading flow.
 */

/**
 * Wires up the Lichess modal: open, close, fetch, and game selection.
 */
export function bindLichess() {
    const modal = document.getElementById("lichessModal");
    const usernameInput = document.getElementById("liUsername");
    const fetchBtn = document.getElementById("liFetchBtn");
  
    document.getElementById("openLichessBtn").onclick = () => {
      modal.classList.remove("hidden");
    };
  
    document.getElementById("closeLichess").onclick = () =>
      modal.classList.add("hidden");

    usernameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          fetchBtn.click();
        }
      });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.classList.add("hidden");
        usernameInput.focus();
        usernameInput.click();
        usernameInput.setSelectionRange(0, usernameInput.value.length);
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
        // pgnInJson=true to have the PGN in the json object
        const response = await fetch(
          `https://lichess.org/api/games/user/${username}?max=${count}&pgnInJson=true`,
          { headers: { Accept: "application/x-ndjson" } }
        );
  
        if (!response.ok)
          throw new Error("Lichess user not found or API error.");
  
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let { value, done } = await reader.read();
        let chunk = decoder.decode(value, { stream: true });
  
        // Lichess returns NDJSON [cite: 1]
        const lines = chunk.split("\n").filter((line) => line.trim() !== "");
        
        if (lines.length === 0) {
          listEl.innerHTML =
            "<div style='color: #888; text-align:center;'>No games found.</div>";
          return;
        }
  
        listEl.innerHTML = "";
  
        lines.forEach((line) => {
          const game = JSON.parse(line);
          const item = document.createElement("div");
          item.className = "opening-item";
  
          const white = game.players.white.user.name;
          const black = game.players.black.user.name;
          const dateStr = new Date(game.createdAt).toLocaleDateString();

          let result = "½-½";
          if (game.winner === "white") result = "1-0";
          else if (game.winner === "black") result = "0-1";
  
          item.innerHTML = `
            <span class="opening-name">${white} vs ${black} <span style="color:#aaa; font-size:0.8em; margin-left:5px;">(${result})</span></span>
            <span class="opening-moves">${dateStr} • ${game.speed} • ${game.variant}</span>
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
