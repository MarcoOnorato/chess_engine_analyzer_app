/**
 * @fileoverview Handoff of the game currently open in Review to the Training
 * tab.
 *
 * Training lives on its own page, so it cannot read the Review page's in-memory
 * tree. Review parks the PGN it just loaded in sessionStorage; the Training
 * source picker offers it as "Game open in Review" when it is there. Session
 * storage (not local) so closing the tab forgets it.
 */

const KEY = "chessAnalysis.reviewGame";

/**
 * @param {string} pgn
 * @param {string} label - Human-readable game name, e.g. "White vs Black".
 */
export function publishReviewGame(pgn, label) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ pgn, label }));
  } catch (_) {
    /* private mode / quota — the source just won't be offered */
  }
}

/** @returns {{pgn: string, label: string} | null} */
export function readReviewGame() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.pgn ? data : null;
  } catch (_) {
    return null;
  }
}
