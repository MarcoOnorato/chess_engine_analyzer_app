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
import queue
import threading
from typing import Any, Dict, List, Optional

import chess
import chess.pgn

import analysis_core
from . import db, sources, stats

_job_queue: "queue.Queue[int]" = queue.Queue()
_worker_started = False
_worker_lock = threading.Lock()


# --- fingerprint -----------------------------------------------------------

def fingerprint(pgn: str) -> str:
    """Stable SHA-1 of the normalized PGN (line endings + trailing space)."""
    normalized = "\n".join(line.rstrip() for line in pgn.replace("\r\n", "\n").splitlines())
    return hashlib.sha1(normalized.strip().encode("utf-8")).hexdigest()


# --- per-game analysis -----------------------------------------------------

def analyze_game_moves(pgn: str, depth: int) -> Optional[List[Dict[str, Any]]]:
    """
    Analyses a game's main line and returns per-move dicts ready for storage:
    { ply, side, san, uci, fen_before, fen_after, cp_loss, eval, label, phase }.
    Returns None if the PGN has no usable moves.
    """
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return None

    board = game.board()
    moves: List[Dict[str, Any]] = []
    ply = 0

    for mv in game.mainline_moves():
        ply += 1
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

        moves.append({
            "ply": ply,
            "side": "white" if ply % 2 == 1 else "black",
            "san": san,
            "uci": uci,
            "fen_before": fen_before,
            "fen_after": fen_after,
            "cp_loss": max(0.0, float(result.get("best_eval_loss") or 0.0)),
            "eval": result.get("eval"),
            "label": label,
            "opening": result.get("opening"),
            "phase": None,
        })

    if not moves:
        return None

    stats.assign_phases(moves)
    return moves


def _persist_game(profile_id: int, record: Dict[str, Any], moves: List[Dict[str, Any]], depth: int) -> None:
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
                  ("ply", "side", "san", "uci", "fen_before", "fen_after", "cp_loss", "eval", "label", "phase")}
                 for m in moves]
    db.replace_moves(game_id, move_rows)


# --- planning (dedup + depth conflicts) ------------------------------------

def _classify_records(profile_id: int, records: List[Dict[str, Any]], depth: int) -> Dict[str, Any]:
    """
    Splits fetched records into add / skip (same depth) / depth-conflict buckets,
    annotating each with its fingerprint. Mutates records with `_fingerprint`.
    """
    to_add: List[Dict[str, Any]] = []
    same_depth: List[Dict[str, Any]] = []
    conflicts: List[Dict[str, Any]] = []

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


def preview(profile_id: int, platform: str, username: str, count: int, depth: int) -> Dict[str, Any]:
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

def _run_job(job_id: int) -> None:
    job = db.get_job(job_id)
    if job is None:
        return
    import json
    params = json.loads(job.get("params") or "{}")
    profile_id = job["profile_id"]
    platform = params.get("platform", "")
    username = params.get("username", "")
    count = int(params.get("count", 10))
    depth = int(params.get("depth", 14))
    recompute = bool(params.get("recompute_conflicts", False))

    db.set_job_status(job_id, "running")
    try:
        records = sources.fetch(platform, username, count)
        for r in records:
            r["_username"] = username
        plan = _classify_records(profile_id, records, depth)

        work = list(plan["to_add"])
        if recompute:
            work += plan["conflicts"]

        db.set_job_total(job_id, len(work))

        for rec in work:
            try:
                moves = analyze_game_moves(rec.get("pgn", ""), depth)
                if moves:
                    _persist_game(profile_id, rec, moves, depth)
            except Exception as e:  # one bad game must not kill the whole job
                print(f"[player_db] skipped a game during ingest: {e}")
            finally:
                db.bump_job_done(job_id)

        db.set_job_status(job_id, "done")
    except Exception as e:
        db.set_job_status(job_id, "error", error=str(e))


def _worker_loop() -> None:
    while True:
        job_id = _job_queue.get()
        try:
            _run_job(job_id)
        except Exception as e:  # pragma: no cover - defensive
            print(f"[player_db] worker error on job {job_id}: {e}")
        finally:
            _job_queue.task_done()


def _ensure_worker() -> None:
    global _worker_started
    with _worker_lock:
        if not _worker_started:
            t = threading.Thread(target=_worker_loop, name="player-db-ingest", daemon=True)
            t.start()
            _worker_started = True


def start_ingest(profile_id: int, platform: str, username: str, count: int,
                 depth: int, recompute_conflicts: bool) -> int:
    """Creates a queued job and hands it to the worker. Returns the job id."""
    params = {
        "platform": platform,
        "username": username,
        "count": count,
        "depth": depth,
        "recompute_conflicts": recompute_conflicts,
    }
    job_id = db.create_job(profile_id, params)
    _ensure_worker()
    _job_queue.put(job_id)
    return job_id
