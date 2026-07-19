"""
SQLite persistence for the optional Player DB feature.

Uses the `sqlite3` stdlib (no extra dependency). WAL mode + a per-thread
connection let the Flask request threads and the background ingestion worker
share the same file safely. Everything here is pure storage; the analysis math
lives in `stats.py` and the engine work in `analysis_core`.
"""

import json
import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _default_db_path() -> str:
    return os.getenv("PLAYER_DB_PATH", os.path.join("data", "player_db.sqlite"))


DB_PATH: str = _default_db_path()

_local = threading.local()

# Move-quality labels persisted per game (columns on `games`). Mirrors the
# categories produced by analysis_core.classify_move / analyze_move.
LABELS = [
    "Brilliant", "Best", "Excellent", "Good",
    "Inaccuracy", "Mistake", "Miss", "Blunder",
]
_LABEL_COL = {
    "Brilliant": "brilliant", "Best": "best", "Excellent": "excellent",
    "Good": "good", "Inaccuracy": "inaccuracy", "Mistake": "mistake",
    "Miss": "miss", "Blunder": "blunder",
}


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def get_conn() -> sqlite3.Connection:
    """Returns the current thread's connection, creating it if necessary."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        _local.conn = conn
    return conn


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def _inserted_id(cur: sqlite3.Cursor) -> int:
    """Row id of the INSERT just executed on `cur`.

    sqlite3 leaves `lastrowid` as None when the statement inserted nothing;
    every caller here treats the id as a hard requirement, so surface it
    instead of silently returning a bogus row id.
    """
    if cur.lastrowid is None:
        raise RuntimeError("INSERT did not produce a row id")
    return int(cur.lastrowid)


def _rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


# --- SCHEMA ----------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    platform   TEXT,
    username   TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    source          TEXT,
    external_id     TEXT,
    url             TEXT,
    pgn             TEXT NOT NULL,
    pgn_fingerprint TEXT NOT NULL,
    white           TEXT,
    black           TEXT,
    result          TEXT,
    played_at       TEXT,
    time_class      TEXT,
    eco             TEXT,
    opening         TEXT,
    player_color    TEXT,
    player_result   TEXT,
    analysis_depth  INTEGER,
    analyzed_at     TEXT,
    accuracy        REAL,
    acpl            REAL,
    est_elo         INTEGER,
    moves_count     INTEGER,
    brilliant       INTEGER DEFAULT 0,
    best            INTEGER DEFAULT 0,
    excellent       INTEGER DEFAULT 0,
    good            INTEGER DEFAULT 0,
    inaccuracy      INTEGER DEFAULT 0,
    mistake         INTEGER DEFAULT 0,
    miss            INTEGER DEFAULT 0,
    blunder         INTEGER DEFAULT 0,
    UNIQUE(profile_id, pgn_fingerprint)
);

CREATE TABLE IF NOT EXISTS moves (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply         INTEGER,
    side        TEXT,
    san         TEXT,
    uci         TEXT,
    fen_before  TEXT,
    fen_after   TEXT,
    cp_loss     REAL,
    eval        REAL,
    eval_mate   INTEGER,
    -- Engine's preferred move in the position *after* this move. Training reads
    -- it from the previous ply to tell a missed capture from a missed tactic.
    best_uci    TEXT,
    best_san    TEXT,
    best_score  REAL,
    best_mate   INTEGER,
    label       TEXT,
    phase       TEXT
);

CREATE TABLE IF NOT EXISTS ingest_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    total       INTEGER DEFAULT 0,
    done        INTEGER DEFAULT 0,
    error       TEXT,
    params      TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_profile ON games(profile_id);
CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id);
CREATE INDEX IF NOT EXISTS idx_jobs_profile ON ingest_jobs(profile_id);
"""


def init_db() -> None:
    """Creates the schema (idempotent) and marks stale running jobs interrupted."""
    conn = get_conn()
    conn.executescript(_SCHEMA)

    # Columns added after the first release. Existing rows keep NULL: those
    # games show a numeric eval for mates, and Train-as-a-player can only sort
    # their errors into the two categories that need no engine best move, until
    # they are re-ingested.
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(moves)")}
    for name, decl in (
        ("eval_mate", "INTEGER"),
        ("best_uci", "TEXT"),
        ("best_san", "TEXT"),
        ("best_score", "REAL"),
        ("best_mate", "INTEGER"),
    ):
        if name not in columns:
            conn.execute(f"ALTER TABLE moves ADD COLUMN {name} {decl}")

    # A worker that was killed mid-run leaves 'running'/'queued' jobs behind.
    conn.execute(
        "UPDATE ingest_jobs SET status='interrupted', updated_at=? "
        "WHERE status IN ('running', 'queued')",
        (now_iso(),),
    )
    conn.commit()


# --- PROFILES --------------------------------------------------------------

def create_profile(label: str, platform: str = "", username: str = "", notes: str = "") -> int:
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO profiles (label, platform, username, notes, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (label, platform, username, notes, now_iso()),
    )
    conn.commit()
    return _inserted_id(cur)


def list_profiles() -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT p.*,
               (SELECT COUNT(*) FROM games g WHERE g.profile_id = p.id) AS games_count,
               (SELECT MAX(analyzed_at) FROM games g WHERE g.profile_id = p.id) AS last_analyzed
        FROM profiles p
        ORDER BY p.created_at DESC
        """
    ).fetchall()
    return _rows_to_dicts(rows)


def get_profile(profile_id: int) -> dict[str, Any] | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _row_to_dict(row)


def delete_profile(profile_id: int) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    conn.commit()


# --- GAMES -----------------------------------------------------------------

def get_game_by_fingerprint(profile_id: int, fingerprint: str) -> dict[str, Any] | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM games WHERE profile_id = ? AND pgn_fingerprint = ?",
        (profile_id, fingerprint),
    ).fetchone()
    return _row_to_dict(row)


def get_game(game_id: int) -> dict[str, Any] | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    return _row_to_dict(row)


def upsert_game(profile_id: int, meta: dict[str, Any], aggregates: dict[str, Any]) -> int:
    """
    Inserts or replaces a game row (dedup key: profile_id + pgn_fingerprint) and
    returns its id. `meta` carries the source/PGN metadata; `aggregates` carries
    the per-game analysis summary (accuracy, acpl, est_elo, label counts, ...).
    Any existing moves for the game are removed by the caller before re-insert.
    """
    conn = get_conn()
    label_counts = aggregates.get("label_counts", {})
    label_cols = {col: int(label_counts.get(label, 0)) for label, col in _LABEL_COL.items()}

    existing = get_game_by_fingerprint(profile_id, meta["pgn_fingerprint"])
    fields = {
        "profile_id": profile_id,
        "source": meta.get("source"),
        "external_id": meta.get("external_id"),
        "url": meta.get("url"),
        "pgn": meta["pgn"],
        "pgn_fingerprint": meta["pgn_fingerprint"],
        "white": meta.get("white"),
        "black": meta.get("black"),
        "result": meta.get("result"),
        "played_at": meta.get("played_at"),
        "time_class": meta.get("time_class"),
        "eco": meta.get("eco"),
        "opening": aggregates.get("opening"),
        "player_color": meta.get("player_color"),
        "player_result": meta.get("player_result"),
        "analysis_depth": aggregates.get("analysis_depth"),
        "analyzed_at": now_iso(),
        "accuracy": aggregates.get("accuracy"),
        "acpl": aggregates.get("acpl"),
        "est_elo": aggregates.get("est_elo"),
        "moves_count": aggregates.get("moves_count"),
        **label_cols,
    }

    if existing:
        game_id = int(existing["id"])
        set_clause = ", ".join(f"{k} = :{k}" for k in fields if k != "profile_id")
        fields["_id"] = game_id
        conn.execute(f"UPDATE games SET {set_clause} WHERE id = :_id", fields)
    else:
        cols = ", ".join(fields.keys())
        placeholders = ", ".join(f":{k}" for k in fields)
        cur = conn.execute(f"INSERT INTO games ({cols}) VALUES ({placeholders})", fields)
        game_id = _inserted_id(cur)

    conn.commit()
    return game_id


def moves_for_game(game_id: int) -> list[dict[str, Any]]:
    """Stored per-ply analysis of one game, in play order."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT ply, side, san, uci, fen_before, fen_after, cp_loss, eval, eval_mate, "
        "best_uci, best_san, best_score, best_mate, label, phase "
        "FROM moves WHERE game_id = ? ORDER BY ply",
        (game_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def replace_moves(game_id: int, moves: list[dict[str, Any]]) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM moves WHERE game_id = ?", (game_id,))
    conn.executemany(
        """
        INSERT INTO moves (game_id, ply, side, san, uci, fen_before, fen_after,
                           cp_loss, eval, eval_mate, best_uci, best_san,
                           best_score, best_mate, label, phase)
        VALUES (:game_id, :ply, :side, :san, :uci, :fen_before, :fen_after,
                :cp_loss, :eval, :eval_mate, :best_uci, :best_san,
                :best_score, :best_mate, :label, :phase)
        """,
        [{"game_id": game_id, **m} for m in moves],
    )
    conn.commit()


def games_for_profile(profile_id: int) -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT id, source, url, white, black, result, played_at, time_class,
               opening, player_color, player_result, analysis_depth, accuracy,
               acpl, est_elo, moves_count, brilliant, best, excellent, good,
               inaccuracy, mistake, miss, blunder, analyzed_at
        FROM games WHERE profile_id = ?
        ORDER BY COALESCE(played_at, analyzed_at) DESC
        """,
        (profile_id,),
    ).fetchall()
    return _rows_to_dicts(rows)


def brilliant_moves(profile_id: int, time_class: str | None = None) -> list[dict[str, Any]]:
    """The tracked player's Brilliant-labelled moves across their games, newest
    game first (then in play order within a game).

    Each row carries enough game context to open the game in Review at the exact
    ply. Only the tracked side's moves count, mirroring the `brilliant` KPI.
    Optionally restricted to a single time control.
    """
    conn = get_conn()
    params: list[Any] = [profile_id]
    tc_clause = ""
    if time_class:
        tc_clause = "AND g.time_class = ?"
        params.append(time_class)
    rows = conn.execute(
        f"""
        SELECT g.id AS game_id, g.white, g.black, g.opening, g.result,
               g.player_color, g.player_result, g.played_at, g.time_class,
               g.url, g.analysis_depth,
               m.ply, m.san, m.uci, m.fen_before, m.fen_after,
               m.eval, m.eval_mate, m.best_san
        FROM moves m
        JOIN games g ON g.id = m.game_id
        WHERE g.profile_id = ? AND m.label = 'Brilliant'
              AND m.side = g.player_color {tc_clause}
        ORDER BY COALESCE(g.played_at, g.analyzed_at) DESC, m.ply
        """,
        params,
    ).fetchall()
    return _rows_to_dicts(rows)


def phase_accuracy_rows(profile_id: int, time_class: str | None = None) -> list[dict[str, Any]]:
    """Average per-move accuracy proxy (cp_loss) grouped by phase, tracked side only.

    Optionally restricted to a single time control (bullet/blitz/rapid/...).
    """
    conn = get_conn()
    params: list[Any] = [profile_id]
    tc_clause = ""
    if time_class:
        tc_clause = "AND g.time_class = ?"
        params.append(time_class)
    rows = conn.execute(
        f"""
        SELECT m.phase AS phase,
               AVG(m.cp_loss) AS avg_cp_loss,
               COUNT(*) AS n
        FROM moves m
        JOIN games g ON g.id = m.game_id
        WHERE g.profile_id = ? AND m.side = g.player_color AND m.cp_loss IS NOT NULL {tc_clause}
        GROUP BY m.phase
        """,
        params,
    ).fetchall()
    return _rows_to_dicts(rows)


# --- JOBS ------------------------------------------------------------------

def create_job(profile_id: int, params: dict[str, Any], total: int = 0) -> int:
    conn = get_conn()
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO ingest_jobs (profile_id, status, total, done, params, created_at, updated_at) "
        "VALUES (?, 'queued', ?, 0, ?, ?, ?)",
        (profile_id, total, json.dumps(params), ts, ts),
    )
    conn.commit()
    return _inserted_id(cur)


def set_job_status(job_id: int, status: str, error: str | None = None) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE ingest_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
        (status, error, now_iso(), job_id),
    )
    conn.commit()


def set_job_total(job_id: int, total: int) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE ingest_jobs SET total = ?, updated_at = ? WHERE id = ?",
        (total, now_iso(), job_id),
    )
    conn.commit()


def bump_job_done(job_id: int) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE ingest_jobs SET done = done + 1, updated_at = ? WHERE id = ?",
        (now_iso(), job_id),
    )
    conn.commit()


def get_job(job_id: int) -> dict[str, Any] | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM ingest_jobs WHERE id = ?", (job_id,)).fetchone()
    return _row_to_dict(row)
