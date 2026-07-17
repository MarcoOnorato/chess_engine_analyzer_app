"""
Flask Blueprint for the optional Player DB feature: the /players page plus the
JSON API backing the profile list, ingestion jobs and the stats dashboard.
"""

from typing import Any, Dict, Tuple

from flask import Blueprint, Response, jsonify, render_template, request

from . import db, ingest, sources, stats

bp = Blueprint("player_db", __name__)

_VALID_PLATFORMS = ("lichess", "chesscom")
_MIN_DEPTH, _MAX_DEPTH = 6, 22
_MAX_COUNT = 200


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


# --- PAGE ------------------------------------------------------------------

@bp.route("/players")
def players_page() -> str:
    return render_template("players.html")


# --- PROFILES --------------------------------------------------------------

@bp.route("/api/players", methods=["GET"])
def list_players() -> Response:
    return jsonify(db.list_profiles())


@bp.route("/api/players", methods=["POST"])
def create_player() -> Response:
    data: Dict[str, Any] = request.get_json(force=True) or {}
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
def delete_player(profile_id: int) -> Response:
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    db.delete_profile(profile_id)
    return jsonify({"ok": True})


# --- INGESTION -------------------------------------------------------------

def _parse_ingest_params(data: Dict[str, Any]) -> Tuple[str, str, int, int]:
    platform = (data.get("platform") or "").strip().lower()
    username = (data.get("username") or "").strip()
    count = _clamp(int(data.get("count") or 10), 1, _MAX_COUNT)
    depth = _clamp(int(data.get("depth") or 14), _MIN_DEPTH, _MAX_DEPTH)
    return platform, username, count, depth


@bp.route("/api/players/<int:profile_id>/ingest/preview", methods=["POST"])
def preview_ingest(profile_id: int) -> Response:
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
def start_ingest(profile_id: int) -> Response:
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    data = request.get_json(force=True) or {}
    platform, username, count, depth = _parse_ingest_params(data)
    if platform not in _VALID_PLATFORMS or not username:
        return jsonify({"error": "platform and username are required"}), 400
    recompute = bool(data.get("recompute_conflicts", False))
    job_id = ingest.start_ingest(profile_id, platform, username, count, depth, recompute)
    return jsonify({"job_id": job_id}), 202


@bp.route("/api/players/jobs/<int:job_id>", methods=["GET"])
def job_status(job_id: int) -> Response:
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


# --- DASHBOARD -------------------------------------------------------------

@bp.route("/api/players/<int:profile_id>/stats", methods=["GET"])
def player_stats(profile_id: int) -> Response:
    profile = db.get_profile(profile_id)
    if profile is None:
        return jsonify({"error": "Profile not found"}), 404
    time_class = request.args.get("time_class") or None
    dashboard = stats.build_dashboard(profile_id, time_class)
    dashboard["profile"] = profile
    return jsonify(dashboard)


@bp.route("/api/players/<int:profile_id>/games", methods=["GET"])
def player_games(profile_id: int) -> Response:
    if db.get_profile(profile_id) is None:
        return jsonify({"error": "Profile not found"}), 404
    return jsonify(db.games_for_profile(profile_id))


@bp.route("/api/players/game/<int:game_id>/pgn", methods=["GET"])
def game_pgn(game_id: int) -> Response:
    game = db.get_game(game_id)
    if game is None:
        return jsonify({"error": "Game not found"}), 404
    return jsonify({"pgn": game["pgn"], "white": game.get("white"), "black": game.get("black")})
