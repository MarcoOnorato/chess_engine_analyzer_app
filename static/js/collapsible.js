/**
 * @fileoverview Collapsible "Load Game" panel.
 *
 * The panel containing Openings, Chess.com import, and PGN paste can be
 * collapsed to hide the controls and free up vertical space for the board
 * and analysis panels. After a successful PGN load, `collapseLoadPanel` is
 * called automatically (see `pgn.js`).
 *
 * The panel uses the `.collapsed` class on its wrapper element. The visual
 * transition itself is driven entirely by CSS (`max-height` + opacity).
 */

/** Selector for the collapsible card wrapper element. */
const PANEL_ID = "loadPanel";

/** Selector for the toggle button (chevron / label). */
const TOGGLE_ID = "loadPanelToggle";

/**
 * Collapses the load panel if it isn't already collapsed.
 */
export function collapseLoadPanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel && !panel.classList.contains("collapsed")) {
    panel.classList.add("collapsed");
    syncToggleLabel(true);
  }
}

/**
 * Expands the load panel if it's currently collapsed.
 */
export function expandLoadPanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel && panel.classList.contains("collapsed")) {
    panel.classList.remove("collapsed");
    syncToggleLabel(false);
  }
}

/**
 * Updates the toggle button's chevron / aria-expanded state.
 *
 * @param {boolean} collapsed - True when the panel is currently collapsed.
 */
function syncToggleLabel(collapsed) {
  const toggle = document.getElementById(TOGGLE_ID);
  if (!toggle) return;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  // The chevron is rotated via CSS based on the `.collapsed` class on the
  // panel, so we don't need to mutate its inner text here.
}

/**
 * Wires the toggle button so the user can manually expand/collapse the panel.
 */
export function bindCollapsible() {
  const toggle = document.getElementById(TOGGLE_ID);
  if (!toggle) return;

  toggle.onclick = () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (panel.classList.contains("collapsed")) {
      expandLoadPanel();
    } else {
      collapseLoadPanel();
    }
  };
}
