/**
 * @fileoverview Player DB page entry point / router.
 *
 * Two views live in one page (#profilesView, #dashboardView); the URL
 * `?profile=<id>` selects the dashboard so it is deep-linkable and works with
 * browser back/forward.
 */

import { loadProfiles, bindNewProfileForm } from "./profiles.js";
import { renderDashboard } from "./dashboard.js";
import { toast, showProfilesView, showDashboardView } from "./ui.js";

let currentProfileId = null;

async function openDashboard(id, push = true) {
  currentProfileId = id;
  showDashboardView();
  if (push) {
    const url = `?profile=${id}`;
    window.history.pushState({ profile: id }, "", url);
  }
  try {
    await renderDashboard(id);
  } catch (e) {
    toast(e.message, true);
    backToProfiles();
  }
}

function backToProfiles(push = true) {
  currentProfileId = null;
  showProfilesView();
  if (push) window.history.pushState({}, "", window.location.pathname);
  loadProfiles();
}

function syncFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("profile");
  if (id) {
    openDashboard(parseInt(id, 10), false);
  } else {
    showProfilesView();
  }
}

window.addEventListener("load", () => {
  bindNewProfileForm();
  loadProfiles();

  document.getElementById("backToProfiles").onclick = () => backToProfiles();

  document.addEventListener("pdb:open", (e) => openDashboard(e.detail.id));
  document.addEventListener("pdb:refresh", (e) => {
    if (currentProfileId === e.detail.id) renderDashboard(currentProfileId).catch(() => {});
  });

  window.addEventListener("popstate", syncFromUrl);

  syncFromUrl();
});
