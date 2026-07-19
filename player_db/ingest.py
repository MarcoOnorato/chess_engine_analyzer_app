"""
Background ingestion for the Player DB.

A single daemon worker thread consumes ingest jobs from a queue. For each game it
parses the main line, runs `analysis_core.analyze_move` per ply (full strength,
at the requested depth) under the shared engine lock, aggregates the per-game
stats (via `stats`), and persists everything (via `db`).

Deduplication is per PGN content (`pgn_fingerprint`). A game already stored at
the *same* depth is skipped; a game stored at a *different* depth is only
recomputed when the caller passes `recompute_conflicts=True` (the UI asks the
user first — see routes.preview_ingest).
"""

import hashlib
import io
import json
import logging
import queue
import threading
from collections.abc import Callable
from typing import Any

import chess
import chess.pgn

import analysis_core

from . import db, sources, stats

logger = logging.getLogger(__name__)

class _CancelRegistry:
    """
    Job ids the user asked to stop.

    Cooperative: the worker polls it between games (and between plies of a
    game) and stops early, keeping whatever was already analyzed. Guarded by a
    lock because the flag is set from a Flask request thread and read from the
    worker thread.
    """

    def __init__(self) -> None:
        self._ids: set[int] = set()
        self._lock = threading.Lock()

    def request(self, job_id: int) -> None:
        with self._lock:
            self._ids.add(job_id)

    def is_cancelled(self, job_id: int) -> bool:
        with self._lock:
            return job_id in self._ids

    def clear(self, job_id: int) -> None:
        with self._lock:
            self._ids.discard(job_id)


_cancels = _CancelRegistry()


def request_cancel(job_id: int) -> None:
    """Asks the worker to stop the given job at the next safe point."""
    _cancels.request(job_id)


# --- fingerprint -----------------------------------------------------------

def fingerprint(pgn: str) -> str:
    """Stable SHA-1 of the normalized PGN (line endings + trailing space)."""
    normalized = "\n".join(line.rstrip() for line in pgn.replace("\r\n", "\n").splitlines())
    return hashlib.sha1(normalized.strip().encode("utf-8")).hexdigest()


# --- per-game analysis -----------------------------------------------------

def analyze_game_moves(
    pgn: str,
    depth: int,
    cancel_check: Callable[[], bool] | None = None,
) -> list[dict[str, Any]] | None:
    """
    Analyses a game's main line and returns per-move dicts ready for storage:
    { ply, side, san, uci, fen_before, fen_after, cp_loss, eval, label, phase }.
    Returns None if the PGN has no usable moves, or if `cancel_check()` becomes
    truthy mid-game (the partial game is then abandoned, not stored).
    """
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return None

    board = game.board()
    moves: list[dict[str, Any]] = []

    for ply, mv in enumerate(game.mainline_moves(), start=1):
        if cancel_check and cancel_check():
            return None
        fen_before = board.fen()
        san = board.san(mv)
        uci = mv.uci()
        board.push(mv)
        fen_after = board.fen()

        result = analysis_core.analyze_move(
            fen=fen_after,
            prev_fen=fen_before,
            last_move_uci=uci,
            depth=depth,
        )
        classification = result.get("classification") or {}
        label = classification.get("label")
        # Engine's preferred continuation from the resulting position; the
        # training categoriser reads it off the previous ply.
        best = (result.get("top_moves") or [{}])[0]

        moves.append({
            "ply": ply,
            "side": "white" if ply % 2 == 1 else "black",
            "san": san,
            "uci": uci,
            "fen_before": fen_before,
            "fen_after": fen_after,
            "cp_loss": max(0.0, float(result.get("best_eval_loss") or 0.0)),
            "eval": result.get("eval"),
            "eval_mate": result.get("eval_mate"),
            "best_uci": best.get("uci"),
            "best_san": best.get("san"),
            "best_score": best.get("score"),
            "best_mate": best.get("mate"),
            "label": label,
            "opening": result.get("opening"),
            "phase": None,
        })

    if not moves:
        return None

    stats.assign_phases(moves)
    return moves


def _persist_game(profile_id: int, record: dict[str, Any], moves: list[dict[str, Any]], depth: int) -> None:
    view = sources.player_view(record, record.get("_username", ""))
    aggregates = stats.aggregate_game(moves, view["player_color"] or "white", depth)

    meta = {
        "source": record.get("source"),
        "external_id": record.get("external_id"),
        "url": record.get("url"),
        "pgn": record["pgn"],
        "pgn_fingerprint": record["_fingerprint"],
        "white": record.get("white"),
        "black": record.get("black"),
        "result": record.get("result"),
        "played_at": record.get("played_at"),
        "time_class": record.get("time_class"),
        "eco": record.get("eco"),
        "player_color": view["player_color"],
        "player_result": view["player_result"],
    }
    game_id = db.upsert_game(profile_id, meta, aggregates)
    # persisted move rows don't carry 'opening'
    move_rows = [{k: m[k] for k in
                  ("ply", "side", "san", "uci", "fen_before", "fen_after", "cp_loss", "eval",
                   "eval_mate", "best_uci", "best_san", "best_score", "best_mate",
                   "label", "phase")}
                 for m in moves]
    db.replace_moves(game_id, move_rows)


# --- planning (dedup + depth conflicts) ------------------------------------

def _classify_records(profile_id: int, records: list[dict[str, Any]], depth: int) -> dict[str, Any]:
    """
    Splits fetched records into add / skip (same depth) / depth-conflict buckets,
    annotating each with its fingerprint. Mutates records with `_fingerprint`.
    """
    to_add: list[dict[str, Any]] = []
    same_depth: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []

    seen: set = set()
    for rec in records:
        fp = fingerprint(rec.get("pgn", ""))
        rec["_fingerprint"] = fp
        if fp in seen:
            continue  # duplicate within the fetched batch itself
        seen.add(fp)

        existing = db.get_game_by_fingerprint(profile_id, fp)
        if existing is None:
            to_add.append(rec)
        elif int(existing.get("analysis_depth") or 0) == int(depth):
            same_depth.append(rec)
        else:
            rec["_old_depth"] = existing.get("analysis_depth")
            conflicts.append(rec)

    return {"to_add": to_add, "same_depth": same_depth, "conflicts": conflicts}


def preview(profile_id: int, platform: str, username: str, count: int, depth: int) -> dict[str, Any]:
    """
    Cheap dry-run: fetch the game list and report how many would be added,
    skipped (same depth), or would conflict on depth. No analysis is run.
    """
    records = sources.fetch(platform, username, count)
    plan = _classify_records(profile_id, records, depth)
    return {
        "fetched": len(records),
        "to_add": len(plan["to_add"]),
        "duplicates_same_depth": len(plan["same_depth"]),
        "depth_conflicts": [
            {"white": r.get("white"), "black": r.get("black"),
             "old_depth": r.get("_old_depth"), "new_depth": depth}
            for r in plan["conflicts"]
        ],
    }


# --- worker ----------------------------------------------------------------

class IngestWorker:
    """
    Owns the job queue and the single daemon thread that drains it.

    The thread is started lazily on the first submitted job and lives for the
    process's lifetime, so ingestion never runs concurrently with itself — one
    job at a time, one engine at a time.
    """

    def __init__(self, cancels: _CancelRegistry) -> None:
        self._queue: queue.Queue[int] = queue.Queue()
        self._cancels = cancels
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def submit(self, job_id: int) -> None:
        self._ensure_running()
        self._queue.put(job_id)

    def _ensure_running(self) -> None:
        with self._start_lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._loop, name="player-db-ingest", daemon=True
                )
                self._thread.start()

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                self.run_job(job_id)
            except Exception:  # pragma: no cover - defensive: the worker must survive
                logger.exception("Worker error on job %s", job_id)
            finally:
                self._queue.task_done()

    # --- one job ---

    def run_job(self, job_id: int) -> None:
        """Fetches, analyses and persists every game a job asks for."""
        job = db.get_job(job_id)
        if job is None:
            return

        params = json.loads(job.get("params") or "{}")
        profile_id = job["profile_id"]
        depth = int(params.get("depth", 14))

        # Cancelled while still queued: stop before touching the network/engine.
        if self._cancels.is_cancelled(job_id):
            db.set_job_status(job_id, "cancelled")
            self._cancels.clear(job_id)
            return

        db.set_job_status(job_id, "running")
        try:
            work = self._plan(job_id, profile_id, params, depth)
            db.set_job_total(job_id, len(work))
            cancelled = self._process(job_id, profile_id, work, depth)
            db.set_job_status(job_id, "cancelled" if cancelled else "done")
        except Exception as e:
            logger.exception("Ingest job %s failed", job_id)
            db.set_job_status(job_id, "error", error=str(e))
        finally:
            self._cancels.clear(job_id)

    def _plan(self, job_id: int, profile_id: int,
              params: dict[str, Any], depth: int) -> list[dict[str, Any]]:
        """Fetches the archive and returns the games this job should analyse."""
        username = params.get("username", "")
        records = sources.fetch(params.get("platform", ""), username, int(params.get("count", 10)))
        for record in records:
            record["_username"] = username

        plan = _classify_records(profile_id, records, depth)
        work = list(plan["to_add"])
        if params.get("recompute_conflicts", False):
            work += plan["conflicts"]
        return work

    def _process(self, job_id: int, profile_id: int,
                 work: list[dict[str, Any]], depth: int) -> bool:
        """Analyses and stores each game. Returns True if the job was cancelled."""
        for record in work:
            if self._cancels.is_cancelled(job_id):
                return True

            try:
                moves = analyze_game_moves(
                    record.get("pgn", ""), depth,
                    lambda: self._cancels.is_cancelled(job_id),
                )
            except Exception:  # one bad game must not kill the whole job
                logger.warning("Skipped a game during ingest of job %s", job_id, exc_info=True)
                moves = None

            # analyze_game_moves returns None mid-game when cancelled — that
            # game is abandoned (not persisted) and must not count as done.
            if moves is None and self._cancels.is_cancelled(job_id):
                return True

            if moves:
                try:
                    _persist_game(profile_id, record, moves, depth)
                except Exception:
                    logger.error("Failed to persist a game for job %s", job_id, exc_info=True)
            db.bump_job_done(job_id)

        return False


_worker = IngestWorker(_cancels)


def start_ingest(profile_id: int, platform: str, username: str, count: int,
                 depth: int, recompute_conflicts: bool) -> int:
    """Creates a queued job and hands it to the worker. Returns the job id."""
    job_id = db.create_job(profile_id, {
        "platform": platform,
        "username": username,
        "count": count,
        "depth": depth,
        "recompute_conflicts": recompute_conflicts,
    })
    _worker.submit(job_id)
    return job_id
