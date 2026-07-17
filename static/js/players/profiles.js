/**
 * @fileoverview Profiles view: list + create + per-card game import.
 *
 * Import flow mirrors the plan: preview (dedup by PGN) → if depth conflicts,
 * ask the user before recomputing → start a background job → poll progress.
 * Communicates with the router in main.js via DOM CustomEvents:
 *   - "pdb:open"    detail {id}  → open that profile's dashboard
 *   - "pdb:refresh"               → a job finished; refresh open dashboard
 */

import { api } from "./api.js";
import { toast, askConflict } from "./ui.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Fetches and renders the profile cards. */
export async function loadProfiles() {
  const list = document.getElementById("profilesList");
  const empty = document.getElementById("profilesEmpty");
  let profiles = [];
  try {
    profiles = await api.listProfiles();
  } catch (e) {
    toast(e.message, true);
    return;
  }

  empty.classList.toggle("hidden", profiles.length > 0);
  list.innerHTML = profiles.map(cardHtml).join("");
  profiles.forEach((p) => wireCard(p));
}

function cardHtml(p) {
  const meta = [p.platform, p.username].filter(Boolean).join(" · ");
  return `
    <div class="pdb-profile" data-id="${p.id}">
      <div class="pdb-profile-top">
        <div>
          <div class="pdb-profile-name">${esc(p.label)}</div>
          <div class="pdb-profile-meta">${esc(meta) || "—"}</div>
        </div>
        <button class="pdb-btn pdb-btn-danger pdb-btn-sm" data-act="delete" title="Delete profile">✕</button>
      </div>
      <div class="pdb-profile-stats">
        <span><b>${p.games_count || 0}</b> games</span>
      </div>
      <div class="pdb-profile-actions">
        <button class="pdb-btn pdb-btn-primary pdb-btn-sm" data-act="open">Open dashboard</button>
      </div>
      <div class="pdb-import-form">
        <label>Games<input class="imp-count" type="number" value="10" min="1"></label>
        <label>Depth<input class="imp-depth" type="number" value="10" min="6" max="30"></label>
        <button class="pdb-btn pdb-btn-ghost pdb-btn-sm" data-act="import">Import games</button>
      </div>
      <div class="pdb-progress-area hidden">
        <div class="pdb-progress"><div class="pdb-progress-fill"></div></div>
        <div class="pdb-progress-row">
          <span class="pdb-progress-label"></span>
          <button class="pdb-btn pdb-btn-danger pdb-btn-sm pdb-cancel-btn hidden" data-act="cancel">Cancel</button>
        </div>
      </div>
    </div>`;
}

function wireCard(profile) {
  const card = document.querySelector(`.pdb-profile[data-id="${profile.id}"]`);
  if (!card) return;

  card.querySelector('[data-act="open"]').onclick = () =>
    document.dispatchEvent(new CustomEvent("pdb:open", { detail: { id: profile.id } }));

  card.querySelector('[data-act="delete"]').onclick = async () => {
    if (!confirm(`Delete profile "${profile.label}" and all its games?`)) return;
    try {
      await api.deleteProfile(profile.id);
      toast("Profile deleted");
      loadProfiles();
    } catch (e) {
      toast(e.message, true);
    }
  };

  card.querySelector('[data-act="import"]').onclick = () => runImport(profile, card);
}

async function runImport(profile, card) {
  if (!profile.platform || !profile.username) {
    toast("This profile has no platform/username to import from.", true);
    return;
  }
  const count = parseInt(card.querySelector(".imp-count").value, 10) || 20;
  const depth = parseInt(card.querySelector(".imp-depth").value, 10) || 14;
  const importBtn = card.querySelector('[data-act="import"]');
  const payload = { platform: profile.platform, username: profile.username, count, depth };

  importBtn.disabled = true;
  try {
    const preview = await api.previewIngest(profile.id, payload);
    let recompute = false;

    if (preview.depth_conflicts && preview.depth_conflicts.length) {
      const choice = await askConflict(preview.depth_conflicts.length, depth, preview.to_add);
      if (!choice.proceed) { importBtn.disabled = false; return; }
      recompute = choice.recompute;
    } else if (preview.to_add === 0) {
      toast(`Nothing new — ${preview.duplicates_same_depth} game(s) already stored at depth ${depth}.`);
      importBtn.disabled = false;
      return;
    }

    const { job_id } = await api.startIngest(profile.id, { ...payload, recompute_conflicts: recompute });
    pollJob(profile, card, job_id, importBtn);
  } catch (e) {
    toast(e.message, true);
    importBtn.disabled = false;
  }
}

function pollJob(profile, card, jobId, importBtn) {
  const area = card.querySelector(".pdb-progress-area");
  const fill = card.querySelector(".pdb-progress-fill");
  const label = card.querySelector(".pdb-progress-label");
  const cancelBtn = card.querySelector(".pdb-cancel-btn");
  area.classList.remove("hidden");
  cancelBtn.classList.remove("hidden");
  cancelBtn.disabled = false;
  label.textContent = "Queued…";

  cancelBtn.onclick = async () => {
    cancelBtn.disabled = true;
    label.textContent = "Cancelling…";
    try {
      await api.cancelJob(jobId);
    } catch (e) {
      toast(e.message, true);
      cancelBtn.disabled = false;
    }
  };

  const finish = () => {
    clearInterval(timer);
    importBtn.disabled = false;
    cancelBtn.classList.add("hidden");
    cancelBtn.onclick = null;
  };

  const timer = setInterval(async () => {
    let job;
    try {
      job = await api.jobStatus(jobId);
    } catch (e) {
      finish();
      toast(e.message, true);
      return;
    }

    const total = job.total || 0;
    const done = job.done || 0;
    const pct = total ? Math.round((done / total) * 100) : (job.status === "running" ? 5 : 0);
    fill.style.width = `${pct}%`;

    if (job.status === "cancelling") {
      label.textContent = total ? `Cancelling… (${done}/${total})` : "Cancelling…";
      return;
    }
    if (job.status === "running" || job.status === "queued") {
      label.textContent = total ? `Analyzing ${done}/${total} games…` : "Fetching games…";
      return;
    }

    finish();
    if (job.status === "done") {
      fill.style.width = "100%";
      label.textContent = `Done — ${done} game(s) analyzed.`;
      toast(`Import complete for ${profile.label}.`);
      loadProfiles();
      document.dispatchEvent(new CustomEvent("pdb:refresh", { detail: { id: profile.id } }));
    } else if (job.status === "cancelled") {
      label.textContent = `Cancelled — ${done} game(s) analyzed.`;
      toast(`Import cancelled for ${profile.label}.`);
      loadProfiles();
      document.dispatchEvent(new CustomEvent("pdb:refresh", { detail: { id: profile.id } }));
    } else if (job.status === "error") {
      label.textContent = `Error: ${job.error || "unknown"}`;
      toast(`Import failed: ${job.error || "unknown"}`, true);
    } else {
      label.textContent = `Job ${job.status}.`;
    }
  }, 900);
}

/** Wires the "New profile" form. */
export function bindNewProfileForm() {
  const btn = document.getElementById("npCreateBtn");
  const errEl = document.getElementById("npError");

  btn.onclick = async () => {
    errEl.textContent = "";
    const label = document.getElementById("npLabel").value.trim();
    const platform = document.getElementById("npPlatform").value;
    const username = document.getElementById("npUsername").value.trim();

    if (!label) { errEl.textContent = "Label is required."; return; }

    btn.disabled = true;
    try {
      await api.createProfile({ label, platform, username });
      document.getElementById("npLabel").value = "";
      document.getElementById("npUsername").value = "";
      toast("Profile created — import games from its card.");
      loadProfiles();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };
}
