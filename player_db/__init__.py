"""
Optional Player DB feature: personal player profiles, batch game ingestion and
a stats dashboard. Registered on the Flask app only when PLAYER_DB_ENABLED.

Public entry point: `register_player_db(app)`.
"""

from flask import Flask

from . import db, stats
from .routes import bp


def register_player_db(app: Flask) -> None:
    """Initialises the SQLite schema and mounts the Player DB blueprint."""
    with app.app_context():
        db.init_db()
        # One-time: recompute stored Elo/accuracy for games imported before
        # per-move cp_loss was capped (guarded by PRAGMA user_version).
        stats.backfill_capped_aggregates()
    app.register_blueprint(bp)
