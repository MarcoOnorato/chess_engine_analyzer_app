/**
 * @fileoverview Openings catalogue modal.
 *
 * On first open the modal lazy-loads the opening list from `/api/list_openings`
 * and caches it in `state.cachedOpenings`. The search input filters the
 * cached list locally without re-hitting the backend.
 *
 * Selecting an opening writes its PGN into `#pgnInput` and clicks the
 * "Load PGN" button, reusing the same loading pipeline as a manual paste.
 */

import { state } from "./state.js";

/**
 * Renders the cached openings filtered by `filterText` into the modal list.
 *
 * @param {string} [filterText=""] - Substring filter (case-insensitive).
 */
function renderOpeningsList(filterText = "") {
  const listEl = document.getElementById("openingsList");
  const modal = document.getElementById("openingsModal");
  listEl.innerHTML = "";
  const query = filterText.toLowerCase();

  for (const [name, pgn] of Object.entries(state.cachedOpenings)) {
    if (!name.toLowerCase().includes(query)) continue;

    const item = document.createElement("div");
    item.className = "opening-item";
    const pgnString = Array.isArray(pgn) ? pgn[0] : pgn;

    item.innerHTML = `
      <span class="opening-name">${name}</span>
      <span class="opening-moves">${pgnString.substring(0, 50)}...</span>
    `;
    item.onclick = () => {
      modal.classList.add("hidden");
      
      // Imposta esplicitamente il nome dell'apertura nello stato e nella UI
      state.currentOpeningName = name;
      const displayEl = document.getElementById("openingName");
      if (displayEl) {
        displayEl.textContent = name;
      }

      if (window.loadAndAnalyze) {
        window.loadAndAnalyze(pgnString);
      } else {
        console.error("loadAndAnalyze non trovata");
      }
    };
    listEl.appendChild(item);
  }

  if (listEl.innerHTML === "") {
    listEl.innerHTML = "<div style='color: #888;'>No openings found.</div>";
  }
}

/**
 * Wires up the openings modal: open / close / search.
 */
export function bindOpenings() {
  const modal = document.getElementById("openingsModal");

  document.getElementById("openingsBtn").onclick = async () => {
    const listEl = document.getElementById("openingsList");
    listEl.innerHTML = "Loading...";
    document.getElementById("openingSearch").value = "";
    modal.classList.remove("hidden");

    try {
      const response = await fetch("/api/list_openings");
      state.cachedOpenings = await response.json();
      renderOpeningsList("");
    } catch (e) {
      listEl.innerHTML = "Error loading openings.";
    }
  };

  document.getElementById("openingSearch").addEventListener("input", (e) => {
    renderOpeningsList(e.target.value);
  });

  document.getElementById("closeOpenings").onclick = () =>
    modal.classList.add("hidden");
}
