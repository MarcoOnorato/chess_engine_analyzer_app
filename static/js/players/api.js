/**
 * @fileoverview Thin JSON fetch helpers for the Player DB API.
 */

async function request(method, url, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  listProfiles: () => request("GET", "/api/players"),
  createProfile: (payload) => request("POST", "/api/players", payload),
  deleteProfile: (id) => request("DELETE", `/api/players/${id}`),
  previewIngest: (id, payload) => request("POST", `/api/players/${id}/ingest/preview`, payload),
  startIngest: (id, payload) => request("POST", `/api/players/${id}/ingest`, payload),
  jobStatus: (jobId) => request("GET", `/api/players/jobs/${jobId}`),
  stats: (id) => request("GET", `/api/players/${id}/stats`),
  games: (id) => request("GET", `/api/players/${id}/games`),
};
