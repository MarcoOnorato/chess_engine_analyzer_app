/**
 * @fileoverview Review-board clocks.
 *
 * Loaded games (pasted PGN, Lichess, Chess.com, or a stored Player DB game) may
 * carry per-move clock times from the source PGN's `[%clk]` tags. `/api/load_pgn`
 * puts each move's remaining clock on its tree node (`node.clock`, seconds), so
 * the two readouts flanking the board can show each side's time as of whatever
 * position the cursor is on — no engine, no extra request.
 *
 * `renderClocks()` is called from the canonical cursor-refresh point
 * (`updatePgnNav`) plus on board flip, so it always matches what's on screen.
 */

import { state } from "./state.js";

/** Seconds -> "m:ss" (or "h:mm:ss" past an hour). */
function fmt(sec) {
  if (sec == null) return "--:--";
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Each side's remaining clock as of `node`: the clock left on that side's most
 * recent move at or before the cursor (walking up the tree so it works inside
 * variations too). Null until a side has moved.
 */
function clocksAtCursor(node) {
  let white = null;
  let black = null;
  for (let n = node; n && (white === null || black === null); n = n.parent) {
    if (n.clock == null || !n.ply) continue;
    if (n.ply % 2 === 1) {
      if (white === null) white = n.clock;
    } else if (black === null) {
      black = n.clock;
    }
  }
  return { white, black };
}

/** Side to move in the position on the board (after the cursor's move). */
function sideToMove(node) {
  if (!node || !node.ply) return "white";
  return node.ply % 2 === 1 ? "black" : "white";
}

function paint(el, isWhite, sec, toMove) {
  const name = isWhite ? state.whitePlayer || "White" : state.blackPlayer || "Black";
  el.querySelector(".clk-name").textContent = `${isWhite ? "⚪" : "⚫"} ${name}`;
  el.querySelector(".clk-time").textContent = fmt(sec);
  const active = (isWhite && toMove === "white") || (!isWhite && toMove === "black");
  el.classList.toggle("clk-active", active);
}

/** Paints both clock readouts, or hides them when the game has no clock data. */
export function renderClocks() {
  const top = document.getElementById("clockTop");
  const bottom = document.getElementById("clockBottom");
  if (!top || !bottom) return;

  if (!state.hasClocks) {
    top.classList.add("hidden");
    bottom.classList.add("hidden");
    return;
  }

  const { white, black } = clocksAtCursor(state.currentNode);
  const toMove = sideToMove(state.currentNode);
  const orient = state.board?.orientation ? state.board.orientation() : "white";
  const bottomIsWhite = orient !== "black";

  paint(bottom, bottomIsWhite, bottomIsWhite ? white : black, toMove);
  paint(top, !bottomIsWhite, bottomIsWhite ? black : white, toMove);
  top.classList.remove("hidden");
  bottom.classList.remove("hidden");
}
