"""
Shared analysis core: Stockfish engine management, move classification, opening
recognition, and the single-position analysis routine used by both the live
`/api/analyze` endpoint and the Player DB batch ingester.

This module was extracted from `app.py` so the ingestion worker can reuse the
*exact* same engine, cache, and (tricky) move-classification logic without
re-importing `app.py` — importing the `__main__` module would spin up a second
engine.

State lives in two objects rather than module globals:

    OpeningBook     — the FEN -> opening-name index, reloadable in place.
    AnalysisEngine  — the Stockfish process, its lock and its result caches.

Both are instantiated once at the bottom of this module and exposed through
thin module-level functions, so callers keep the original flat API
(`analyze_move`, `init_engine`, `get_best_opening_name`, ...) while the state
itself stays encapsulated and independently constructible in tests.
"""

import json
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import chess
import chess.engine

logger = logging.getLogger(__name__)

# --- CONFIG ---------------------------------------------------------------

STOCKFISH_PATH: Path = Path(os.getenv(
    "STOCKFISH_PATH",
    r"windows_stockfish\stockfish-windows-x86-64-avx2.exe"
))

PIECE_VALUES: dict[int, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0
}

# Placeholder names used when a position matches no real book line. They are
# never a useful answer if a genuine opening name is also available.
CUSTOM_POSITION = "Custom Position"
STARTING_POSITION = "Starting Position"
_PLACEHOLDER_OPENINGS = {CUSTOM_POSITION.lower(), STARTING_POSITION.lower()}

# How many principal-variation moves to expose as a human-readable continuation.
CONTINUATION_LENGTH = 10
MULTIPV = 3

# Score used to turn a forced mate into a comparable centipawn number.
MATE_CP = 10000

# Classification thresholds, in centipawns of evaluation lost.
BRILLIANT_MAX_LOSS = 20
BEST_MAX_LOSS = 5
EXCELLENT_MAX_LOSS = 30
GOOD_MAX_LOSS = 80
INACCURACY_MAX_LOSS = 150
MISTAKE_MAX_LOSS = 300

_BEST = ("Best", "★", "#26bbff")


# --- OPENINGS -------------------------------------------------------------

def sort_opening_dict(openings: dict[str, list[str]]) -> "OrderedDict[str, list[str]]":
    """
    Sorts the openings dictionary for deterministic querying: by sequence length,
    then alphabetically.
    """
    return OrderedDict(
        sorted(
            openings.items(),
            key=lambda item: (
                len(item[1][0]),   # First line length
                item[0].lower()    # Alphabetical order
            )
        )
    )


class OpeningBook:
    """
    FEN-prefix -> opening-name index, built from ``<static>/openings.json``.

    Reloading mutates the instance in place so the module-level singleton stays
    the same object for anyone holding a reference to it.
    """

    def __init__(self) -> None:
        self.by_fen: OrderedDict[str, list[str]] = OrderedDict()
        self.invalid: dict[str, list[dict[str, str]]] = {}

    def __len__(self) -> int:
        return len(self.by_fen)

    def load(self, static_folder: str = "static") -> None:
        """Replaces the index with the contents of ``<static_folder>/openings.json``."""
        path = Path(static_folder) / "openings.json"
        parsed: dict[str, list[str]] = {}
        invalid: dict[str, list[dict[str, str]]] = {}

        try:
            with path.open("r", encoding="utf-8") as f:
                data: dict[str, str | list[str]] = json.load(f)

            for opening_name, raw_sequences in data.items():
                sequences = [raw_sequences] if isinstance(raw_sequences, str) else raw_sequences
                for seq in sequences:
                    try:
                        fen_key = self._replay(seq)
                    except ValueError as e:
                        invalid.setdefault(opening_name, []).append(
                            {"sequence": seq, "error": str(e)}
                        )
                        continue

                    names = parsed.setdefault(fen_key, [])
                    if opening_name not in names:
                        names.append(opening_name)

        except (OSError, json.JSONDecodeError):
            logger.exception("Could not load the openings database from %s", path)
            return

        self.by_fen = sort_opening_dict(parsed)
        self.invalid = invalid

        logger.info("Loaded openings: %d positions", len(self.by_fen))
        if invalid:
            logger.warning("Skipped %d opening(s) with unplayable lines", len(invalid))
            for name, errors in invalid.items():
                logger.debug("  %s: %s", name, "; ".join(e["error"] for e in errors))

    @staticmethod
    def _replay(sequence: str) -> str:
        """
        Plays a SAN sequence and returns its FEN key: the first 3 FEN fields
        (piece placement, active color, castling rights). Raises ValueError on
        an illegal or unparseable line.
        """
        board = chess.Board()
        tokens = sequence.replace("\n", " ").split()
        for token in tokens:
            # Skip move numbers ("1." / "1..." / "1").
            if token.endswith(".") or token.replace(".", "").isdigit():
                continue
            board.push_san(token)
        return " ".join(board.fen().split()[:3])

    def name_for(self, fen: str) -> str:
        """
        Matches a FEN to the most relevant opening name, falling back to the
        "Custom Position" / "Starting Position" placeholders.
        """
        parts = fen.split()
        names = (
            self.by_fen.get(" ".join(parts[:3]))
            or self.by_fen.get(" ".join(parts[:2]))
            or []
        )
        if not names:
            return CUSTOM_POSITION

        # A genuine opening name always beats the "Starting Position"
        # placeholder, which is only meaningful when nothing else matched.
        real_names = [n for n in names if n.lower() not in _PLACEHOLDER_OPENINGS]
        if not real_names:
            return STARTING_POSITION

        return min(real_names)


# --- SACRIFICE / CLASSIFICATION -------------------------------------------

def is_real_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    """
    True when `move` deliberately leaves material en prise: the moving piece is
    worth more than whatever it captured, and the opponent can legally win it.
    The board is restored before returning.
    """
    moving_piece = board.piece_at(move.from_square)
    if not moving_piece:
        return False

    my_value = PIECE_VALUES.get(moving_piece.piece_type, 0)
    captured_piece = board.piece_at(move.to_square)
    captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0

    board.push(move)
    try:
        # Delivering mate ends the game — nothing can be "won back".
        if board.is_checkmate():
            return False

        if my_value <= captured_value:
            return False

        target = move.to_square
        opponent_color = board.turn
        attacker_values = [
            PIECE_VALUES[piece.piece_type]
            for square in board.attackers(opponent_color, target)
            if chess.Move(square, target) in board.legal_moves
            and (piece := board.piece_at(square)) is not None
        ]
        if not attacker_values:
            return False

        # Undefended: the material is simply lost. Defended: it is still a
        # sacrifice if the opponent can capture with something cheaper.
        if not board.is_attacked_by(not opponent_color, target):
            return True
        return min(attacker_values) < my_value
    finally:
        board.pop()


def classify_move(score_diff: float, is_sacrifice: bool = False) -> tuple[str, str, str]:
    """
    Classifies a move based on the engine score difference and sacrifice status.
    Returns (label, symbol, hex color).
    """
    if is_sacrifice and score_diff < BRILLIANT_MAX_LOSS:
        return "Brilliant", "!!", "#15a2b8"
    if score_diff <= BEST_MAX_LOSS:
        return _BEST
    if score_diff < EXCELLENT_MAX_LOSS:
        return "Excellent", "++", "#96bc4b"
    if score_diff < GOOD_MAX_LOSS:
        return "Good", "+", "#96bc4b"
    if score_diff < INACCURACY_MAX_LOSS:
        return "Inaccuracy", "?!", "#f0c15c"
    if score_diff < MISTAKE_MAX_LOSS:
        return "Mistake", "?", "#e6912c"
    return "Blunder", "??", "#b33430"


def score_to_float(score_obj: chess.engine.PovScore, pov_white: bool = True) -> float:
    """Converts an engine PovScore into a float value representing pawns."""
    cp = score_obj.white().score(mate_score=MATE_CP) if pov_white \
        else score_obj.relative.score(mate_score=MATE_CP)
    return cp / 100.0 if cp is not None else 0.0


def extract_top_moves(info_list: list[Any], board: chess.Board) -> list[dict[str, Any]]:
    """Turns raw engine multipv info into the move dicts the frontend consumes."""
    moves: list[dict[str, Any]] = []

    for entry in info_list:
        pv = entry.get("pv") or []
        if not pv:
            continue

        move: chess.Move = pv[0]
        score: chess.engine.Score = entry["score"].white()
        uci_str = move.uci()

        continuation_board = board.copy()
        continuation_san = []
        for pv_move in pv[:CONTINUATION_LENGTH]:
            continuation_san.append(continuation_board.san(pv_move))
            continuation_board.push(pv_move)

        mate = score.mate() if score.is_mate() else None
        moves.append({
            "uci": uci_str,
            "san": board.san(move),
            "from": uci_str[:2],
            "to": uci_str[2:4],
            "score": None if mate is not None else (score.score() or 0) / 100,
            "mate": mate,
            "continuation": " ".join(continuation_san),
        })

    return moves


# --- ENGINE ---------------------------------------------------------------

def _normalize_fen(fen: str) -> str:
    """
    Returns the first 4 fields of the FEN (piece placement, active color,
    castling rights, and en passant target square) so identical positions match
    regardless of the halfmove/fullmove counters.
    """
    return " ".join(fen.split()[:4])


def _strength_key(engine_elo: int | None, skill_level: int | None) -> str:
    """Stable cache key for engine-strength settings."""
    if engine_elo is not None:
        return f"elo:{engine_elo}"
    if skill_level is not None:
        return f"skill:{skill_level}"
    return "full"


def _option_bounds(engine: chess.engine.SimpleEngine, name: str) -> tuple[int | None, int | None]:
    option = engine.options.get(name)
    if option is None:
        return None, None
    return getattr(option, "min", None), getattr(option, "max", None)


def _clamp_optional(value: int, low: int | None, high: int | None) -> int:
    if low is not None:
        value = max(low, value)
    if high is not None:
        value = min(high, value)
    return value


class AnalysisEngine:
    """
    Owns the single Stockfish process plus the caches around it.

    One engine runs sequentially behind `_lock`, which is what makes it safe to
    share between the Flask request threads and the Player DB ingestion worker.
    Two caches sit in front of it:

      * `_cache` — (normalized FEN, depth, strength) -> engine info, so a
        position analysed once is never analysed again at the same settings.
      * `_last`  — the previous call's result, so walking a game forward reuses
        position N when the caller asks for N+1.

    Everything the lock protects is an attribute of this object, so there is no
    way to touch the shared state without going through it.
    """

    def __init__(self, path: Path = STOCKFISH_PATH, max_cache_size: int = 50_000) -> None:
        self._path = path
        self._max_cache_size = max_cache_size
        self._engine: chess.engine.SimpleEngine | None = None
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, int, str], list[Any]] = {}
        self._last: dict[str, Any] = {}

    # --- lifecycle ---

    def _spawn(self) -> chess.engine.SimpleEngine:
        engine = chess.engine.SimpleEngine.popen_uci(str(self._path))
        hash_mb = max(16, 8192 // 16)
        engine.configure({
            "Threads": max(1, (os.cpu_count() or 2) - 1),
            "Hash": hash_mb,
        })
        logger.info("Stockfish started (hash %d MB)", hash_mb)
        return engine

    def start(self) -> None:
        """Spawns the engine eagerly, so startup cost is not paid by a request."""
        with self._lock:
            if self._engine is None:
                self._engine = self._spawn()

    def _get(self) -> chess.engine.SimpleEngine:
        """Returns the running engine, spawning it on demand. Caller holds the lock."""
        if self._engine is None:
            self._engine = self._spawn()
        return self._engine

    def close(self) -> None:
        with self._lock:
            if self._engine is None:
                return
            try:
                self._engine.quit()
            except Exception:
                # Shutdown path: a dead engine must not mask the app's exit.
                logger.debug("Stockfish did not shut down cleanly", exc_info=True)
            self._engine = None

    # --- caching ---

    def _remember(self, fen: str, depth: int, strength_key: str, info_list: list[Any]) -> None:
        if len(self._cache) >= self._max_cache_size:
            # FIFO eviction: drop the oldest entry.
            self._cache.pop(next(iter(self._cache)), None)
        self._cache[(_normalize_fen(fen), depth, strength_key)] = info_list

    def _analyse_cached(
        self,
        engine: chess.engine.SimpleEngine,
        board: chess.Board,
        fen: str,
        depth: int,
        strength_key: str,
    ) -> list[Any]:
        """Cache-first analysis of one position. Caller holds the lock."""
        key = (_normalize_fen(fen), depth, strength_key)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        # The previous call's result is still usable if it was at least as deep.
        if (
            self._last.get("fen") == fen
            and self._last.get("depth", 0) >= depth
            and self._last.get("strength_key") == strength_key
        ):
            return self._last["info"]

        info_list = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=MULTIPV)
        self._remember(fen, depth, strength_key, info_list)
        return info_list

    def _apply_strength(self, engine: chess.engine.SimpleEngine,
                        engine_elo: int | None, skill_level: int | None) -> None:
        """
        Configures Stockfish strength for the next analysis call. For normal app
        analysis both values are None, so the engine is restored to full strength.
        """
        opts: dict[str, Any] = {}
        options = engine.options

        if engine_elo is not None and "UCI_LimitStrength" in options and "UCI_Elo" in options:
            opts["UCI_LimitStrength"] = True
            opts["UCI_Elo"] = _clamp_optional(engine_elo, *_option_bounds(engine, "UCI_Elo"))
            if "Skill Level" in options:
                opts["Skill Level"] = _clamp_optional(20, *_option_bounds(engine, "Skill Level"))
        else:
            if "UCI_LimitStrength" in options:
                opts["UCI_LimitStrength"] = False
            if "Skill Level" in options:
                low, high = _option_bounds(engine, "Skill Level")
                requested = _clamp_optional(20, low, high) if skill_level is None else skill_level
                opts["Skill Level"] = _clamp_optional(requested, low, high)

        if opts:
            engine.configure(opts)

    # --- analysis ---

    def analyse_pair(
        self,
        board: chess.Board,
        fen: str,
        prev_fen: str | None,
        depth: int,
        engine_elo: int | None,
        skill_level: int | None,
    ) -> tuple[list[Any], list[Any] | None]:
        """
        Analyses the current position and, when given, the one before it.

        Returns (current info, previous info). Both positions are resolved in a
        single critical section so the engine's strength settings cannot change
        underneath them, and `_last` is published before the lock is released —
        clear()+update() is not atomic, and a reader must never observe an empty
        or half-written dict.
        """
        strength_key = _strength_key(engine_elo, skill_level)

        with self._lock:
            engine = self._get()
            self._apply_strength(engine, engine_elo, skill_level)

            prev_info = None
            if prev_fen:
                prev_info = self._analyse_cached(
                    engine, chess.Board(prev_fen), prev_fen, depth, strength_key
                )

            info = self._analyse_cached(engine, board, fen, depth, strength_key)

            self._last = {
                "fen": fen,
                "depth": depth,
                "strength_key": strength_key,
                "info": info,
            }

        return info, prev_info


# --- MOVE CLASSIFICATION ---------------------------------------------------

def _current_eval(top: dict[str, Any] | None) -> tuple[float, int | None]:
    """Evaluation of the position as (pawns, mate-in-N) from White's side."""
    if not top:
        return 0.0, None
    mate = top.get("mate")
    if mate is not None:
        return (100.0 if mate > 0 else -100.0), mate
    return top["score"], None


def _classify_last_move(
    prev_board: chess.Board,
    last_move: chess.Move,
    prev_info: list[Any],
    info: list[Any],
) -> tuple[dict[str, Any], tuple[float, int | None] | None]:
    """
    Classifies the move that led to the current position.

    Returns the classification dict plus, when the move ends the game, an
    evaluation override for the resulting position (mate is not a number the
    engine reports for a finished game).
    """
    prev_best_score = prev_info[0]["score"]
    curr_score = info[0]["score"] if info else None

    post_board = prev_board.copy(stack=False)
    post_board.push(last_move)

    # Checkmate is always the best move, and fixes the evaluation outright.
    if post_board.is_checkmate():
        label, symbol, color = _BEST
        mate = 1 if prev_board.turn == chess.WHITE else -1
        return (
            {"label": label, "symbol": symbol, "color": color, "diff_cp": 0.0},
            (100.0 if mate > 0 else -100.0, mate),
        )

    prev_best_is_mate = prev_best_score.relative.is_mate()

    if curr_score is not None and curr_score.relative.is_mate() and prev_best_is_mate:
        # Still mating, just slower: penalise the delay but never call it a blunder.
        prev_distance = abs(prev_best_score.relative.mate() or 0)
        curr_distance = abs(curr_score.relative.mate() or 0)
        delay = max(0, curr_distance - prev_distance)
        diff = min(delay * 30.0, INACCURACY_MAX_LOSS - 1.0)
        label, symbol, color = classify_move(diff, is_real_sacrifice(prev_board, last_move))

    else:
        best_eval_prev = prev_best_score.relative.score(mate_score=MATE_CP) or 0
        # The current score is from the mover's opponent's point of view.
        actual_eval = -(curr_score.relative.score(mate_score=MATE_CP) or 0) if curr_score else 0
        diff = max(0.0, float(best_eval_prev - actual_eval))

        if prev_board.legal_moves.count() == 1:
            # Forced: there was nothing else to play.
            label, symbol, color = _BEST
            diff = 0.0
        elif diff >= 200 and best_eval_prev >= 150 and actual_eval >= -150:
            # A won position squandered, but not yet lost.
            label, symbol, color = "Miss", "Ø", "#ff7769"
        else:
            label, symbol, color = classify_move(diff, is_real_sacrifice(prev_board, last_move))

    return {"label": label, "symbol": symbol, "color": color, "diff_cp": diff}, None


# --- SINGLETONS + PUBLIC API ----------------------------------------------

_book = OpeningBook()
_engine = AnalysisEngine()


def load_openings_database(static_folder: str = "static") -> None:
    """Loads (or reloads) the shared openings index."""
    _book.load(static_folder)


def get_best_opening_name(fen: str) -> str:
    """Most relevant opening name for a FEN, from the shared openings index."""
    return _book.name_for(fen)


def init_engine() -> None:
    """Starts the shared Stockfish process."""
    _engine.start()


def close_engine() -> None:
    """Stops the shared Stockfish process."""
    _engine.close()


def analyze_move(
    fen: str,
    prev_fen: str | None = None,
    last_move_uci: str | None = None,
    depth: int = 14,
    engine_elo: int | None = None,
    skill_level: int | None = None,
) -> dict[str, Any]:
    """
    Analyses ``fen`` at ``depth`` and, if ``prev_fen`` + ``last_move_uci`` are
    supplied, classifies the move that led to ``fen`` (Brilliant → Blunder,
    cpLoss, mate handling). Returns the same dict shape the ``/api/analyze``
    endpoint serialises.

    This is the single source of truth for move analysis: both the live endpoint
    and the Player DB batch ingester call it against the shared engine.
    """
    board = chess.Board(fen)

    opening = _book.name_for(fen)
    if board.fullmove_number <= 1 and opening == CUSTOM_POSITION:
        opening = STARTING_POSITION

    info, prev_info = _engine.analyse_pair(
        board, fen, prev_fen, depth, engine_elo, skill_level
    )

    top_moves = extract_top_moves(info, board)
    eval_score, eval_mate = _current_eval(top_moves[0] if top_moves else None)

    classification: dict[str, Any] | None = None
    alternative_moves: list[dict[str, Any]] = []

    if prev_fen and last_move_uci and prev_info:
        try:
            prev_board = chess.Board(prev_fen)
            last_move = chess.Move.from_uci(last_move_uci)
            alternative_moves = extract_top_moves(prev_info, prev_board)
            classification, eval_override = _classify_last_move(
                prev_board, last_move, prev_info, info
            )
            if eval_override is not None:
                eval_score, eval_mate = eval_override
        except (ValueError, IndexError, KeyError) as e:
            logger.warning("Could not classify %s from %s: %s", last_move_uci, prev_fen, e)
            classification = {"error": str(e)}

    outcome = board.outcome() if board.is_game_over() else None

    return {
        "fen": fen,
        "eval": eval_score,
        "eval_mate": eval_mate,
        "top_moves": top_moves,
        "alternative_moves": alternative_moves,
        "classification": classification,
        "best_eval_loss": (classification or {}).get("diff_cp", 0),
        "opening": opening,
        "turn": "white" if board.turn else "black",
        "is_game_over": board.is_game_over(),
        "legal_moves": [m.uci() for m in board.legal_moves],
        "result": outcome.result() if outcome else None,
    }
