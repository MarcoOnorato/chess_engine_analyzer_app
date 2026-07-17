"""
Optional Player DB feature: personal player profiles, batch game ingestion and
a stats dashboard. Registered on the Flask app only when PLAYER_DB_ENABLED.

Public entry point: `register_player_db(app)`.
"""

from flask import Flask

from . import db
from .routes import bp


def register_player_db(app: Flask) -> None:
    """Initialises the SQLite schema and mounts the Player DB blueprint."""
    with app.app_context():
        db.init_db()
    app.register_blueprint(bp)
