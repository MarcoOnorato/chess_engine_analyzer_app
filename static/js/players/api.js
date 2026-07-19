/**
 * @fileoverview Named bindings for the Player DB endpoints.
 *
 * The transport (headers, error unwrapping, JSON handling) lives in the shared
 * `../api.js`; this module only names the routes, so a URL change has one home.
 */

import { api as http } from "../api.js";

export const api = {
  listProfiles: () => http.get("/api/players"),
  createProfile: (payload) => http.post("/api/players", payload),
  deleteProfile: (id) => http.del(`/api/players/${id}`),
  previewIngest: (id, payload) => http.post(`/api/players/${id}/ingest/preview`, payload),
  startIngest: (id, payload) => http.post(`/api/players/${id}/ingest`, payload),
  jobStatus: (jobId) => http.get(`/api/players/jobs/${jobId}`),
  cancelJob: (jobId) => http.post(`/api/players/jobs/${jobId}/cancel`),
  stats: (id, timeClass) =>
    http.get(
      `/api/players/${id}/stats${timeClass ? `?time_class=${encodeURIComponent(timeClass)}` : ""}`
    ),
  games: (id) => http.get(`/api/players/${id}/games`),
  brilliants: (id, timeClass) =>
    http.get(
      `/api/players/${id}/brilliants${timeClass ? `?time_class=${encodeURIComponent(timeClass)}` : ""}`
    ),
};
