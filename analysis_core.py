"""
Shared analysis core: Stockfish engine management, move classification, opening
recognition, and the single-position analysis routine used by both the live
`/api/analyze` endpoint and the Player DB batch ingester.

This module was extracted from `app.py` so the ingestion worker can reuse the
*exact* same engine singleton, cache, and (tricky) move-classification logic
without re-importing `app.py` — importing the `__main__` module would spin up a
second engine. Everything engine/analysis related now lives here; `app.py`
keeps only the Flask routes.
"""

import os
import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import chess
import chess.engine

# --- CONFIG ---------------------------------------------------------------

STOCKFISH_PATH: Path = Path(os.getenv(
    "STOCKFISH_PATH",
    r"windows_stockfish\stockfish-windows-x86-64-avx2.exe"
))

PIECE_VALUES: Dict[int, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0
}

OPENINGS_MAP: Dict[str, List[str]] = {}
INVALID_OPENINGS: Dict[str, List[Dict[str, str]]] = {}
SORTED_OPENINGS_MAP: "OrderedDict[str, List[str]]" = OrderedDict()


# --- OPENINGS -------------------------------------------------------------

def load_openings_database(static_folder: str = "static") -> None:
    """
    Loads the chess openings database from ``<static_folder>/openings.json`` into
    memory. Validates sequences and populates OPENINGS_MAP, INVALID_OPENINGS and
    the derived SORTED_OPENINGS_MAP.
    """
    global OPENINGS_MAP, INVALID_OPENINGS, SORTED_OPENINGS_MAP

    path: Path = Path(static_folder) / "openings.json"

    try:
        with path.open("r", encoding="utf-8") as f:
            data: Dict[str, Union[str, List[str]]] = json.load(f)

        for opening_name, sequences in data.items():
            if isinstance(sequences, str):
                sequences = [sequences]

            for seq in sequences:
                board = chess.Board()
                tokens: List[str] = seq.replace("\n", " ").split()
                san_moves: List[str] = [
                    t for t in tokens
                    if not t.endswith(".") and not t.replace(".", "").isdigit()
                ]

                try:
                    for san in san_moves:
                        board.push_san(san)

                    # Store the first 3 parts of the FEN (pieces, active color, castling)
                    fen_key: str = " ".join(board.fen().split()[:3])

                    if fen_key not in OPENINGS_MAP:
                        OPENINGS_MAP[fen_key] = []

                    if opening_name not in OPENINGS_MAP[fen_key]:
                        OPENINGS_MAP[fen_key].append(opening_name)

                except Exception as e:
                    INVALID_OPENINGS.setdefault(opening_name, []).append({
                        "sequence": seq,
                        "error": str(e)
                    })

        print(f"Loaded openings: {len(OPENINGS_MAP)} positions")
        print(f"Invalid openings: {len(INVALID_OPENINGS)} entries")

        if INVALID_OPENINGS:
            print("\n❌ INVALID OPENINGS DETECTED:")
            for k, v in INVALID_OPENINGS.items():
                print(f"- {k}: {len(v)} error(s)")
                for err in v:
                    print(f"   -> {err['error']}")

    except Exception as e:
        print(f"Error loading openings database: {e}")

    SORTED_OPENINGS_MAP = sort_opening_dict(OPENINGS_MAP)


def sort_opening_dict(openings: Dict[str, List[str]]) -> "OrderedDict[str, List[str]]":
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


def get_best_opening_name(fen: str) -> str:
    """
    Matches a given FEN string to the most relevant opening name, or returns
    "Custom Position" / "Starting Position".
    """
    parts: List[str] = fen.split()
    fen_key_3: str = " ".join(parts[:3])
    fen_key_2: str = " ".join(parts[:2])

    names: List[str] = SORTED_OPENINGS_MAP.get(fen_key_3) or SORTED_OPENINGS_MAP.get(fen_key_2) or []

    if not names:
        return "Custom Position"

    filtered_names: List[str] = [n for n in names if n.lower() != "Starting Position"]

    if not filtered_names:
        return "Starting Position"

    filtered_names.sort()
    return filtered_names[0]


# --- SACRIFICE / CLASSIFICATION -------------------------------------------

def is_real_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    moving_piece = board.piece_at(move.from_square)
    if not moving_piece:
        return False

    my_value = PIECE_VALUES.get(moving_piece.piece_type, 0)
    captured_piece = board.piece_at(move.to_square)
    captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0

    board.push(move)

    if board.is_checkmate():
        board.pop()
        return False

    moved_square = move.to_square
    opponent_color = board.turn
    my_color = not opponent_color

    legal_enemy_attackers = []

    for attacker_sq in board.attackers(opponent_color, moved_square):
        test_move = chess.Move(attacker_sq, moved_square)
        if test_move in board.legal_moves:
            legal_enemy_attackers.append(attacker_sq)

    attacked_legally = len(legal_enemy_attackers) > 0
    defended_by_me = board.is_attacked_by(my_color, moved_square)

    result = False

    if attacked_legally and my_value > captured_value:
        if not defended_by_me:
            result = True
        else:
            cheapest_attacker = min(
                PIECE_VALUES[board.piece_at(sq).piece_type]  # type: ignore
                for sq in legal_enemy_attackers
                if board.piece_at(sq)
            )
            if cheapest_attacker < my_value:
                result = True

    board.pop()
    return result


def classify_move(score_diff: float, is_sacrifice: bool = False) -> Tuple[str, str, str]:
    """
    Classifies a move based on the engine score difference and sacrifice status.
    Returns (label, symbol, hex color).
    """
    if is_sacrifice and score_diff < 20:
        return "Brilliant", "!!", "#15a2b8"
    if score_diff <= 5:
        return "Best", "★", "#26bbff"
    if score_diff < 30:
        return "Excellent", "++", "#96bc4b"
    if score_diff < 80:
        return "Good", "+", "#96bc4b"
    if score_diff < 150:
        return "Inaccuracy", "?!", "#f0c15c"
    if score_diff < 300:
        return "Mistake", "?", "#e6912c"
    return "Blunder", "??", "#b33430"


def score_to_float(score_obj: chess.engine.PovScore, pov_white: bool = True) -> float:
    """Converts an engine PovScore into a float value representing pawns."""
    if pov_white:
        cp = score_obj.white().score(mate_score=10000)
    else:
        cp = score_obj.relative.score(mate_score=10000)

    return cp / 100.0 if cp is not None else 0.0


def extract_top_moves(info_list: List[Any], board: chess.Board) -> List[Dict[str, Any]]:
    moves: List[Dict[str, Any]] = []
    for entry in info_list:
        if "pv" not in entry or not entry["pv"]:
            continue

        move: chess.Move = entry["pv"][0]
        score: chess.engine.Score = entry["score"].white()

        uci_str = move.uci()

        pv_moves = entry.get("pv", [])
        continuation_san = []
        temp_board = board.copy()
        for pv_move in pv_moves[:10]:
            continuation_san.append(temp_board.san(pv_move))
            temp_board.push(pv_move)

        cp = 0.0
        if score.is_mate():
            mate_moves = score.mate()
            moves.append({
                "uci": uci_str,
                "san": board.san(move),
                "from": uci_str[:2],
                "to": uci_str[2:4],
                "score": None,
                "mate": mate_moves,
                "continuation": " ".join(continuation_san)
            })
            continue
        else:
            engine_score = score.score()
            if engine_score is not None:
                cp = engine_score / 100

        moves.append({
            "uci": uci_str,
            "san": board.san(move),
            "from": uci_str[:2],
            "to": uci_str[2:4],
            "score": cp,
            "mate": None,
            "continuation": " ".join(continuation_san)
        })
    return moves


# --- SINGLE ENGINE + ANALYSIS CACHE --------------------------------------
#
# One engine instance runs sequentially. The result of analysing position N is
# stored in _last_analysis so that when the caller asks for position N+1
# (passing prev_fen == FEN of N) we can skip re-analysing the previous position
# entirely and reuse the cached data.
#
# The lock makes it safe to share the single engine between Flask request
# threads and the Player DB background ingestion worker.

_engine: Optional[chess.engine.SimpleEngine] = None
_engine_lock = threading.Lock()
_last_analysis: Dict[str, Any] = {}   # keys: fen, depth, strength_key, info

# Global cache for position analysis:
# (normalized_fen, depth, strength_key) -> info_list (List[Any])
_analysis_cache: Dict[Tuple[str, int, str], List[Any]] = {}
MAX_CACHE_SIZE = 50000


def _normalize_fen(fen: str) -> str:
    """
    Returns the first 4 fields of the FEN (pieces placement, active color,
    castling rights, and en passant target square) to match identical positions
    regardless of move counters (halfmove and fullmove numbers).
    """
    return " ".join(fen.split()[:4])


def _strength_key(engine_elo: Optional[int], skill_level: Optional[int]) -> str:
    """Stable cache key for engine-strength settings."""
    if engine_elo is not None:
        return f"elo:{engine_elo}"
    if skill_level is not None:
        return f"skill:{skill_level}"
    return "full"


def _add_to_cache(
    fen: str,
    depth: int,
    strength_key: str,
    info_list: List[Any],
) -> None:
    norm_fen = _normalize_fen(fen)
    if len(_analysis_cache) >= MAX_CACHE_SIZE:
        # Remove the oldest cached item (FIFO eviction)
        first_key = next(iter(_analysis_cache))
        _analysis_cache.pop(first_key, None)
    _analysis_cache[(norm_fen, depth, strength_key)] = info_list


def _option_bounds(engine: chess.engine.SimpleEngine, name: str) -> Tuple[Optional[int], Optional[int]]:
    option = engine.options.get(name)
    if option is None:
        return None, None
    return getattr(option, "min", None), getattr(option, "max", None)


def _clamp_optional(value: int, low: Optional[int], high: Optional[int]) -> int:
    if low is not None:
        value = max(low, value)
    if high is not None:
        value = min(high, value)
    return value


def _apply_engine_strength(
    engine: chess.engine.SimpleEngine,
    engine_elo: Optional[int],
    skill_level: Optional[int],
) -> None:
    """
    Configures Stockfish strength for the next analysis call. For normal app
    analysis both values are None, so the engine is restored to full strength.
    """
    opts: Dict[str, Any] = {}

    if engine_elo is not None and "UCI_LimitStrength" in engine.options and "UCI_Elo" in engine.options:
        low, high = _option_bounds(engine, "UCI_Elo")
        opts["UCI_LimitStrength"] = True
        opts["UCI_Elo"] = _clamp_optional(engine_elo, low, high)
        if "Skill Level" in engine.options:
            skill_low, skill_high = _option_bounds(engine, "Skill Level")
            opts["Skill Level"] = _clamp_optional(20, skill_low, skill_high)
    else:
        if "UCI_LimitStrength" in engine.options:
            opts["UCI_LimitStrength"] = False

        if "Skill Level" in engine.options:
            low, high = _option_bounds(engine, "Skill Level")
            full_skill = _clamp_optional(20, low, high)
            requested_skill = full_skill if skill_level is None else skill_level
            opts["Skill Level"] = _clamp_optional(requested_skill, low, high)

    if opts:
        engine.configure(opts)


def _create_engine() -> chess.engine.SimpleEngine:
    engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH))

    total_ram_mb = 8192
    hash_mb = max(16, total_ram_mb // 16)

    engine.configure({
        "Threads": max(1, (os.cpu_count() or 2) - 1),
        "Hash": hash_mb
    })

    print(f"Stockfish Hash: {hash_mb} MB")

    return engine


def init_engine() -> None:
    global _engine
    _engine = _create_engine()


def get_engine() -> chess.engine.SimpleEngine:
    """Returns the single shared engine instance (caller must hold _engine_lock)."""
    global _engine
    if _engine is None:
        _engine = _create_engine()
    return _engine


def close_engine() -> None:
    global _engine
    if _engine is not None:
        try:
            _engine.quit()
        except Exception:
            pass
        _engine = None


# --- SINGLE-POSITION ANALYSIS ---------------------------------------------

def analyze_move(
    fen: str,
    prev_fen: Optional[str] = None,
    last_move_uci: Optional[str] = None,
    depth: int = 14,
    engine_elo: Optional[int] = None,
    skill_level: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Analyses ``fen`` at ``depth`` and, if ``prev_fen`` + ``last_move_uci`` are
    supplied, classifies the move that led to ``fen`` (Brilliant → Blunder,
    cpLoss, mate handling). Returns the same dict shape the ``/api/analyze``
    endpoint serialises.

    This is the single source of truth for move analysis: both the live endpoint
    and the Player DB batch ingester call it under the shared engine lock.
    """
    strength_key = _strength_key(engine_elo, skill_level)

    board = chess.Board(fen)
    detected_opening = get_best_opening_name(fen)

    if board.fullmove_number <= 1 and detected_opening.lower() == "Custom Position":
        detected_opening = "Starting Position"

    limit = chess.engine.Limit(depth=depth)

    # --- SINGLE ENGINE, SEQUENTIAL + CACHE ---
    with _engine_lock:
        engine = get_engine()
        _apply_engine_strength(engine, engine_elo, skill_level)

        # Resolve previous-position analysis from cache or fresh engine call.
        prev_info_list: Optional[List[Any]] = None
        if prev_fen:
            norm_prev_fen = _normalize_fen(prev_fen)
            # 1. Check in our global cache
            if (norm_prev_fen, depth, strength_key) in _analysis_cache:
                prev_info_list = _analysis_cache[(norm_prev_fen, depth, strength_key)]
            # 2. Check in _last_analysis (legacy fallback, or if it has higher depth)
            elif (
                _last_analysis.get("fen") == prev_fen
                and _last_analysis.get("depth", 0) >= depth
                and _last_analysis.get("strength_key") == strength_key
            ):
                prev_info_list = _last_analysis["info"]
            # 3. Otherwise, run the engine
            else:
                prev_board = chess.Board(prev_fen)
                prev_info_list = engine.analyse(prev_board, limit, multipv=3)
                _add_to_cache(prev_fen, depth, strength_key, prev_info_list)

        # Analyse current position.
        info_list: Optional[List[Any]] = None
        norm_fen = _normalize_fen(fen)
        # 1. Check in our global cache
        if (norm_fen, depth, strength_key) in _analysis_cache:
            info_list = _analysis_cache[(norm_fen, depth, strength_key)]
        # 2. Otherwise, run the engine
        else:
            info_list = engine.analyse(board, limit, multipv=3)
            _add_to_cache(fen, depth, strength_key, info_list)

    # Cache the current analysis for the next request.
    _last_analysis.clear()
    _last_analysis.update({
        "fen": fen,
        "depth": depth,
        "strength_key": strength_key,
        "info": info_list,
    })

    # --- CURRENT POSITION ---
    top_moves = extract_top_moves(info_list, board)
    top = top_moves[0] if top_moves else None

    if top:
        if top.get("mate") is not None:
            mate_val = top["mate"]
            eval_score = 100.0 if mate_val > 0 else -100.0
            eval_mate = mate_val
        else:
            eval_score = top["score"]
            eval_mate = None
    else:
        eval_score = 0.0
        eval_mate = None

    classification = None
    alternative_moves = []

    # --- PREVIOUS POSITION ---
    if prev_fen and last_move_uci and prev_info_list:
        try:
            prev_board = chess.Board(prev_fen)
            last_move = chess.Move.from_uci(last_move_uci)

            alternative_moves = extract_top_moves(prev_info_list, prev_board)

            prev_best_score = prev_info_list[0]["score"]
            curr_score = info_list[0]["score"] if info_list else None

            # If there is a mate line / if the current move is part of the mate line
            post_board = prev_board.copy(stack=False)
            post_board.push(last_move)
            played_is_mate = post_board.is_checkmate()

            # If prev move was in the mate line
            prev_best_is_mate = prev_best_score.relative.is_mate()

            # If current move is still a mate line
            curr_is_mate = (curr_score is not None and curr_score.relative.is_mate())

            played_san = prev_board.san(last_move)

            # Checkmate is always the best move
            if played_is_mate:
                label, symbol, color = "Best", "★", "#26bbff"
                diff = 0.0

                eval_mate = 1 if prev_board.turn == chess.WHITE else -1
                eval_score = 100.0 if eval_mate > 0 else -100.0

            # If SAN explicitly ends in mate (#)
            elif prev_best_is_mate and played_san.endswith("#"):
                mate_val = prev_best_score.white().mate()

                eval_mate = mate_val
                eval_score = 100.0 if (mate_val or 0) > 0 else -100.0

            # If current move is a mate line but longer it will never be error or blunder
            elif curr_is_mate and prev_best_is_mate:
                prev_mate_dist = abs(prev_best_score.relative.mate() or 0)
                curr_mate_dist = abs(curr_score.relative.mate() or 0)  # type: ignore
                mate_delay = max(0, curr_mate_dist - prev_mate_dist)
                diff = min(mate_delay * 30.0, 149.0)

                is_sac = is_real_sacrifice(prev_board, last_move)
                label, symbol, color = classify_move(diff, is_sac)
            else:
                # Normal line
                MATE_CP = 10000
                best_eval_prev = prev_best_score.relative.score(mate_score=MATE_CP) or 0
                if curr_score is not None:
                    actual_eval_raw = curr_score.relative.score(mate_score=MATE_CP)
                    actual_eval = -(actual_eval_raw or 0)
                else:
                    actual_eval = 0

                raw_loss = float(best_eval_prev - actual_eval)
                diff = max(0.0, raw_loss)
                is_sac = is_real_sacrifice(prev_board, last_move)

                num_legal_moves = len(list(prev_board.legal_moves))
                if num_legal_moves == 1:
                    label, symbol, color = "Best", "★", "#26bbff"
                    diff = 0.0
                elif diff >= 200 and best_eval_prev >= 150 and actual_eval >= -150:
                    label, symbol, color = "Miss", "Ø", "#ff7769"
                else:
                    label, symbol, color = classify_move(diff, is_sac)

            classification = {
                "label": label,
                "symbol": symbol,
                "color": color,
                "diff_cp": diff,
            }

        except Exception as e:
            classification = {"error": str(e)}

    result = None

    if board.is_game_over():
        outcome = board.outcome()
        if outcome:
            result = outcome.result()  # "1-0", "0-1", "1/2-1/2"

    return {
        "fen": fen,
        "eval": eval_score,
        "eval_mate": eval_mate,
        "top_moves": top_moves,
        "alternative_moves": alternative_moves,
        "classification": classification,
        "best_eval_loss": classification["diff_cp"] if classification and "diff_cp" in classification else 0,
        "opening": detected_opening,
        "turn": "white" if board.turn else "black",
        "is_game_over": board.is_game_over(),
        "legal_moves": [m.uci() for m in board.legal_moves],
        "result": result,
    }
