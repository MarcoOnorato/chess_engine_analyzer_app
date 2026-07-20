"""
Flask Blueprint for the optional Player DB feature: the /players page plus the
JSON API backing the profile list, ingestion jobs and the stats dashboard.
"""

import csv
import io
import re
from typing import Any

from flask import Blueprint, Response, jsonify, render_template, request
from flask.typing import ResponseReturnValue

from . import db, ingest, sources, stats

bp = Blueprint("player_db", __name__)

_VALID_PLATFORMS = ("lichess", "chesscom")
# Same range as the Review page's depth input (templates/index.html), so every
# ingested game can be reopened at its own depth there.
_MIN_DEPTH, _MAX_DEPTH = 8, 30
_MAX_COUNT = 200
_ACTIVE_JOB_STATES = ("queued", "running", "cancelling")


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


# --- PAGE ------------------------------------------------------------------

@bp.route("/players")
def players_page() -> str:
    return render_template("players.html")


# --- PROFILES --------------------------------------------------------------

@bp.route("/api/players", methods=["GET"])
def list_players() -> ResponseReturnValue:
    return jsonify(db.list_profiles())


@bp.route("/api/players", methods=["POST"])
def create_player() -> ResponseReturnValue:
    data: dict[str, Any] = request.get_json(force=True) or {}
    label = (data.get("label") or "").strip()
    if not label:
        return jsonify({"error": "Label is required"}), 400
    profile_id = db.create_profile(
        label=label,
        platform=(data.get("platform") or "").strip(),
        username=(data.get("username") or "").strip(),
        notes=(data.get("notes") or "").strip(),
    )
    return jsonify(db.get_profile(profile_id)), 201


@bp.route("/api/players/<int:profile_id>", methods=["DELETE"])
def delete_player(profile_id: int) -> ResponseReturnValue:
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    db.delete_profile(profile_id)
    return jsonify({"ok": True})


# --- INGESTION -------------------------------------------------------------

def _parse_ingest_params(data: dict[str, Any]) -> tuple[str, str, int, int]:
    platform = (data.get("platform") or "").strip().lower()
    username = (data.get("username") or "").strip()
    count = _clamp(int(data.get("count") or 10), 1, _MAX_COUNT)
    depth = _clamp(int(data.get("depth") or 14), _MIN_DEPTH, _MAX_DEPTH)
    return platform, username, count, depth


@bp.route("/api/players/<int:profile_id>/ingest/preview", methods=["POST"])
def preview_ingest(profile_id: int) -> ResponseReturnValue:
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    data = request.get_json(force=True) or {}
    platform, username, count, depth = _parse_ingest_params(data)
    if platform not in _VALID_PLATFORMS or not username:
        return jsonify({"error": "platform and username are required"}), 400
    try:
        result = ingest.preview(profile_id, platform, username, count, depth)
    except sources.SourceError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify(result)


@bp.route("/api/players/<int:profile_id>/ingest", methods=["POST"])
def start_ingest(profile_id: int) -> ResponseReturnValue:
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    data = request.get_json(force=True) or {}
    platform, username, count, depth = _parse_ingest_params(data)
    if platform not in _VALID_PLATFORMS or not username:
        return jsonify({"error": "platform and username are required"}), 400
    recompute = bool(data.get("recompute_conflicts", False))
    job_id = ingest.start_ingest(profile_id, platform, username, count, depth, recompute)
    return jsonify({"job_id": job_id}), 202


@bp.route("/api/players/<int:profile_id>/sync", methods=["POST"])
def sync_ingest(profile_id: int) -> ResponseReturnValue:
    """One-click incremental sync: fetch the latest games and add only the new
    ones, reusing the profile's own platform/username and dominant analysis
    depth so nothing already stored is recomputed. Answers `{nothing_new: true}`
    when the archive holds nothing beyond what is already stored.
    """
    profile = db.get_profile(profile_id)
    if profile is None:
        return jsonify({"error": "Profile not found"}), 404

    platform = (profile.get("platform") or "").strip().lower()
    username = (profile.get("username") or "").strip()
    if platform not in _VALID_PLATFORMS or not username:
        return jsonify({"error": "This profile has no platform/username to sync from."}), 400

    data = request.get_json(silent=True) or {}
    count = _clamp(int(data.get("count") or 30), 1, _MAX_COUNT)
    depth = _clamp(db.dominant_analysis_depth(profile_id) or 14, _MIN_DEPTH, _MAX_DEPTH)

    try:
        plan = ingest.preview(profile_id, platform, username, count, depth)
    except sources.SourceError as e:
        return jsonify({"error": str(e)}), 502

    if plan["to_add"] == 0:
        return jsonify({
            "nothing_new": True,
            "duplicates_same_depth": plan["duplicates_same_depth"],
            "depth": depth,
        })

    # recompute_conflicts=False: sync never touches games already stored.
    job_id = ingest.start_ingest(profile_id, platform, username, count, depth, False)
    return jsonify({"job_id": job_id, "depth": depth, "to_add": plan["to_add"]}), 202


@bp.route("/api/players/jobs/<int:job_id>", methods=["GET"])
def job_status(job_id: int) -> ResponseReturnValue:
    job = db.get_job(job_id)
    if job is None:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({
        "id": job["id"],
        "profile_id": job["profile_id"],
        "status": job["status"],
        "done": job["done"],
        "total": job["total"],
        "error": job.get("error"),
    })


@bp.route("/api/players/jobs/<int:job_id>/cancel", methods=["POST"])
def cancel_job(job_id: int) -> ResponseReturnValue:
    """Requests cancellation of a running/queued ingest job. Games analyzed so
    far are kept; the worker stops before the next game."""
    job = db.get_job(job_id)
    if job is None:
        return jsonify({"error": "Job not found"}), 404
    if job["status"] not in _ACTIVE_JOB_STATES:
        return jsonify({"status": job["status"], "already_finished": True})
    ingest.request_cancel(job_id)
    db.set_job_status(job_id, "cancelling")
    return jsonify({"status": "cancelling"})


# --- DASHBOARD -------------------------------------------------------------

@bp.route("/api/players/<int:profile_id>/stats", methods=["GET"])
def player_stats(profile_id: int) -> ResponseReturnValue:
    profile = db.get_profile(profile_id)
    if profile is None:
        return jsonify({"error": "Profile not found"}), 404
    time_class = request.args.get("time_class") or None
    dashboard = stats.build_dashboard(profile_id, time_class)
    dashboard["profile"] = profile
    return jsonify(dashboard)


@bp.route("/api/players/<int:profile_id>/brilliants", methods=["GET"])
def player_brilliants(profile_id: int) -> ResponseReturnValue:
    """The tracked player's Brilliant moves, for the brilliancy explorer."""
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    time_class = request.args.get("time_class") or None
    return jsonify(db.brilliant_moves(profile_id, time_class))


@bp.route("/api/players/<int:profile_id>/errors", methods=["GET"])
def player_errors(profile_id: int) -> ResponseReturnValue:
    """The tracked player's worst moves (Blunder/Miss/Mistake) for the explorer."""
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    time_class = request.args.get("time_class") or None
    return jsonify(db.error_moves(profile_id, time_class))


_CSV_COLUMNS = [
    "played_at", "time_class", "player_color", "opponent", "player_result",
    "result", "opening", "accuracy", "acpl", "est_elo", "moves_count",
    "analysis_depth", "brilliant", "best", "excellent", "good",
    "inaccuracy", "mistake", "miss", "blunder", "url",
]


def _safe_filename(label: str) -> str:
    """A filesystem-friendly slug for the Content-Disposition filename."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", label).strip("_")
    return slug or "player"


@bp.route("/api/players/<int:profile_id>/games.csv", methods=["GET"])
def player_games_csv(profile_id: int) -> ResponseReturnValue:
    """Every game of the profile (optionally one time control) as a CSV download,
    one row per game with the same figures the dashboard table shows."""
    profile = db.get_profile(profile_id)
    if profile is None:
        return jsonify({"error": "Profile not found"}), 404
    time_class = request.args.get("time_class") or None
    games = db.games_for_profile(profile_id, time_class)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_CSV_COLUMNS)
    for g in games:
        opp = g.get("black") if g.get("player_color") == "white" else g.get("white")
        writer.writerow([opp if col == "opponent" else g.get(col, "") for col in _CSV_COLUMNS])

    label = _safe_filename(profile.get("label") or "player")
    suffix = f"_{time_class}" if time_class else ""
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{label}{suffix}_games.csv"'},
    )


@bp.route("/api/players/<int:profile_id>/games", methods=["GET"])
def player_games(profile_id: int) -> ResponseReturnValue:
    """A page of the profile's games (newest first).

    `?time_class=` scopes to one time control; `?limit=&offset=` page the list.
    Without `limit` the whole archive is returned (small profiles, exports).
    Always answers `{games, total, limit, offset}` so the client can paginate.
    """
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    time_class = request.args.get("time_class") or None
    limit_arg = request.args.get("limit")
    limit = _clamp(int(limit_arg), 1, 500) if limit_arg else None
    offset = max(0, int(request.args.get("offset") or 0))
    games = db.games_for_profile(profile_id, time_class, limit, offset)
    total = db.count_games(profile_id, time_class)
    return jsonify({"games": games, "total": total, "limit": limit, "offset": offset})


@bp.route("/api/players/game/<int:game_id>/pgn", methods=["GET"])
def game_pgn(game_id: int) -> ResponseReturnValue:
    """The game's PGN plus the analysis stored at ingest time, so the Review
    page can replay it at the ingestion depth without re-running the engine."""
    game = db.get_game(game_id)
    if game is None:
        return jsonify({"error": "Game not found"}), 404
    return jsonify({
        "pgn": game["pgn"],
        "white": game.get("white"),
        "black": game.get("black"),
        "opening": game.get("opening"),
        "player_color": game.get("player_color"),
        "analysis_depth": game.get("analysis_depth"),
        "moves": db.moves_for_game(game_id),
    })
