"""Engine-free parts of analysis_core: classification, caching keys, sacrifices."""

import json

import chess
import pytest

import analysis_core

# --- classify_move ---------------------------------------------------------

def test_classify_move_ladder_is_ordered_by_severity():
    labels = [analysis_core.classify_move(cp)[0] for cp in (0, 10, 50, 100, 200, 400)]
    assert labels == ["Best", "Excellent", "Good", "Inaccuracy", "Mistake", "Blunder"]


def test_classify_move_returns_label_symbol_and_color():
    label, symbol, color = analysis_core.classify_move(0)
    assert label == "Best"
    assert symbol
    assert color.startswith("#")


def test_a_cheap_sacrifice_is_brilliant():
    assert analysis_core.classify_move(10, is_sacrifice=True)[0] == "Brilliant"


def test_a_sacrifice_that_loses_material_is_not_brilliant():
    assert analysis_core.classify_move(500, is_sacrifice=True)[0] == "Blunder"


# --- score_to_float --------------------------------------------------------

def test_score_to_float_converts_centipawns_to_pawns():
    score = chess.engine.PovScore(chess.engine.Cp(150), chess.WHITE)
    assert analysis_core.score_to_float(score) == 1.5


def test_score_to_float_is_signed_from_whites_point_of_view():
    score = chess.engine.PovScore(chess.engine.Cp(-150), chess.WHITE)
    assert analysis_core.score_to_float(score) == -1.5


# --- cache keys ------------------------------------------------------------

def test_normalize_fen_ignores_move_counters():
    a = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    b = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 42"
    assert analysis_core._normalize_fen(a) == analysis_core._normalize_fen(b)


def test_normalize_fen_keeps_en_passant_square():
    with_ep = "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 2"
    without = "rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2"
    assert analysis_core._normalize_fen(with_ep) != analysis_core._normalize_fen(without)


def test_strength_keys_are_distinct_per_setting():
    keys = {
        analysis_core._strength_key(None, None),
        analysis_core._strength_key(1500, None),
        analysis_core._strength_key(None, 5),
    }
    assert len(keys) == 3


def test_elo_takes_precedence_over_skill_level_in_the_cache_key():
    assert analysis_core._strength_key(1500, 5) == analysis_core._strength_key(1500, None)


# --- is_real_sacrifice -----------------------------------------------------

def test_a_quiet_developing_move_is_not_a_sacrifice():
    board = chess.Board()
    assert analysis_core.is_real_sacrifice(board, chess.Move.from_uci("e2e4")) is False


def test_an_equal_trade_is_not_a_sacrifice():
    # Knight takes knight, recaptured by a pawn: material is even, not a sac.
    board = chess.Board("rnbqkb1r/ppp1pppp/5n2/3p4/8/4PN2/PPPP1PPP/RNBQKB1R w KQkq - 0 1")
    move = chess.Move.from_uci("f3e5")
    if move in board.legal_moves:
        assert analysis_core.is_real_sacrifice(board, move) is False


def test_hanging_a_queen_to_a_pawn_is_a_sacrifice():
    # White queen steps onto a square attacked only by a black pawn.
    board = chess.Board("4k3/2p5/8/8/8/8/8/3QK3 w - - 0 1")
    move = chess.Move.from_uci("d1d6")
    assert move in board.legal_moves
    assert analysis_core.is_real_sacrifice(board, move) is True


def test_a_move_delivering_checkmate_is_never_a_sacrifice():
    # Qg7# — the queen lands next to the king, but the game ends there.
    board = chess.Board("7k/Q7/6K1/8/8/8/8/8 w - - 0 1")
    move = chess.Move.from_uci("a7g7")
    assert move in board.legal_moves
    assert analysis_core.is_real_sacrifice(board, move) is False


def test_is_real_sacrifice_leaves_the_board_untouched():
    board = chess.Board()
    before = board.fen()
    analysis_core.is_real_sacrifice(board, chess.Move.from_uci("e2e4"))
    assert board.fen() == before


# --- get_best_opening_name -------------------------------------------------

@pytest.fixture
def openings(monkeypatch):
    """Installs a small, controlled openings index behind the module-level API."""
    def install(mapping):
        book = analysis_core.OpeningBook()
        book.by_fen = mapping
        monkeypatch.setattr(analysis_core, "_book", book)
    return install


def _key(fen):
    return " ".join(fen.split()[:3])


def test_unknown_position_is_reported_as_custom(openings):
    openings({})
    assert analysis_core.get_best_opening_name(chess.STARTING_FEN) == "Custom Position"


def test_a_known_position_returns_its_opening_name(openings):
    openings({_key(chess.STARTING_FEN): ["Sicilian Defense"]})
    assert analysis_core.get_best_opening_name(chess.STARTING_FEN) == "Sicilian Defense"


def test_a_real_opening_wins_over_the_starting_position_placeholder(openings):
    """"Starting Position" is a placeholder: a genuine opening name must win.

    Regression test — the filter used to compare a lowercased name against a
    capitalised literal, so it never removed anything and the placeholder won
    on alphabetical order.
    """
    openings({_key(chess.STARTING_FEN): ["Starting Position", "Zukertort Opening"]})
    assert analysis_core.get_best_opening_name(chess.STARTING_FEN) == "Zukertort Opening"


def test_the_placeholder_survives_when_it_is_the_only_name(openings):
    openings({_key(chess.STARTING_FEN): ["Starting Position"]})
    assert analysis_core.get_best_opening_name(chess.STARTING_FEN) == "Starting Position"


def test_lookup_falls_back_to_a_shorter_fen_key(openings):
    fen = chess.STARTING_FEN
    openings({" ".join(fen.split()[:2]): ["Fallback Opening"]})
    assert analysis_core.get_best_opening_name(fen) == "Fallback Opening"


# --- sort_opening_dict -----------------------------------------------------

def test_openings_sort_deterministically_by_line_length_then_name():
    result = analysis_core.sort_opening_dict({
        "key-b": ["Bbbb"],
        "key-a": ["Aaaa"],
        "key-c": ["Cc"],
    })
    assert list(result) == ["key-c", "key-a", "key-b"]


# --- OpeningBook: loading --------------------------------------------------

def _write_book(tmp_path, data):
    (tmp_path / "openings.json").write_text(json.dumps(data), encoding="utf-8")
    book = analysis_core.OpeningBook()
    book.load(str(tmp_path))
    return book


def _after(sans):
    """FEN reached by playing `sans` from the initial position."""
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return board.fen()


def test_a_book_indexes_the_position_a_line_reaches(tmp_path):
    book = _write_book(tmp_path, {"Ruy Lopez": "1. e4 e5 2. Nf3 Nc6 3. Bb5"})
    assert book.name_for(_after(["e4", "e5", "Nf3", "Nc6", "Bb5"])) == "Ruy Lopez"


def test_transposing_lines_collapse_onto_one_position(tmp_path):
    """Two move orders reaching the same position index it once, not twice."""
    book = _write_book(tmp_path, {"Transposing Opening": ["1. e4 e5 2. Nf3", "1. Nf3 e5 2. e4"]})
    assert len(book) == 1


def test_distinct_lines_of_one_opening_index_separately(tmp_path):
    book = _write_book(tmp_path, {"Sicilian Defense": ["1. e4 c5 2. Nf3", "1. e4 c5 2. Nc3"]})
    assert len(book) == 2


def test_one_position_can_carry_several_opening_names(tmp_path):
    book = _write_book(tmp_path, {"Name A": "1. e4 e5", "Name B": "1. e4 e5"})
    assert book.name_for(_after(["e4", "e5"])) == "Name A"   # alphabetically first


def test_move_numbers_in_a_line_are_ignored(tmp_path):
    numbered = _write_book(tmp_path, {"O": "1. e4 e5 2. Nf3"})
    bare = _write_book(tmp_path, {"O": "e4 e5 Nf3"})
    assert list(numbered.by_fen) == list(bare.by_fen)


def test_an_illegal_line_is_recorded_instead_of_crashing_the_load(tmp_path):
    book = _write_book(tmp_path, {"Good": "1. e4 e5", "Nonsense": "1. e4 Qxh8"})
    assert "Nonsense" in book.invalid
    assert len(book) == 1          # the good line still made it in


def test_a_missing_openings_file_leaves_an_empty_book(tmp_path):
    book = analysis_core.OpeningBook()
    book.load(str(tmp_path / "does-not-exist"))
    assert len(book) == 0
    assert book.name_for(chess.STARTING_FEN) == "Custom Position"


def test_a_corrupt_openings_file_leaves_an_empty_book(tmp_path):
    (tmp_path / "openings.json").write_text("{not json", encoding="utf-8")
    book = analysis_core.OpeningBook()
    book.load(str(tmp_path))
    assert len(book) == 0


def test_reloading_replaces_the_previous_index_in_place(tmp_path):
    book = _write_book(tmp_path, {"First": "1. e4"})
    (tmp_path / "openings.json").write_text('{"Second": "1. d4"}', encoding="utf-8")
    book.load(str(tmp_path))
    names = [n for names in book.by_fen.values() for n in names]
    assert names == ["Second"]


# --- AnalysisEngine: caching -----------------------------------------------

class _FakeEngine:
    """Stands in for Stockfish: counts analyse() calls, returns a fixed score."""

    def __init__(self):
        self.calls = []
        self.options = {}

    def analyse(self, board, limit, multipv=1):
        self.calls.append(board.fen())
        return [{"pv": [next(iter(board.legal_moves))],
                 "score": chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE)}]

    def configure(self, options):
        pass

    def quit(self):
        pass


@pytest.fixture
def fake_engine():
    """An AnalysisEngine wired to a fake Stockfish, plus that fake."""
    engine = analysis_core.AnalysisEngine()
    fake = _FakeEngine()
    engine._engine = fake
    return engine, fake


def test_the_same_position_is_only_analysed_once(fake_engine):
    engine, fake = fake_engine
    board = chess.Board()
    for _ in range(3):
        engine.analyse_pair(board, chess.STARTING_FEN, None, 14, None, None)
    assert len(fake.calls) == 1


def test_move_counters_do_not_defeat_the_cache(fake_engine):
    engine, fake = fake_engine
    a = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    b = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 9 30"
    engine.analyse_pair(chess.Board(a), a, None, 14, None, None)
    engine.analyse_pair(chess.Board(b), b, None, 14, None, None)
    assert len(fake.calls) == 1


def test_a_different_depth_is_analysed_again(fake_engine):
    engine, fake = fake_engine
    board = chess.Board()
    engine.analyse_pair(board, chess.STARTING_FEN, None, 14, None, None)
    engine.analyse_pair(board, chess.STARTING_FEN, None, 20, None, None)
    assert len(fake.calls) == 2


def test_a_different_strength_setting_is_analysed_again(fake_engine):
    engine, fake = fake_engine
    board = chess.Board()
    engine.analyse_pair(board, chess.STARTING_FEN, None, 14, None, None)
    engine.analyse_pair(board, chess.STARTING_FEN, None, 14, 1500, None)
    assert len(fake.calls) == 2


def test_walking_a_game_forward_reuses_the_previous_position(fake_engine):
    engine, fake = fake_engine
    start = chess.Board()
    after_e4 = chess.Board()
    after_e4.push_san("e4")

    engine.analyse_pair(start, start.fen(), None, 14, None, None)
    engine.analyse_pair(after_e4, after_e4.fen(), start.fen(), 14, None, None)

    # The start position was analysed once, not again as the "previous" one.
    assert fake.calls.count(start.fen()) == 1


def test_the_cache_evicts_instead_of_growing_without_bound():
    engine = analysis_core.AnalysisEngine(max_cache_size=2)
    engine._engine = _FakeEngine()
    board = chess.Board()
    for depth in (10, 12, 14, 16):
        engine.analyse_pair(board, chess.STARTING_FEN, None, depth, None, None)
    assert len(engine._cache) <= 2
