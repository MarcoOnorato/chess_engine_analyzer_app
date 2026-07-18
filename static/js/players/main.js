/**
 * @fileoverview Player DB page entry point / router.
 *
 * Two views live in one page (#profilesView, #dashboardView); the URL
 * `?profile=<id>` selects the dashboard so it is deep-linkable and works with
 * browser back/forward.
 */

import { api } from "./api.js";
import { loadProfiles, bindNewProfileForm } from "./profiles.js";
import { renderDashboard, refreshDashboard } from "./dashboard.js";
import { toast, showProfilesView, showDashboardView } from "./ui.js";

let currentProfileId = null;

/**
 * Mirrors an ingest job into the dashboard header: the progress bar lives on
 * the (hidden) profile card, so without this the dashboard would give no sign
 * that games are still coming in.
 */
function renderJobBanner(d) {
  const banner = document.getElementById("dashJobBanner");
  const label = document.getElementById("dashJobLabel");
  const cancel = document.getElementById("dashJobCancel");
  if (!banner) return;

  const mine = d.active && d.profileId === currentProfileId;
  banner.classList.toggle("hidden", !mine);
  if (!mine) return;

  if (d.status === "cancelling") {
    label.textContent = d.total ? `Cancelling… (${d.done}/${d.total})` : "Cancelling…";
  } else if (d.total) {
    label.textContent = `Importing — ${d.done}/${d.total} games analyzed so far…`;
  } else {
    label.textContent = "Fetching games…";
  }

  const stopping = d.status === "cancelling";
  cancel.disabled = stopping;
  cancel.onclick = stopping ? null : async () => {
    cancel.disabled = true;
    try {
      await api.cancelJob(d.jobId);
    } catch (e) {
      toast(e.message, true);
      cancel.disabled = false;
    }
  };
}

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
    if (currentProfileId === e.detail.id) refreshDashboard().catch(() => {});
  });

  document.addEventListener("pdb:job", (e) => {
    const d = e.detail;
    renderJobBanner(d);
    // Repaint only when a new game actually landed, so the dashboard follows
    // the ingestion instead of re-querying on every poll tick.
    if (d.active && d.progressed && d.profileId === currentProfileId) {
      refreshDashboard().catch(() => {});
    }
  });

  window.addEventListener("popstate", syncFromUrl);

  syncFromUrl();
});
