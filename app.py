"""
Chess Analysis App - Flask Backend.

Serves a chessboard.js frontend and communicates with the Stockfish engine
to analyze chess positions and validate moves.
"""

import atexit
import io
import json
import os
from collections import OrderedDict
from pathlib import Path
import queue
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple, Union

import chess
import chess.engine
import chess.pgn
from flask import Flask, Response, jsonify, render_template, request
from flask.typing import ResponseReturnValue

app = Flask(__name__)

# --- CONFIG ---------------------------------------------------------------

# Using os.getenv to retrieve the environment variable, but wrapping it in pathlib.Path
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


def load_openings_database() -> None:
    """
    Loads the chess openings database from a JSON file into memory.
    Validates sequences and populates OPENINGS_MAP and INVALID_OPENINGS.
    """
    global OPENINGS_MAP, INVALID_OPENINGS
    
    # Safely handle the static folder path
    static_folder: str = app.static_folder if app.static_folder else "static"
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


# Initialize the database on startup
with app.app_context():
    load_openings_database()


# --- ENGINE POOL ----------------------------------------------------------

ENGINE_POOL_SIZE = max(1, (os.cpu_count() or 2) // 2)
_engine_pool: "queue.Queue[chess.engine.SimpleEngine]" = queue.Queue()

def _create_engine() -> chess.engine.SimpleEngine:
    engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH))
    engine.configure({
        "Threads": max(1, (os.cpu_count() or 2) // ENGINE_POOL_SIZE)
    })
    return engine

def init_engine_pool() -> None:
    for _ in range(ENGINE_POOL_SIZE):
        _engine_pool.put(_create_engine())

def get_engine() -> chess.engine.SimpleEngine:
    return _engine_pool.get()

def release_engine(engine: chess.engine.SimpleEngine) -> None:
    _engine_pool.put(engine)

@atexit.register
def _close_engine_pool() -> None:
    while not _engine_pool.empty():
        try:
            eng = _engine_pool.get_nowait()
            eng.quit()
        except Exception:
            pass


# init pool at startup
with app.app_context():
    init_engine_pool()


# --- MOVE CLASSIFICATION --------------------------------------------------

def classify_move(score_diff: float, is_sacrifice: bool = False) -> Tuple[str, str, str]:
    """
    Classifies a move based on the engine score difference and sacrifice status.

    Args:
        score_diff (float): Centipawn evaluation drop after the move.
        is_sacrifice (bool, optional): Whether the move is a real sacrifice. Defaults to False.

    Returns:
        Tuple[str, str, str]: The label, symbol, and hex color code for the UI.
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
    """
    Converts an engine PovScore object into a float value representing pawns.

    Args:
        score_obj (chess.engine.PovScore): The score object returned by the engine.
        pov_white (bool, optional): If True, returns score from White's POV. Defaults to True.

    Returns:
        float: The evaluation in pawns.
    """
    if pov_white:
        cp = score_obj.white().score(mate_score=10000)
    else:
        cp = score_obj.relative.score(mate_score=10000)
        
    return cp / 100.0 if cp is not None else 0.0


# --- ROUTES ---------------------------------------------------------------

@app.route("/")
def index() -> str:
    """Renders the main application page."""
    return render_template("index.html")


@app.route("/api/list_openings")
def list_openings() -> Response:
    """Returns the raw openings JSON dataset."""
    static_folder: str = app.static_folder if app.static_folder else "static"
    path: Path = Path(static_folder) / "openings.json"
    
    with path.open("r", encoding="utf-8") as f:
        return jsonify(json.load(f))


def sort_opening_dict(openings: Dict[str, List[str]]) -> OrderedDict[str, List[str]]:
    """
    Sorts the openings dictionary for deterministic querying.

    Args:
        openings (Dict[str, List[str]]): The unordered openings map.

    Returns:
        OrderedDict[str, List[str]]: Openings sorted by sequence length, then alphabetically.
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

SORTED_OPENINGS_MAP: OrderedDict[str, List[str]] = sort_opening_dict(OPENINGS_MAP)


def get_best_opening_name(fen: str) -> str:
    """
    Matches a given FEN string to the most relevant opening name.

    Args:
        fen (str): The FEN string to check.

    Returns:
        str: The matched opening name, or "Custom Position" / "Starting Position".
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


@app.route("/api/analyze", methods=["POST"])
def analyze() -> Response:
    data: Dict[str, Any] = request.get_json(force=True)

    fen: str = data.get("fen", "")
    depth: int = int(data.get("depth", 14))
    prev_fen: Optional[str] = data.get("prev_fen")
    last_move_uci: Optional[str] = data.get("last_move_uci")

    board = chess.Board(fen)
    detected_opening = get_best_opening_name(fen)

    if board.fullmove_number <= 1 and detected_opening.lower() == "Custom Position":
        detected_opening = "Starting Position"

    limit = chess.engine.Limit(depth=depth)

    # --- PARALLEL EXECUTION ---
    def analyze_current():
        engine = get_engine()
        try:
            info = engine.analyse(board, limit, multipv=3)
            return info
        finally:
            release_engine(engine)

    def analyze_prev():
        if not prev_fen:
            return None
        engine = get_engine()
        try:
            prev_board = chess.Board(prev_fen)
            info = engine.analyse(prev_board, limit, multipv=3)
            return info
        finally:
            release_engine(engine)

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_curr = executor.submit(analyze_current)
        future_prev = executor.submit(analyze_prev)

        info_list = future_curr.result()
        prev_info_list = future_prev.result()

    # --- CURRENT POSITION ---
    top_moves = extract_top_moves(info_list, board)
    top = top_moves[0] if top_moves else None

    if top:
        if top.get("mate") is not None:
            eval_score = None
            eval_mate = top["mate"]
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

            best_eval_prev = prev_info_list[0]["score"].relative.score(mate_score=10000)

            actual_eval = None
            if info_list and "score" in info_list[0]:
                actual_eval_raw = info_list[0]["score"].relative.score(mate_score=10000)
                if actual_eval_raw is not None:
                    actual_eval = -actual_eval_raw

            raw_loss = float((best_eval_prev or 0) - (actual_eval or 0))
            diff = max(0.0, raw_loss)

            is_sac = is_real_sacrifice(prev_board, last_move)
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

    return jsonify({
        "fen": fen,
        "eval": eval_score,
        "eval_mate": eval_mate,
        "top_moves": top_moves,
        "alternative_moves": alternative_moves,
        "classification": classification,
        "best_eval_loss": classification["diff_cp"] if classification else 0,
        "opening": detected_opening,
        "turn": "white" if board.turn else "black",
        "is_game_over": board.is_game_over(),
        "legal_moves": [m.uci() for m in board.legal_moves],
        "result": result,
    })


@app.route("/api/legal_moves", methods=["POST"])
def legal_moves() -> Response:
    """
    Performs a quick legality check for a single move.
    Primarily used by chessboard.js during the 'onDrop' event.

    Expected JSON Body:
        fen (str): Current board position.
        from (str): Starting square.
        to (str): Target square.
        promotion (str, optional): Promotion piece type (default: "q").

    Returns:
        Response: JSON payload indicating if the move is legal and the resulting state.
    """
    data: Dict[str, Any] = request.get_json(force=True)
    fen: str = data.get("fen", "")
    from_sq: str = data.get("from", "")
    to_sq: str = data.get("to", "")
    promotion: str = data.get("promotion", "q")

    try:
        board = chess.Board(fen)
    except ValueError:
        return jsonify({
            "legal": False,
            "error": "Invalid FEN"
        })

    move_uci: str = f"{from_sq}{to_sq}"
    try:
        move: chess.Move = chess.Move.from_uci(move_uci)
        if move not in board.legal_moves:
            # Fallback for promotion handling
            move = chess.Move.from_uci(move_uci + promotion)
    except ValueError:
        try:
            move = chess.Move.from_uci(move_uci + promotion)
        except ValueError:
            return jsonify({"legal": False})

    if move not in board.legal_moves:
        return jsonify({"legal": False})

    san: str = board.san(move)
    board.push(move)
    return jsonify({
        "legal": True,
        "san": san,
        "uci": move.uci(),
        "new_fen": board.fen(),
        "is_game_over": board.is_game_over(),
    })

@app.route("/api/load_pgn", methods=["POST"])
def load_pgn() -> ResponseReturnValue:
    """
    Loads and parses a PGN string into individual moves and FEN states.

    Expected JSON Body:
        pgn (str): The raw PGN text.

    Returns:
        ResponseReturnValue: JSON payload with moves, FEN history, and game headers and eventual error code.
    """
    data: Dict[str, Any] = request.get_json(force=True)
    pgn_text: str = data.get("pgn", "").strip()

    if not pgn_text:
        return jsonify({"error": "Empty PGN"}), 400

    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))

        if game is None:
            return jsonify({"error": "Invalid PGN"}), 400

        board = game.board()
        moves = []
        fens = [board.fen()]

        found_moves = False

        for mv in game.mainline_moves():
            found_moves = True

            san = board.san(mv)  # può fallire
            moves.append({
                "uci": mv.uci(),
                "san": san,
            })

            board.push(mv)
            fens.append(board.fen())

        if not found_moves:
            return jsonify({"error": "No valid moves found in PGN"}), 400

        return jsonify({
            "start_fen": game.board().fen(),
            "moves": moves,
            "fens": fens,
            "headers": dict(game.headers),
        })

    except Exception as e:
        return jsonify({
            "error": f"PGN parsing failed: {str(e)}"
        }), 400

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
