"""Ingest planning, cancellation and job orchestration — no engine, no network."""

import pytest

from player_db import ingest

# --- cancellation registry -------------------------------------------------

def test_a_job_is_not_cancelled_until_asked():
    registry = ingest._CancelRegistry()
    assert registry.is_cancelled(1) is False


def test_requesting_cancellation_is_visible_immediately():
    registry = ingest._CancelRegistry()
    registry.request(1)
    assert registry.is_cancelled(1) is True


def test_cancelling_one_job_leaves_the_others_alone():
    registry = ingest._CancelRegistry()
    registry.request(1)
    assert registry.is_cancelled(2) is False


def test_clearing_releases_the_job_id():
    registry = ingest._CancelRegistry()
    registry.request(1)
    registry.clear(1)
    assert registry.is_cancelled(1) is False


def test_clearing_an_unknown_job_is_harmless():
    ingest._CancelRegistry().clear(999)   # must not raise


# --- record classification (dedup + depth conflicts) -----------------------

def _record(pgn, **extra):
    return {"pgn": pgn, "white": "Marco", "black": "Rival", **extra}


def test_unseen_games_are_planned_for_analysis(temp_db):
    pid = temp_db.create_profile("Me")
    plan = ingest._classify_records(pid, [_record("1. e4"), _record("1. d4")], depth=14)
    assert len(plan["to_add"]) == 2
    assert plan["same_depth"] == []


def test_duplicates_inside_one_batch_are_collapsed(temp_db):
    pid = temp_db.create_profile("Me")
    plan = ingest._classify_records(pid, [_record("1. e4"), _record("1. e4")], depth=14)
    assert len(plan["to_add"]) == 1


def test_every_record_is_annotated_with_its_fingerprint(temp_db):
    pid = temp_db.create_profile("Me")
    records = [_record("1. e4")]
    ingest._classify_records(pid, records, depth=14)
    assert records[0]["_fingerprint"] == ingest.fingerprint("1. e4")


def test_a_game_already_stored_at_the_same_depth_is_skipped(temp_db):
    pid = temp_db.create_profile("Me")
    _store(temp_db, pid, "1. e4", depth=14)
    plan = ingest._classify_records(pid, [_record("1. e4")], depth=14)
    assert plan["to_add"] == []
    assert len(plan["same_depth"]) == 1


def test_a_game_stored_at_another_depth_is_a_conflict(temp_db):
    pid = temp_db.create_profile("Me")
    _store(temp_db, pid, "1. e4", depth=14)
    plan = ingest._classify_records(pid, [_record("1. e4")], depth=22)
    assert len(plan["conflicts"]) == 1
    assert plan["conflicts"][0]["_old_depth"] == 14


def test_dedup_does_not_leak_across_profiles(temp_db):
    a = temp_db.create_profile("A")
    b = temp_db.create_profile("B")
    _store(temp_db, a, "1. e4", depth=14)
    plan = ingest._classify_records(b, [_record("1. e4")], depth=14)
    assert len(plan["to_add"]) == 1


def _store(db, profile_id, pgn, depth):
    return db.upsert_game(
        profile_id,
        {"pgn": pgn, "pgn_fingerprint": ingest.fingerprint(pgn), "player_color": "white"},
        {"analysis_depth": depth, "label_counts": {}},
    )


# --- preview ---------------------------------------------------------------

def test_preview_counts_without_analysing(temp_db, monkeypatch):
    pid = temp_db.create_profile("Me")
    _store(temp_db, pid, "1. e4", depth=14)
    monkeypatch.setattr(
        ingest.sources, "fetch",
        lambda *a: [_record("1. e4"), _record("1. d4"), _record("1. c4")],
    )
    result = ingest.preview(pid, "lichess", "marco", 3, depth=14)
    assert result == {
        "fetched": 3,
        "to_add": 2,
        "duplicates_same_depth": 1,
        "depth_conflicts": [],
    }


def test_preview_reports_depth_conflicts_with_both_depths(temp_db, monkeypatch):
    pid = temp_db.create_profile("Me")
    _store(temp_db, pid, "1. e4", depth=14)
    monkeypatch.setattr(ingest.sources, "fetch", lambda *a: [_record("1. e4")])
    (conflict,) = ingest.preview(pid, "lichess", "marco", 1, depth=22)["depth_conflicts"]
    assert (conflict["old_depth"], conflict["new_depth"]) == (14, 22)


# --- job orchestration -----------------------------------------------------

@pytest.fixture
def worker(monkeypatch):
    """An IngestWorker whose analysis and persistence are stubbed out."""
    cancels = ingest._CancelRegistry()
    w = ingest.IngestWorker(cancels)
    persisted = []
    monkeypatch.setattr(ingest, "analyze_game_moves", lambda pgn, depth, cancel=None: [{"ply": 1}])
    monkeypatch.setattr(
        ingest, "_persist_game",
        lambda pid, rec, moves, depth: persisted.append(rec["pgn"]),
    )
    return w, cancels, persisted


def _queue_job(db, monkeypatch, pgns, count=None):
    pid = db.create_profile("Me")
    job_id = db.create_job(pid, {"platform": "lichess", "username": "marco",
                                 "count": count or len(pgns), "depth": 14})
    monkeypatch.setattr(ingest.sources, "fetch", lambda *a: [_record(p) for p in pgns])
    return job_id


def test_a_completed_job_persists_every_game_and_is_marked_done(temp_db, monkeypatch, worker):
    w, _, persisted = worker
    job_id = _queue_job(temp_db, monkeypatch, ["1. e4", "1. d4"])

    w.run_job(job_id)

    assert persisted == ["1. e4", "1. d4"]
    job = temp_db.get_job(job_id)
    assert job["status"] == "done"
    assert (job["done"], job["total"]) == (2, 2)


def test_a_job_cancelled_while_queued_never_fetches(temp_db, monkeypatch, worker):
    w, cancels, persisted = worker
    job_id = _queue_job(temp_db, monkeypatch, ["1. e4"])
    cancels.request(job_id)

    w.run_job(job_id)

    assert persisted == []
    assert temp_db.get_job(job_id)["status"] == "cancelled"


def test_cancelling_mid_run_keeps_the_games_already_analysed(temp_db, monkeypatch, worker):
    w, cancels, persisted = worker
    job_id = _queue_job(temp_db, monkeypatch, ["1. e4", "1. d4", "1. c4"])

    # Cancel as soon as the first game has been stored.
    def persist_then_cancel(pid, rec, moves, depth):
        persisted.append(rec["pgn"])
        cancels.request(job_id)

    monkeypatch.setattr(ingest, "_persist_game", persist_then_cancel)
    w.run_job(job_id)

    assert persisted == ["1. e4"]                              # kept, not rolled back
    assert temp_db.get_job(job_id)["status"] == "cancelled"


def test_one_unanalysable_game_does_not_abort_the_job(temp_db, monkeypatch, worker):
    w, _, persisted = worker
    job_id = _queue_job(temp_db, monkeypatch, ["bad", "1. d4"])

    def analyse(pgn, depth, cancel=None):
        if pgn == "bad":
            raise ValueError("corrupt PGN")
        return [{"ply": 1}]

    monkeypatch.setattr(ingest, "analyze_game_moves", analyse)
    w.run_job(job_id)

    assert persisted == ["1. d4"]
    assert temp_db.get_job(job_id)["status"] == "done"


def test_a_game_that_fails_to_persist_still_counts_as_processed(temp_db, monkeypatch, worker):
    w, _, _ = worker
    job_id = _queue_job(temp_db, monkeypatch, ["1. e4"])

    def explode(pid, rec, moves, depth):
        raise RuntimeError("disk full")

    monkeypatch.setattr(ingest, "_persist_game", explode)
    w.run_job(job_id)

    job = temp_db.get_job(job_id)
    assert job["status"] == "done"
    assert job["done"] == 1


def test_a_failing_fetch_marks_the_job_as_errored(temp_db, monkeypatch, worker):
    w, _, _ = worker
    pid = temp_db.create_profile("Me")
    job_id = temp_db.create_job(pid, {"platform": "lichess", "username": "x", "count": 1, "depth": 14})

    def boom(*a):
        raise ingest.sources.SourceError("lichess is down")

    monkeypatch.setattr(ingest.sources, "fetch", boom)
    w.run_job(job_id)

    job = temp_db.get_job(job_id)
    assert job["status"] == "error"
    assert "lichess is down" in job["error"]


def test_an_unknown_job_id_is_ignored(temp_db, worker):
    w, _, _ = worker
    w.run_job(999999)   # must not raise


def test_cancellation_state_is_released_when_a_job_ends(temp_db, monkeypatch, worker):
    w, cancels, _ = worker
    job_id = _queue_job(temp_db, monkeypatch, ["1. e4"])
    cancels.request(job_id)
    w.run_job(job_id)
    # The id must not linger, or a future job reusing it would die instantly.
    assert cancels.is_cancelled(job_id) is False
