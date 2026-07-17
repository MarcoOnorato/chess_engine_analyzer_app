/**
 * @fileoverview Small shared UI utilities: toast, view switching, and the
 * depth-conflict confirmation modal (returned as a Promise).
 */

let _toastTimer = null;

export function toast(message, isError = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.classList.remove("hidden");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

export function showProfilesView() {
  document.getElementById("dashboardView").classList.add("hidden");
  document.getElementById("profilesView").classList.remove("hidden");
}

export function showDashboardView() {
  document.getElementById("profilesView").classList.add("hidden");
  document.getElementById("dashboardView").classList.remove("hidden");
}

/**
 * Shows the depth-conflict modal.
 * @param {number} conflicts - how many stored games conflict on depth.
 * @param {number} newDepth
 * @param {number} toAdd - how many brand-new games would be added.
 * @returns {Promise<{proceed: boolean, recompute: boolean}>}
 */
export function askConflict(conflicts, newDepth, toAdd) {
  return new Promise((resolve) => {
    const modal = document.getElementById("conflictModal");
    const text = document.getElementById("conflictText");
    const confirmBtn = document.getElementById("conflictConfirm");
    const cancelBtn = document.getElementById("conflictCancel");

    text.innerHTML =
      `<b>${conflicts}</b> already-stored game(s) were analyzed at a different depth. ` +
      `Recomputing them at depth <b>${newDepth}</b> overwrites their stored analysis. ` +
      `<br><br>${toAdd} new game(s) will be added either way.`;

    modal.classList.remove("hidden");

    const cleanup = () => {
      modal.classList.add("hidden");
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
    };

    confirmBtn.onclick = () => { cleanup(); resolve({ proceed: true, recompute: true }); };
    cancelBtn.onclick = () => { cleanup(); resolve({ proceed: true, recompute: false }); };
    modal.onclick = (e) => {
      if (e.target === modal) { cleanup(); resolve({ proceed: false, recompute: false }); }
    };
  });
}
