/**
 * @fileoverview Unified "which game do you want to train on?" picker.
 *
 * Every training flow starts by choosing a source; they only differ in which
 * sources make sense and in what they do with the result. This module owns the
 * picker UI and turns any choice into one normalized shape:
 *
 *   {
 *     label,                       // human-readable, shown in the session badge
 *     pgn,                         // null for SOURCES.NEW
 *     startFen, fens, moves,       // main line, from /api/load_pgn
 *     stored,                      // Player DB analysis, or null
 *     userColor,                   // the profile's colour, when known
 *   }
 *
 * `stored` is what makes the Player DB source special: the analysis is already
 * in the database, so flows that need per-move evals can skip the engine
 * entirely. Every other source has to pay for its own analysis.
 *
 * The DOM helpers at the bottom are shared with the training flows, which used
 * to keep private copies of them.
 */

import { STARTING_FEN, state } from "./state.js";
import { api } from "./api.js";
import { fetchChessComGames, fetchLichessGames, gameDate } from "./archives.js";
import { readReviewGame } from "./training-handoff.js";
import { submitOnEnter } from "./form-enter.js";

export { submitOnEnter };

export const SOURCES = Object.freeze({
  NEW: "new",
  REVIEW: "review",
  PLAYER_DB: "playerdb",
  OPENING: "opening",
  PGN: "pgn",
  LICHESS: "lichess",
  CHESSCOM: "chesscom",
});

const SOURCE_LABELS = {
  [SOURCES.NEW]: "New game",
  [SOURCES.REVIEW]: "Open in Review",
  [SOURCES.PLAYER_DB]: "Player DB",
  [SOURCES.OPENING]: "Opening",
  [SOURCES.PGN]: "Paste PGN",
  [SOURCES.LICHESS]: "Lichess",
  [SOURCES.CHESSCOM]: "Chess.com",
};

/** Sources that arrive with a stored analysis — no engine pass needed. */
export const ANALYZED_SOURCES = [SOURCES.PLAYER_DB];

/* ==========================================================================
   Picker
   ========================================================================== */

/**
 * Renders the source buttons plus the fields for the active source.
 *
 * @param {HTMLElement} root      - Container to render into (emptied).
 * @param {Object}      opts
 * @param {string[]}    opts.sources - Source ids to offer, in order.
 * @param {string}      [opts.initial] - Initially selected source.
 * @returns {{ resolve: () => Promise<Object>, current: () => string }}
 */
export function renderSourcePicker(root, { sources, initial }) {
  root.innerHTML = "";

  const available = sources.filter(isAvailable);
  let source = available.includes(initial) ? initial : available[0];

  const row = el("div", "tap-platform-row");
  row.style.flexWrap = "wrap";
  const buttons = {};

  available.forEach((id) => {
    const b = el("button", "tap-platform-btn" + (id === source ? " active" : ""));
    b.type = "button";
    b.textContent = SOURCE_LABELS[id];
    b.style.setProperty("--platform-color", "#26bbff");
    b.onclick = () => {
      source = id;
      Object.values(buttons).forEach((btn) => btn.classList.remove("active"));
      b.classList.add("active");
      clearSelection();
      renderFields(fields, source);
    };
    buttons[id] = b;
    row.appendChild(b);
  });
  root.appendChild(row);

  const fields = el("div", "tap-import-wrap");
  fields.style.maxWidth = "100%";
  fields.style.padding = "0";
  renderFields(fields, source);
  root.appendChild(fields);

  return {
    current: () => source,
    resolve: () => resolveSource(source),
  };
}

/** A source is offered only when it can actually produce a game. */
function isAvailable(id) {
  if (id === SOURCES.REVIEW) return readReviewGame() !== null;
  return true;
}

/* ==========================================================================
   Per-source fields
   ========================================================================== */

function renderFields(root, source) {
  root.innerHTML = "";

  if (source === SOURCES.NEW) {
    root.appendChild(infoBox("Start from the normal initial position."));
    return;
  }

  if (source === SOURCES.REVIEW) {
    const game = readReviewGame();
    root.appendChild(infoBox(
      `Use the game currently open in the Review tab: ${game ? game.label : "—"}.`
    ));
    return;
  }

  if (source === SOURCES.PLAYER_DB) {
    renderPlayerDbFields(root);
    return;
  }

  if (source === SOURCES.OPENING) {
    root.appendChild(labeledInput("Opening search", "ts-opening-search", "text", ""));
    const list = el("div", "engine-source-list");
    list.id = "ts-opening-list";
    list.innerHTML = "<div class='dim'>Type to search openings.</div>";
    root.appendChild(list);
    document.getElementById("ts-opening-search").addEventListener("input", renderOpeningChoices);
    loadOpeningCache().then(renderOpeningChoices).catch(() => {
      list.innerHTML = "<div class='tap-error'>Could not load openings.</div>";
    });
    return;
  }

  if (source === SOURCES.PGN) {
    root.appendChild(labeledTextarea("PGN", "ts-pgn", "Paste a PGN here…"));
    return;
  }

  if (source === SOURCES.LICHESS) {
    const user = labeledInput("Lichess username", "ts-li-user", "text", "");
    root.appendChild(user);
    const count = labeledInput("Games to show", "ts-li-count", "number", "");
    count.querySelector("input").value = "10";
    root.appendChild(count);
    const fetchBtn = fetchListButton("Fetch Lichess games", fetchLichessChoices);
    root.appendChild(fetchBtn);
    root.appendChild(gameList("ts-remote-games"));
    submitOnEnter([user, count], fetchBtn);
    return;
  }

  if (source === SOURCES.CHESSCOM) {
    const user = labeledInput("Chess.com username", "ts-cc-user", "text", "");
    root.appendChild(user);
    const extras = el("div", "tap-extra-fields");
    const now = new Date();
    const year = labeledInput("Year", "ts-cc-year", "number", "");
    const month = labeledInput("Month", "ts-cc-month", "number", "");
    year.querySelector("input").value = String(now.getFullYear());
    month.querySelector("input").value = String(now.getMonth() + 1);
    extras.appendChild(year);
    extras.appendChild(month);
    root.appendChild(extras);
    const fetchBtn = fetchListButton("Fetch Chess.com games", fetchChessComChoices);
    root.appendChild(fetchBtn);
    root.appendChild(gameList("ts-remote-games"));
    submitOnEnter([user, year, month], fetchBtn);
  }
}

/**
 * Player DB: profile dropdown → game list. Selecting a game stashes both its
 * PGN and its id, so `resolveSource` can pull the stored analysis back.
 */
function renderPlayerDbFields(root) {
  const list = el("div", "engine-source-list");
  list.id = "ts-pdb-games";
  list.innerHTML = "<div class='dim'>Loading profiles…</div>";

  const profileWrap = el("div", "tap-field");
  root.appendChild(profileWrap);
  root.appendChild(list);

  api.get("/api/players").then((profiles) => {
    if (!profiles.length) {
      profileWrap.appendChild(infoBox(
        "No tracked profiles yet — create one in the Players tab and import some games."
      ));
      list.innerHTML = "";
      return;
    }
    const field = selectField(
      "Profile",
      "ts-pdb-profile",
      profiles.map((p) => [String(p.id), `${p.label} (${p.games_count || 0} games)`]),
      String(profiles[0].id),
    );
    profileWrap.replaceWith(field);
    const select = field.querySelector("select");
    select.onchange = () => loadProfileGames(select.value);
    loadProfileGames(select.value);
  }).catch(() => {
    list.innerHTML = "<div class='tap-error'>Could not load profiles.</div>";
  });
}

async function loadProfileGames(profileId) {
  const list = document.getElementById("ts-pdb-games");
  if (!list) return;
  list.innerHTML = "<div class='dim'>Loading games…</div>";
  try {
    const resp = await api.get(`/api/players/${profileId}/games`);
    const games = resp.games || [];
    list.innerHTML = "";
    if (!games.length) {
      list.innerHTML = "<div class='dim'>This profile has no games yet.</div>";
      return;
    }
    ensureHiddenInputs();
    games.forEach((g) => {
      const opp = g.player_color === "white" ? g.black : g.white;
      const item = el("button", "engine-source-item");
      item.type = "button";
      item.innerHTML =
        `<span>${escapeHtml(`${g.player_color === "white" ? "⚪" : "⚫"} vs ${opp || "?"}`)}</span>` +
        `<small>${escapeHtml(
          `${(g.played_at || "").slice(0, 10)} • ${g.opening || "—"} • depth ${g.analysis_depth ?? "?"}`
        )}</small>`;
      item.onclick = () => {
        document.getElementById("ts-selected-game").value = String(g.id);
        document.getElementById("ts-selected-pgn").value = "";
        list.querySelectorAll(".engine-source-item").forEach((n) => n.classList.remove("active"));
        item.classList.add("active");
      };
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = `<div class="tap-error">${escapeHtml(e.message)}</div>`;
  }
}

/* ==========================================================================
   Resolution
   ========================================================================== */

async function resolveSource(source) {
  if (source === SOURCES.NEW) {
    return {
      label: "New game", pgn: null, startFen: STARTING_FEN,
      fens: [STARTING_FEN], moves: [], stored: null, userColor: null,
    };
  }

  if (source === SOURCES.REVIEW) {
    const game = readReviewGame();
    if (!game) throw new Error("No game is open in the Review tab.");
    return parsePgnSource(game.pgn, game.label);
  }

  if (source === SOURCES.PLAYER_DB) {
    const gameId = document.getElementById("ts-selected-game")?.value;
    if (!gameId) throw new Error("Select a game first.");
    const data = await api.get(`/api/players/game/${gameId}/pgn`);
    const parsed = await parsePgnSource(
      data.pgn,
      `${data.white || "White"} vs ${data.black || "Black"}`,
    );
    return { ...parsed, stored: data, userColor: data.player_color || null };
  }

  if (source === SOURCES.OPENING) {
    const pgn = document.getElementById("ts-selected-pgn")?.value || "";
    if (!pgn) throw new Error("Select an opening first.");
    return parsePgnSource(pgn, "Opening");
  }

  if (source === SOURCES.PGN) {
    const pgn = document.getElementById("ts-pgn")?.value?.trim();
    if (!pgn) throw new Error("Paste a PGN first.");
    return parsePgnSource(pgn, "PGN");
  }

  const selected = document.getElementById("ts-selected-pgn")?.value || "";
  if (!selected) throw new Error("Fetch and select a game first.");
  return parsePgnSource(selected, source === SOURCES.LICHESS ? "Lichess game" : "Chess.com game");
}

async function parsePgnSource(pgn, label) {
  const data = await api("/api/load_pgn", { pgn });
  const startFen = data.start_fen || data.fens?.[0] || STARTING_FEN;
  return {
    label,
    pgn,
    startFen,
    fens: data.fens?.length ? data.fens : [startFen],
    moves: data.moves || [],
    stored: null,
    userColor: null,
  };
}

/* ==========================================================================
   Remote game lists
   ========================================================================== */

async function loadOpeningCache() {
  if (state.cachedOpenings && Object.keys(state.cachedOpenings).length) return state.cachedOpenings;
  state.cachedOpenings = await api.get("/api/list_openings");
  return state.cachedOpenings;
}

function renderOpeningChoices() {
  const list = document.getElementById("ts-opening-list");
  const query = (document.getElementById("ts-opening-search")?.value || "").toLowerCase();
  if (!list) return;
  list.innerHTML = "";

  const entries = Object.entries(state.cachedOpenings || {})
    .filter(([name]) => name.toLowerCase().includes(query))
    .slice(0, 30);

  if (!entries.length) {
    list.innerHTML = "<div class='dim'>No openings found.</div>";
    return;
  }

  ensureHiddenInputs();
  entries.forEach(([name, pgn]) => {
    const pgnString = Array.isArray(pgn) ? pgn[0] : pgn;
    const item = el("button", "engine-source-item");
    item.type = "button";
    item.innerHTML =
      `<span>${escapeHtml(name)}</span><small>${escapeHtml(String(pgnString).slice(0, 80))}…</small>`;
    item.onclick = () => {
      document.getElementById("ts-selected-pgn").value = pgnString;
      list.querySelectorAll(".engine-source-item").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
    };
    list.appendChild(item);
  });
}

async function fetchLichessChoices() {
  const username = document.getElementById("ts-li-user")?.value?.trim();
  const count = document.getElementById("ts-li-count")?.value || "10";
  if (!username) return;
  const list = document.getElementById("ts-remote-games");
  list.innerHTML = "<div class='dim'>Fetching…</div>";
  const games = await fetchLichessGames(username, count);
  renderRemoteGames(games.map((g) => ({
    pgn: g.pgn,
    label: `${g.white} vs ${g.black}`,
    meta: [gameDate(g), g.meta].filter(Boolean).join(" • "),
  })));
}

async function fetchChessComChoices() {
  const username = document.getElementById("ts-cc-user")?.value?.trim();
  const year = document.getElementById("ts-cc-year")?.value;
  const month = String(document.getElementById("ts-cc-month")?.value || "").padStart(2, "0");
  if (!username || !year || !month) return;
  const list = document.getElementById("ts-remote-games");
  list.innerHTML = "<div class='dim'>Fetching…</div>";
  const games = await fetchChessComGames(username, year, month);
  renderRemoteGames(games.map((g) => ({
    pgn: g.pgn,
    label: `${g.white} vs ${g.black}`,
    meta: [gameDate(g), g.meta].filter(Boolean).join(" • "),
  })));
}

function renderRemoteGames(games) {
  const list = document.getElementById("ts-remote-games");
  list.innerHTML = "";
  ensureHiddenInputs();
  if (!games.length) {
    list.innerHTML = "<div class='dim'>No games found.</div>";
    return;
  }
  games.forEach((g) => {
    const item = el("button", "engine-source-item");
    item.type = "button";
    item.innerHTML = `<span>${escapeHtml(g.label)}</span><small>${escapeHtml(g.meta)}</small>`;
    item.onclick = () => {
      document.getElementById("ts-selected-pgn").value = g.pgn;
      list.querySelectorAll(".engine-source-item").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
    };
    list.appendChild(item);
  });
}

/** Hidden carriers for the current selection, appended to the modal body. */
function ensureHiddenInputs() {
  const host = document.getElementById("trainingModalBody") || document.body;
  for (const id of ["ts-selected-pgn", "ts-selected-game"]) {
    if (document.getElementById(id)) continue;
    const input = el("input", "");
    input.type = "hidden";
    input.id = id;
    host.appendChild(input);
  }
}

function clearSelection() {
  for (const id of ["ts-selected-pgn", "ts-selected-game"]) {
    document.getElementById(id)?.remove();
  }
}

function fetchListButton(label, fn) {
  const btn = el("button", "training-cta tap-fetch-btn");
  btn.type = "button";
  btn.textContent = label;
  btn.onclick = async () => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "Fetching…";
    try {
      await fn();
    } catch (e) {
      const list = document.getElementById("ts-remote-games");
      if (list) list.innerHTML = `<div class="tap-error">Error: ${escapeHtml(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  return btn;
}

function gameList(id) {
  const list = el("div", "engine-source-list");
  list.id = id;
  list.innerHTML = "<div class='dim'>Fetch games, then select one.</div>";
  return list;
}

/* ==========================================================================
   Shared DOM helpers
   ========================================================================== */

export function infoBox(text) {
  const div = el("div", "training-fieldset");
  div.textContent = text;
  return div;
}

export function selectField(label, id, options, value) {
  const wrap = el("div", "tap-field");
  const lbl = el("label", "tap-label");
  lbl.textContent = label;
  lbl.htmlFor = id;
  const sel = el("select", "tap-input");
  sel.id = id;
  options.forEach(([val, text]) => {
    const opt = el("option", "");
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    sel.appendChild(opt);
  });
  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

export function labeledInput(labelText, id, type, placeholder) {
  const wrap = el("div", "tap-field");
  const lbl = el("label", "tap-label");
  lbl.textContent = labelText;
  lbl.htmlFor = id;
  const inp = el("input", "tap-input");
  inp.id = id;
  inp.type = type;
  if (placeholder) inp.placeholder = placeholder;
  wrap.appendChild(lbl);
  wrap.appendChild(inp);
  return wrap;
}

export function labeledTextarea(labelText, id, placeholder) {
  const wrap = el("div", "tap-field");
  const lbl = el("label", "tap-label");
  lbl.textContent = labelText;
  lbl.htmlFor = id;
  const txt = el("textarea", "tap-input");
  txt.id = id;
  txt.rows = 8;
  txt.placeholder = placeholder;
  wrap.appendChild(lbl);
  wrap.appendChild(txt);
  return wrap;
}

export function showErr(box, msg) {
  box.textContent = msg;
  box.classList.remove("hidden");
}

export function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
