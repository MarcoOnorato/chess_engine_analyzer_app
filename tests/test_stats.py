"""Pure analysis math for the Player DB — no engine, no database."""

import chess

from player_db import stats

# --- move_accuracy ---------------------------------------------------------

def test_move_accuracy_perfect_move_is_100():
    assert stats.move_accuracy(0.0) == 100.0


def test_move_accuracy_decays_monotonically():
    values = [stats.move_accuracy(cp) for cp in (0, 10, 50, 100, 300)]
    assert values == sorted(values, reverse=True)


def test_move_accuracy_is_clamped_to_range():
    assert stats.move_accuracy(100_000) >= 0.0
    assert stats.move_accuracy(-100_000) <= 100.0


def test_move_accuracy_passes_none_through():
    assert stats.move_accuracy(None) is None


# --- estimate_elo ----------------------------------------------------------

def test_estimate_elo_at_curve_endpoints():
    assert stats.estimate_elo(0) == stats.ELO_CURVE[0][1]
    assert stats.estimate_elo(10_000) == stats.ELO_CURVE[-1][1]


def test_estimate_elo_interpolates_between_control_points():
    # Midway between (0, 2900) and (5, 2700).
    assert stats.estimate_elo(2.5) == 2800


def test_estimate_elo_decreases_as_acpl_grows():
    values = [stats.estimate_elo(acpl) for acpl in (5, 20, 50, 100)]
    assert values == sorted(values, reverse=True)


def test_estimate_elo_handles_none_and_nan():
    assert stats.estimate_elo(None) is None
    assert stats.estimate_elo(float("nan")) is None


# --- material_phase_score --------------------------------------------------

def test_material_phase_score_counts_only_non_pawn_pieces():
    # Starting position: (Q9 + 2R10 + 2B6 + 2N6) x 2 sides = 62.
    assert stats.material_phase_score(chess.STARTING_FEN) == 62


def test_material_phase_score_ignores_pawns_and_kings():
    assert stats.material_phase_score("4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1") == 0


# --- assign_phases ---------------------------------------------------------

def _move(ply, opening=None, fen_after=chess.STARTING_FEN):
    return {"ply": ply, "opening": opening, "fen_after": fen_after, "side": "white"}


def test_assign_phases_opening_extends_to_deepest_book_move():
    moves = [_move(p, opening="Sicilian Defense" if p <= 25 else None) for p in range(1, 31)]
    stats.assign_phases(moves)
    assert moves[24]["phase"] == "opening"   # ply 25, last book move
    assert moves[25]["phase"] == "middlegame"


def test_assign_phases_has_a_minimum_opening_length():
    moves = [_move(p) for p in range(1, 31)]  # no book openings at all
    stats.assign_phases(moves)
    assert moves[stats.MIN_OPENING_PLY - 1]["phase"] == "opening"
    assert moves[stats.MIN_OPENING_PLY]["phase"] == "middlegame"


def test_assign_phases_ignores_book_moves_past_the_cap():
    moves = [_move(p, opening="Some Opening") for p in range(1, 61)]
    stats.assign_phases(moves)
    assert moves[stats.OPENING_PLY_CAP - 1]["phase"] == "opening"
    assert moves[stats.OPENING_PLY_CAP]["phase"] == "middlegame"


def test_assign_phases_placeholder_openings_are_not_book():
    moves = [_move(p, opening="Custom Position") for p in range(1, 31)]
    stats.assign_phases(moves)
    assert moves[stats.MIN_OPENING_PLY]["phase"] == "middlegame"


def test_assign_phases_endgame_is_monotonic():
    bare = "4k3/8/8/8/8/8/8/4K3 w - - 0 1"  # material score 0
    moves = [_move(1), _move(2, fen_after=bare), _move(3)]
    stats.assign_phases(moves)
    # Once endgame is reached it must never revert, even if material "returns".
    assert [m["phase"] for m in moves] == ["opening", "endgame", "endgame"]


# --- game_opening_name -----------------------------------------------------

def test_game_opening_name_returns_deepest_book_line():
    moves = [
        _move(1, opening="King's Pawn Opening"),
        _move(3, opening="Sicilian Defense"),
        _move(5, opening=None),
    ]
    assert stats.game_opening_name(moves) == "Sicilian Defense"


def test_game_opening_name_defaults_when_nothing_recognized():
    assert stats.game_opening_name([_move(1), _move(2)]) == "Starting Position"


def test_game_opening_name_ignores_moves_past_the_cap():
    moves = [_move(stats.OPENING_PLY_CAP + 1, opening="Late Nonsense")]
    assert stats.game_opening_name(moves) == "Starting Position"


# --- aggregate_game --------------------------------------------------------

def _analyzed(ply, side, cp_loss, label):
    return {
        "ply": ply, "side": side, "cp_loss": cp_loss, "label": label,
        "opening": None, "fen_after": chess.STARTING_FEN,
    }


def test_aggregate_game_only_counts_the_tracked_side():
    moves = [
        _analyzed(1, "white", 0.0, "Best"),
        _analyzed(2, "black", 500.0, "Blunder"),
        _analyzed(3, "white", 10.0, "Excellent"),
    ]
    agg = stats.aggregate_game(moves, "white", depth=14)
    assert agg["moves_count"] == 2
    assert agg["acpl"] == 5.0
    assert agg["label_counts"] == {"Best": 1, "Excellent": 1}


def test_aggregate_game_reports_the_requested_depth():
    agg = stats.aggregate_game([_analyzed(1, "white", 0.0, "Best")], "white", depth=22)
    assert agg["analysis_depth"] == 22


def test_aggregate_game_with_no_tracked_moves_yields_nulls():
    agg = stats.aggregate_game([_analyzed(1, "black", 10.0, "Good")], "white", depth=14)
    assert agg["accuracy"] is None
    assert agg["acpl"] is None
    assert agg["est_elo"] is None
    assert agg["moves_count"] == 0


def test_aggregate_game_accuracy_tracks_cp_loss():
    clean = stats.aggregate_game([_analyzed(1, "white", 0.0, "Best")], "white", 14)
    sloppy = stats.aggregate_game([_analyzed(1, "white", 300.0, "Blunder")], "white", 14)
    assert clean["accuracy"] > sloppy["accuracy"]


# --- _summarize ------------------------------------------------------------

def test_summarize_weights_accuracy_by_move_count():
    games = [
        {"player_result": "win", "moves_count": 10, "accuracy": 90.0, "acpl": 10.0},
        {"player_result": "loss", "moves_count": 90, "accuracy": 50.0, "acpl": 50.0},
    ]
    summary = stats._summarize(games)
    # Move-weighted, so the 90-move game dominates: (90*10 + 50*90) / 100 = 54.
    assert summary["avg_accuracy"] == 54.0
    assert summary["winrate"] == 50.0


def test_summarize_of_empty_set_does_not_divide_by_zero():
    summary = stats._summarize([])
    assert summary["games"] == 0
    assert summary["winrate"] is None
    assert summary["avg_accuracy"] is None


def test_summarize_skips_games_without_analysis():
    games = [
        {"player_result": "win", "moves_count": 0, "accuracy": None, "acpl": None},
        {"player_result": "draw", "moves_count": 20, "accuracy": 80.0, "acpl": 20.0},
    ]
    summary = stats._summarize(games)
    assert summary["games"] == 2
    assert summary["avg_accuracy"] == 80.0


# --- time control ordering -------------------------------------------------

def test_known_time_classes_sort_before_unknown_ones():
    keys = sorted(["zzz-custom", "blitz", "bullet"], key=stats._time_class_order_key)
    assert keys == ["bullet", "blitz", "zzz-custom"]
