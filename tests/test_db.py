"""Persistence layer: schema, dedup/upsert semantics, cascades and job state."""



# --- profiles --------------------------------------------------------------

def test_a_created_profile_can_be_read_back(temp_db):
    pid = temp_db.create_profile("Me", platform="lichess", username="marco")
    profile = temp_db.get_profile(pid)
    assert profile["label"] == "Me"
    assert profile["username"] == "marco"


def test_listing_profiles_reports_their_game_count(temp_db):
    pid = temp_db.create_profile("Me")
    _store_game(temp_db, pid, "1. e4")
    (profile,) = temp_db.list_profiles()
    assert profile["games_count"] == 1


def test_an_unknown_profile_reads_as_none(temp_db):
    assert temp_db.get_profile(9999) is None


def test_deleting_a_profile_cascades_to_its_games(temp_db):
    pid = temp_db.create_profile("Me")
    _store_game(temp_db, pid, "1. e4")
    temp_db.delete_profile(pid)
    assert temp_db.games_for_profile(pid) == []


# --- games -----------------------------------------------------------------

def _store_game(db, profile_id, pgn, fingerprint=None, depth=14, time_class="blitz", **aggregate_overrides):
    meta = {
        "pgn": pgn,
        "pgn_fingerprint": fingerprint or pgn,
        "white": "Marco",
        "black": "Rival",
        "result": "1-0",
        "player_color": "white",
        "player_result": "win",
        "time_class": time_class,
    }
    aggregates = {
        "accuracy": 90.0, "acpl": 12.0, "est_elo": 2000, "moves_count": 30,
        "analysis_depth": depth, "opening": "Sicilian Defense",
        "label_counts": {"Best": 5, "Blunder": 1},
        **aggregate_overrides,
    }
    return db.upsert_game(profile_id, meta, aggregates)


def test_a_stored_game_keeps_its_aggregates(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    game = temp_db.get_game(gid)
    assert game["accuracy"] == 90.0
    assert game["opening"] == "Sicilian Defense"


def test_label_counts_are_expanded_into_columns(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    game = temp_db.get_game(gid)
    assert game["best"] == 5
    assert game["blunder"] == 1
    assert game["brilliant"] == 0   # absent labels default to zero


def test_reingesting_the_same_game_updates_instead_of_duplicating(temp_db):
    pid = temp_db.create_profile("Me")
    first = _store_game(temp_db, pid, "1. e4", depth=14, accuracy=90.0)
    second = _store_game(temp_db, pid, "1. e4", depth=22, accuracy=95.0)

    assert first == second                       # same row, not a new one
    assert len(temp_db.games_for_profile(pid)) == 1
    game = temp_db.get_game(first)
    assert game["analysis_depth"] == 22          # updated to the new analysis
    assert game["accuracy"] == 95.0


def test_the_same_game_can_belong_to_two_profiles(temp_db):
    a = temp_db.create_profile("A")
    b = temp_db.create_profile("B")
    assert _store_game(temp_db, a, "1. e4") != _store_game(temp_db, b, "1. e4")


def test_games_are_listed_most_recent_first(temp_db):
    pid = temp_db.create_profile("Me")
    _store_game(temp_db, pid, "old", fingerprint="old")
    _store_game(temp_db, pid, "new", fingerprint="new")
    conn = temp_db.get_conn()
    conn.execute("UPDATE games SET played_at = '2020-01-01' WHERE pgn_fingerprint = 'old'")
    conn.execute("UPDATE games SET played_at = '2024-01-01' WHERE pgn_fingerprint = 'new'")
    conn.commit()

    played = [g["played_at"] for g in temp_db.games_for_profile(pid)]
    assert played == ["2024-01-01", "2020-01-01"]


def test_games_can_be_paginated_server_side(temp_db):
    pid = temp_db.create_profile("Me")
    for i in range(5):
        _store_game(temp_db, pid, f"g{i}", fingerprint=f"fp{i}")
    assert temp_db.count_games(pid) == 5
    assert len(temp_db.games_for_profile(pid, limit=2, offset=0)) == 2
    assert len(temp_db.games_for_profile(pid, limit=2, offset=4)) == 1  # last page


def test_games_and_count_can_be_filtered_by_time_control(temp_db):
    pid = temp_db.create_profile("Me")
    _store_game(temp_db, pid, "blitz1", fingerprint="b1", time_class="blitz")
    _store_game(temp_db, pid, "bullet1", fingerprint="u1", time_class="bullet")
    assert temp_db.count_games(pid, "blitz") == 1
    assert temp_db.count_games(pid, "bullet") == 1
    assert [g["time_class"] for g in temp_db.games_for_profile(pid, "blitz")] == ["blitz"]


def test_lookup_by_fingerprint_is_scoped_to_the_profile(temp_db):
    a = temp_db.create_profile("A")
    b = temp_db.create_profile("B")
    _store_game(temp_db, a, "1. e4", fingerprint="fp")
    assert temp_db.get_game_by_fingerprint(a, "fp") is not None
    assert temp_db.get_game_by_fingerprint(b, "fp") is None


# --- moves -----------------------------------------------------------------

def _move_rows(count=3, phase="opening"):
    return [{
        "ply": i, "side": "white" if i % 2 else "black", "san": "e4", "uci": "e2e4",
        "fen_before": "f1", "fen_after": "f2", "cp_loss": float(i * 10), "eval": 0.1,
        "eval_mate": None, "win_loss": float(i), "best_uci": "e2e4", "best_san": "e4",
        "best_score": 0.2, "best_mate": None, "label": "Best", "phase": phase,
    } for i in range(1, count + 1)]


def test_moves_round_trip_in_play_order(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    temp_db.replace_moves(gid, _move_rows(3))
    stored = temp_db.moves_for_game(gid)
    assert [m["ply"] for m in stored] == [1, 2, 3]
    assert stored[0]["cp_loss"] == 10.0


def test_replacing_moves_discards_the_previous_analysis(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    temp_db.replace_moves(gid, _move_rows(5))
    temp_db.replace_moves(gid, _move_rows(2))
    assert len(temp_db.moves_for_game(gid)) == 2


def test_deleting_a_profile_cascades_all_the_way_to_moves(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    temp_db.replace_moves(gid, _move_rows(3))
    temp_db.delete_profile(pid)
    assert temp_db.moves_for_game(gid) == []


def test_phase_accuracy_covers_only_the_tracked_side(temp_db):
    pid = temp_db.create_profile("Me")   # player_color is "white" in _store_game
    gid = _store_game(temp_db, pid, "1. e4")
    temp_db.replace_moves(gid, _move_rows(4))
    (row,) = temp_db.phase_accuracy_rows(pid)
    assert row["phase"] == "opening"
    assert row["n"] == 2                 # plies 1 and 3 only


def test_phase_accuracy_can_be_filtered_by_time_control(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    temp_db.replace_moves(gid, _move_rows(4))
    assert temp_db.phase_accuracy_rows(pid, "blitz")
    assert temp_db.phase_accuracy_rows(pid, "bullet") == []


# --- brilliant moves -------------------------------------------------------

def _brilliant_rows():
    """Four white moves; plies 1 and 3 are Brilliant, the tracked side is white."""
    rows = _move_rows(4)
    rows[0]["label"] = "Brilliant"
    rows[0]["san"] = "Nf5"
    rows[2]["label"] = "Brilliant"
    rows[2]["san"] = "Qh6"
    return rows


def test_brilliant_moves_returns_only_the_tracked_sides_brilliancies(temp_db):
    pid = temp_db.create_profile("Me")   # player_color is "white" in _store_game
    gid = _store_game(temp_db, pid, "1. e4")
    rows = _brilliant_rows()
    rows[1]["label"] = "Brilliant"       # a black (opponent) brilliancy: excluded
    temp_db.replace_moves(gid, rows)
    got = temp_db.brilliant_moves(pid)
    assert [b["ply"] for b in got] == [1, 3]
    assert got[0]["san"] == "Nf5"
    assert got[0]["game_id"] == gid
    assert got[0]["black"] == "Rival"    # game context travels with the move


def test_brilliant_moves_can_be_filtered_by_time_control(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")   # blitz
    temp_db.replace_moves(gid, _brilliant_rows())
    assert len(temp_db.brilliant_moves(pid, "blitz")) == 2
    assert temp_db.brilliant_moves(pid, "bullet") == []


# --- error moves (blunder explorer) ----------------------------------------

def test_error_moves_collects_the_tracked_sides_worst_moves_heaviest_first(temp_db):
    pid = temp_db.create_profile("Me")   # player_color is "white"
    gid = _store_game(temp_db, pid, "1. e4")
    rows = _move_rows(4)
    rows[0].update(label="Mistake", cp_loss=120.0, san="Qh5")   # white
    rows[1].update(label="Blunder", cp_loss=900.0, san="Kf2")   # black: excluded
    rows[2].update(label="Blunder", cp_loss=500.0, san="Bd3")   # white
    temp_db.replace_moves(gid, rows)

    got = temp_db.error_moves(pid)
    assert [m["san"] for m in got] == ["Bd3", "Qh5"]   # tracked side, worst first
    assert got[0]["label"] == "Blunder"


def test_error_moves_can_be_filtered_by_time_control(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")   # blitz
    rows = _move_rows(2)
    rows[0].update(label="Blunder", cp_loss=400.0)
    temp_db.replace_moves(gid, rows)
    assert len(temp_db.error_moves(pid, "blitz")) == 1
    assert temp_db.error_moves(pid, "bullet") == []


# --- time management -------------------------------------------------------

def test_time_management_measures_think_time_and_time_trouble(temp_db):
    pid = temp_db.create_profile("Me")   # player_color is "white"
    gid = _store_game(temp_db, pid, "1. e4")
    rows = _move_rows(4)
    rows[0].update(think_time=8.0, clock=100.0, phase="opening")        # white
    rows[2].update(think_time=2.0, clock=10.0, label="Blunder",
                   phase="middlegame")                                  # white, rushed
    temp_db.replace_moves(gid, rows)

    tm = temp_db.time_management_rows(pid)
    assert tm["moves"] == 2            # only the tracked side's clocked moves
    assert tm["avg_think"] == 5.0      # (8 + 2) / 2
    assert tm["time_trouble_errors"] == 1   # the blunder played with 10s left


def test_time_management_is_empty_without_clocks(temp_db):
    pid = temp_db.create_profile("Me")
    gid = _store_game(temp_db, pid, "1. e4")
    temp_db.replace_moves(gid, _move_rows(4))   # no clock/think_time set
    tm = temp_db.time_management_rows(pid)
    assert tm["moves"] == 0
    assert tm["avg_think"] is None


# --- jobs ------------------------------------------------------------------

def test_a_new_job_starts_queued_with_its_params(temp_db):
    pid = temp_db.create_profile("Me")
    job_id = temp_db.create_job(pid, {"platform": "lichess", "count": 10})
    job = temp_db.get_job(job_id)
    assert job["status"] == "queued"
    assert job["done"] == 0
    assert "lichess" in job["params"]


def test_job_progress_accumulates(temp_db):
    pid = temp_db.create_profile("Me")
    job_id = temp_db.create_job(pid, {})
    temp_db.set_job_total(job_id, 3)
    temp_db.bump_job_done(job_id)
    temp_db.bump_job_done(job_id)
    job = temp_db.get_job(job_id)
    assert (job["done"], job["total"]) == (2, 3)


def test_a_failed_job_keeps_its_error_message(temp_db):
    pid = temp_db.create_profile("Me")
    job_id = temp_db.create_job(pid, {})
    temp_db.set_job_status(job_id, "error", error="network down")
    job = temp_db.get_job(job_id)
    assert job["status"] == "error"
    assert job["error"] == "network down"


def test_startup_marks_jobs_left_running_as_interrupted(temp_db):
    """A worker killed mid-run must not leave jobs that look alive forever."""
    pid = temp_db.create_profile("Me")
    running = temp_db.create_job(pid, {})
    temp_db.set_job_status(running, "running")
    finished = temp_db.create_job(pid, {})
    temp_db.set_job_status(finished, "done")

    temp_db.init_db()   # simulate an app restart

    assert temp_db.get_job(running)["status"] == "interrupted"
    assert temp_db.get_job(finished)["status"] == "done"


def test_init_db_is_idempotent(temp_db):
    temp_db.init_db()
    temp_db.init_db()
    assert temp_db.list_profiles() == []
